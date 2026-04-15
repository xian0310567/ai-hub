// src-tauri/src/config.rs
//
// Two persisted configs live side-by-side:
//
// 1. `launcher.json` — launcher-owned state (onboarded flag, cached paths,
//    wizard answers). Read/written by this module.
//
// 2. `openclaw.json` — fed to the gateway child process via
//    `OPENCLAW_CONFIG_PATH`. The launcher only *writes* this file; the gateway
//    owns the schema and we use `serde_json::Value` so we never have to mirror
//    OpenClaw's full config shape.
//
// The wizard collects answers and calls `LauncherConfig::apply_wizard_answers`
// to update both files atomically (from the wizard's point of view).

use std::collections::BTreeMap;
use std::fs;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LauncherConfig {
    /// True once the wizard has completed end-to-end successfully.
    #[serde(default)]
    pub onboarded: bool,

    /// Absolute path to the `claude.cmd`/`claude` binary we should prefer.
    /// Populated by the wizard; falls back to PATH lookup if empty.
    #[serde(default)]
    pub claude_cli_path: Option<String>,

    /// Workspace directory the default OpenClaw agent should point at.
    #[serde(default)]
    pub default_workspace: Option<String>,

    /// Whether the gateway should be started automatically on launch.
    #[serde(default = "default_true")]
    pub autostart_gateway: bool,

    /// Last known gateway port (for quick dashboard open without probing).
    #[serde(default = "default_gateway_port")]
    pub gateway_port: u16,

    /// Cache of the last telegram account id used. The actual bot token never
    /// touches this file: we hand it straight to `openclaw.json`.
    #[serde(default)]
    pub telegram_account_id: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_gateway_port() -> u16 {
    18789
}

impl LauncherConfig {
    pub fn load_or_default() -> Self {
        let Ok(path) = paths::launcher_config_file() else {
            return LauncherConfig::default();
        };
        let Ok(bytes) = fs::read(&path) else {
            return LauncherConfig::default();
        };
        match serde_json::from_slice(&bytes) {
            Ok(cfg) => cfg,
            Err(err) => {
                tracing::warn!(?err, "launcher.json is malformed, using defaults");
                LauncherConfig::default()
            }
        }
    }

    pub fn save(&self) -> Result<()> {
        let path = paths::launcher_config_file()?;
        if let Some(parent) = path.parent() {
            paths::ensure_dir(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(self).context("serialize launcher.json")?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, bytes).context("write launcher.json.tmp")?;
        fs::rename(&tmp, &path).context("atomic rename launcher.json")?;
        Ok(())
    }
}

/// Full set of wizard answers forwarded from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WizardAnswers {
    pub claude_cli_path: String,
    pub workspace_dir: String,
    pub telegram_bot_token: String,
    pub telegram_account_id: String,
    #[serde(default = "default_gateway_port")]
    pub gateway_port: u16,
    #[serde(default)]
    pub default_model: Option<String>,
}

impl WizardAnswers {
    pub fn validate(&self) -> Result<()> {
        if self.claude_cli_path.trim().is_empty() {
            anyhow::bail!("claude_cli_path must not be empty");
        }
        if self.workspace_dir.trim().is_empty() {
            anyhow::bail!("workspace_dir must not be empty");
        }
        if self.telegram_bot_token.trim().is_empty() {
            anyhow::bail!("telegram_bot_token must not be empty");
        }
        if self.telegram_account_id.trim().is_empty() {
            anyhow::bail!("telegram_account_id must not be empty");
        }
        Ok(())
    }
}

/// Minimal typed view of the OpenClaw config surface this launcher writes.
///
/// We deliberately keep this narrow: the OpenClaw config is owned upstream
/// and includes many keys this launcher never touches. We read the existing
/// file as a raw `serde_json::Value`, patch the handful of paths the wizard
/// knows about, and write it back. Anything the user added by hand survives.
pub fn apply_wizard_answers(answers: &WizardAnswers) -> Result<()> {
    answers.validate()?;

    let cfg_path = paths::openclaw_config_file()?;
    if let Some(parent) = cfg_path.parent() {
        paths::ensure_dir(parent)?;
    }

    let mut root: serde_json::Value = if cfg_path.exists() {
        let raw = fs::read(&cfg_path).context("read existing openclaw.json")?;
        serde_json::from_slice(&raw).unwrap_or_else(|err| {
            tracing::warn!(?err, "existing openclaw.json unparseable, rewriting");
            serde_json::json!({})
        })
    } else {
        serde_json::json!({})
    };

    patch_openclaw_config(&mut root, answers);

    let tmp = cfg_path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&root).context("serialize openclaw.json")?;
    fs::write(&tmp, bytes).context("write openclaw.json.tmp")?;
    fs::rename(&tmp, &cfg_path).context("atomic rename openclaw.json")?;

    Ok(())
}

/// Patch logic split out so it's directly unit-testable.
pub fn patch_openclaw_config(root: &mut serde_json::Value, answers: &WizardAnswers) {
    use serde_json::json;

    let obj = ensure_object(root);

    // agents.defaults.cliBackends.claude-cli.command
    let agents = ensure_object(obj.entry("agents").or_insert_with(|| json!({})));
    let defaults = ensure_object(agents.entry("defaults").or_insert_with(|| json!({})));

    let cli_backends = ensure_object(
        defaults.entry("cliBackends").or_insert_with(|| json!({})),
    );
    let claude_cli = ensure_object(
        cli_backends.entry("claude-cli").or_insert_with(|| json!({})),
    );
    claude_cli.insert("command".into(), json!(answers.claude_cli_path));

    // agents.defaults.model.primary
    let model = ensure_object(defaults.entry("model").or_insert_with(|| {
        json!({ "primary": "claude-cli/claude-sonnet-4-6", "fallbacks": [] })
    }));
    if let Some(requested) = &answers.default_model {
        if !requested.trim().is_empty() {
            model.insert("primary".into(), json!(requested));
        }
    }

    // agents.defaults.workspace
    defaults.insert("workspace".into(), json!(answers.workspace_dir));

    // gateway.port + gateway.bind
    let gateway = ensure_object(obj.entry("gateway").or_insert_with(|| json!({})));
    gateway.insert("mode".into(), json!("local"));
    gateway.insert("port".into(), json!(answers.gateway_port));
    gateway.entry("bind").or_insert_with(|| json!("loopback"));
    let control_ui = ensure_object(gateway.entry("controlUi").or_insert_with(|| json!({})));
    control_ui.entry("enabled").or_insert_with(|| json!(true));

    // channels.telegram.accounts.<id>.token
    let channels = ensure_object(obj.entry("channels").or_insert_with(|| json!({})));
    let telegram = ensure_object(channels.entry("telegram").or_insert_with(|| json!({})));
    let accounts = ensure_object(telegram.entry("accounts").or_insert_with(|| json!({})));
    let account = ensure_object(
        accounts
            .entry(answers.telegram_account_id.clone())
            .or_insert_with(|| json!({})),
    );
    account.insert("token".into(), json!(answers.telegram_bot_token));
}

fn ensure_object(value: &mut serde_json::Value) -> &mut serde_json::Map<String, serde_json::Value> {
    if !value.is_object() {
        *value = serde_json::Value::Object(serde_json::Map::new());
    }
    value.as_object_mut().expect("ensured object above")
}

/// Read-only helper for the status IPC command — returns a shallow summary of
/// `openclaw.json` without exposing secrets.
pub fn summarize_openclaw_config() -> Result<BTreeMap<String, String>> {
    let cfg_path = paths::openclaw_config_file()?;
    let mut summary = BTreeMap::new();
    summary.insert("configPath".into(), cfg_path.display().to_string());
    summary.insert("exists".into(), cfg_path.exists().to_string());
    if cfg_path.exists() {
        let raw = fs::read(&cfg_path).unwrap_or_default();
        if let Ok(root) = serde_json::from_slice::<serde_json::Value>(&raw) {
            if let Some(port) = root
                .get("gateway")
                .and_then(|g| g.get("port"))
                .and_then(|p| p.as_u64())
            {
                summary.insert("gatewayPort".into(), port.to_string());
            }
            if let Some(model) = root
                .get("agents")
                .and_then(|a| a.get("defaults"))
                .and_then(|d| d.get("model"))
                .and_then(|m| m.get("primary"))
                .and_then(|p| p.as_str())
            {
                summary.insert("primaryModel".into(), model.to_string());
            }
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_answers() -> WizardAnswers {
        WizardAnswers {
            claude_cli_path: "C\\:/bin/claude.cmd".into(),
            workspace_dir: "C\\:/work/agent-a".into(),
            telegram_bot_token: "123:TOKEN".into(),
            telegram_account_id: "default".into(),
            gateway_port: 18789,
            default_model: Some("claude-cli/claude-sonnet-4-6".into()),
        }
    }

    #[test]
    fn patch_creates_expected_shape_on_empty_config() {
        let mut root = serde_json::json!({});
        patch_openclaw_config(&mut root, &sample_answers());

        assert_eq!(
            root["agents"]["defaults"]["cliBackends"]["claude-cli"]["command"],
            "C\\:/bin/claude.cmd"
        );
        assert_eq!(
            root["agents"]["defaults"]["model"]["primary"],
            "claude-cli/claude-sonnet-4-6"
        );
        assert_eq!(root["agents"]["defaults"]["workspace"], "C\\:/work/agent-a");
        assert_eq!(root["gateway"]["port"], 18789);
        assert_eq!(root["gateway"]["mode"], "local");
        assert_eq!(root["gateway"]["bind"], "loopback");
        assert_eq!(
            root["channels"]["telegram"]["accounts"]["default"]["token"],
            "123:TOKEN"
        );
    }

    #[test]
    fn patch_preserves_unrelated_fields() {
        let mut root = serde_json::json!({
            "agents": { "list": [ { "id": "main", "workspace": "/u/existing" } ] },
            "channels": { "discord": { "accounts": { "main": { "token": "keep-me" } } } },
            "gateway": { "bind": "lan" }
        });
        patch_openclaw_config(&mut root, &sample_answers());

        assert_eq!(root["agents"]["list"][0]["id"], "main");
        assert_eq!(
            root["channels"]["discord"]["accounts"]["main"]["token"],
            "keep-me"
        );
        // Existing bind=lan must not be overwritten by the entry()-or-default path.
        assert_eq!(root["gateway"]["bind"], "lan");
    }

    #[test]
    fn validate_rejects_empty_required_fields() {
        let mut a = sample_answers();
        a.claude_cli_path = "  ".into();
        assert!(a.validate().is_err());
    }
}
