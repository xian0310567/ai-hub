// src-tauri/src/commands.rs
//
// Tauri IPC commands invoked by the wizard/dashboard frontend.
//
// All commands return `Result<T, String>` so the wizard can render meaningful
// error toasts instead of dealing with serialized `anyhow::Error` chains.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt as AutostartManager;

use crate::bootstrap;
use crate::config::{self, LauncherConfig, WizardAnswers};
use crate::paths;
use crate::supervisor::StatusSnapshot;
use crate::LauncherState;

fn to_string_err<E: std::fmt::Display>(err: E) -> String {
    format!("{err:#}")
}

#[tauri::command]
pub async fn get_status(
    state: State<'_, LauncherState>,
) -> Result<StatusSnapshot, String> {
    Ok(state.supervisor.snapshot().await)
}

#[tauri::command]
pub async fn start_gateway(state: State<'_, LauncherState>) -> Result<(), String> {
    state.supervisor.resume();
    Ok(())
}

#[tauri::command]
pub async fn stop_gateway(state: State<'_, LauncherState>) -> Result<(), String> {
    state.supervisor.pause();
    Ok(())
}

#[tauri::command]
pub async fn restart_gateway(state: State<'_, LauncherState>) -> Result<(), String> {
    state.supervisor.pause();
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    state.supervisor.resume();
    Ok(())
}

#[tauri::command]
pub fn open_dashboard(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("dashboard") {
        win.show().map_err(to_string_err)?;
        win.set_focus().map_err(to_string_err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_logs_dir(app: AppHandle) -> Result<(), String> {
    let dir = paths::logs_dir().map_err(to_string_err)?;
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(dir.display().to_string(), None)
        .map_err(to_string_err)
}

#[tauri::command]
pub async fn run_bootstrap(app: AppHandle) -> Result<(), String> {
    bootstrap::run_bootstrap(&app).await.map_err(to_string_err)
}

#[derive(Debug, Serialize)]
pub struct ClaudeBinaryReport {
    pub path: String,
    pub exists: bool,
    pub on_path: bool,
    pub path_on_path: Option<String>,
}

#[tauri::command]
pub fn check_claude_binary(path: Option<String>) -> Result<ClaudeBinaryReport, String> {
    // Resolution order matches what we show the user in the wizard:
    //   1. Whatever path the user typed (if non-empty).
    //   2. The bundled claude.cmd under `%LOCALAPPDATA%\StandaloneOpenClaw\deps\`,
    //      which `bootstrap.rs` installs via `npm install @anthropic-ai/claude-code`.
    //   3. `claude` on PATH.
    let bundled = paths::bundled_claude_cli()
        .ok()
        .filter(|p| p.exists());

    let candidate = path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| bundled.clone())
        .or_else(|| which_binary("claude"));

    let path_on_path = which_binary("claude").map(|p| p.display().to_string());

    let Some(candidate) = candidate else {
        return Ok(ClaudeBinaryReport {
            path: String::new(),
            exists: false,
            on_path: path_on_path.is_some(),
            path_on_path,
        });
    };

    Ok(ClaudeBinaryReport {
        exists: candidate.exists(),
        on_path: path_on_path.is_some(),
        path: candidate.display().to_string(),
        path_on_path,
    })
}

/// Minimal `which` equivalent — avoids pulling in the `which` crate just for
/// one PATH lookup.
fn which_binary(name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    let exe_names: &[String] = &if cfg!(target_os = "windows") {
        vec![
            format!("{name}.cmd"),
            format!("{name}.exe"),
            format!("{name}.bat"),
        ]
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&path_env) {
        for candidate in exe_names {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

#[derive(Debug, Serialize)]
pub struct ClaudeAuthReport {
    /// Absolute path to `~/.claude/.credentials.json` (regardless of existence).
    pub credentials_path: String,
    pub credentials_exist: bool,
    /// Size in bytes; non-zero implies Claude wrote real credentials into the file.
    pub credentials_size: u64,
}

#[tauri::command]
pub fn check_claude_auth() -> Result<ClaudeAuthReport, String> {
    // Claude Code stores the OAuth result at ~/.claude/.credentials.json.
    // We never read the file's contents — existence + non-zero size is the
    // signal the wizard needs to decide whether to proceed.
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home directory".to_string())?;
    let credentials = home.join(".claude").join(".credentials.json");
    let (exists, size) = match std::fs::metadata(&credentials) {
        Ok(meta) => (meta.is_file(), meta.len()),
        Err(_) => (false, 0),
    };
    Ok(ClaudeAuthReport {
        credentials_path: credentials.display().to_string(),
        credentials_exist: exists,
        credentials_size: size,
    })
}

#[tauri::command]
pub fn launch_claude_login(app: AppHandle, claude_path: Option<String>) -> Result<(), String> {
    // Prefer the bundled claude.cmd (it matches what OpenClaw will call at
    // runtime). Fall back to whatever the wizard currently has, then PATH.
    let explicit = claude_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);
    let bundled = paths::bundled_claude_cli().ok().filter(|p| p.exists());
    let on_path = which_binary("claude");
    let claude = explicit
        .or(bundled)
        .or(on_path)
        .ok_or_else(|| "Claude CLI binary not found".to_string())?;

    use tauri_plugin_shell::ShellExt;
    let shell = app.shell();

    #[cfg(target_os = "windows")]
    {
        // Open a new console so the user can watch the OAuth handoff and see
        // any error output. `cmd /c start cmd /k <claude> auth login`
        // spawns cmd.exe, asks it to keep the window open after the command
        // exits, and runs claude inside.
        let claude_str = claude.display().to_string();
        shell
            .command("cmd")
            .args([
                "/c", "start", "cmd", "/k", &claude_str, "auth", "login",
            ])
            .spawn()
            .map_err(to_string_err)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        shell
            .command(claude.display().to_string())
            .args(["auth", "login"])
            .spawn()
            .map_err(to_string_err)?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct SaveWizardConfigArgs {
    pub answers: WizardAnswers,
    #[serde(default = "default_true")]
    pub enable_autostart: bool,
}

fn default_true() -> bool {
    true
}

#[tauri::command]
pub async fn save_wizard_config(
    app: AppHandle,
    state: State<'_, LauncherState>,
    args: SaveWizardConfigArgs,
) -> Result<(), String> {
    args.answers.validate().map_err(to_string_err)?;
    config::apply_wizard_answers(&args.answers).map_err(to_string_err)?;

    {
        let mut cfg = state.config.write().await;
        cfg.onboarded = true;
        cfg.claude_cli_path = Some(args.answers.claude_cli_path.clone());
        cfg.default_workspace = Some(args.answers.workspace_dir.clone());
        cfg.telegram_account_id = Some(args.answers.telegram_account_id.clone());
        cfg.gateway_port = args.answers.gateway_port;
        cfg.autostart_gateway = true;
        cfg.save().map_err(to_string_err)?;
    }

    if args.enable_autostart {
        app.autolaunch()
            .enable()
            .map_err(to_string_err)?;
    }

    // Kick the supervisor so it picks up the new config.
    state.supervisor.resume();
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct WizardDefaults {
    pub config: LauncherConfig,
    pub summary: BTreeMap<String, String>,
    pub detected_claude: ClaudeBinaryReport,
    pub suggested_workspace: String,
}

#[tauri::command]
pub async fn get_wizard_defaults(
    state: State<'_, LauncherState>,
) -> Result<WizardDefaults, String> {
    let config = state.config.read().await.clone();
    let summary = config::summarize_openclaw_config().map_err(to_string_err)?;
    let detected_claude = check_claude_binary(config.claude_cli_path.clone())?;
    let suggested_workspace = config
        .default_workspace
        .clone()
        .or_else(|| {
            dirs::home_dir().map(|h| {
                h.join("OpenClaw")
                    .join("workspace")
                    .display()
                    .to_string()
            })
        })
        .unwrap_or_else(|| "C:/OpenClaw/workspace".into());

    Ok(WizardDefaults {
        config,
        summary,
        detected_claude,
        suggested_workspace,
    })
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enable: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enable {
        mgr.enable().map_err(to_string_err)
    } else {
        mgr.disable().map_err(to_string_err)
    }
}

#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(to_string_err)
}

#[tauri::command]
pub fn quit_launcher(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}
