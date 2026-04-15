// src-tauri/src/paths.rs
//
// Centralizes filesystem layout for the launcher.
//
// On Windows the launcher owns the tree at:
//
//     %LOCALAPPDATA%\StandaloneOpenClaw\
//     ├── runtime\           portable Node + npm (extracted on first run)
//     │   ├── node.exe
//     │   └── npm.cmd
//     ├── deps\              npm prefix for standalone-openclaw + claude-code
//     │   └── node_modules\
//     │       ├── standalone-openclaw\openclaw.mjs
//     │       └── @anthropic-ai\claude-code\bin\claude.cmd
//     ├── config\
//     │   ├── launcher.json      launcher-owned state (onboarded flag, etc)
//     │   └── openclaw.json      OPENCLAW_CONFIG_PATH target for the gateway
//     └── logs\
//         ├── gateway.log
//         └── launcher.log
//
// On non-Windows hosts (mostly for development on Linux/macOS) we fall back
// to `~/.standalone-openclaw-launcher/` so the code still compiles and tests
// still run — the runtime path is Windows-first but not Windows-only.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

pub fn app_root() -> Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let base = dirs::data_local_dir()
            .context("cannot resolve %LOCALAPPDATA%")?;
        Ok(base.join("StandaloneOpenClaw"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let base = dirs::home_dir().context("cannot resolve home dir")?;
        Ok(base.join(".standalone-openclaw-launcher"))
    }
}

pub fn runtime_dir() -> Result<PathBuf> {
    Ok(app_root()?.join("runtime"))
}

pub fn deps_dir() -> Result<PathBuf> {
    Ok(app_root()?.join("deps"))
}

pub fn config_dir() -> Result<PathBuf> {
    Ok(app_root()?.join("config"))
}

pub fn logs_dir() -> Result<PathBuf> {
    Ok(app_root()?.join("logs"))
}

pub fn launcher_config_file() -> Result<PathBuf> {
    Ok(config_dir()?.join("launcher.json"))
}

pub fn openclaw_config_file() -> Result<PathBuf> {
    Ok(config_dir()?.join("openclaw.json"))
}

pub fn node_exe() -> Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        Ok(runtime_dir()?.join("node.exe"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(runtime_dir()?.join("bin").join("node"))
    }
}

pub fn npm_cmd() -> Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        Ok(runtime_dir()?.join("npm.cmd"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(runtime_dir()?.join("bin").join("npm"))
    }
}

pub fn openclaw_entry() -> Result<PathBuf> {
    Ok(deps_dir()?
        .join("node_modules")
        .join("standalone-openclaw")
        .join("openclaw.mjs"))
}

pub fn bundled_claude_cli() -> Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        Ok(deps_dir()?
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("bin")
            .join("claude.cmd"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(deps_dir()?
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("bin")
            .join("claude"))
    }
}

pub fn ensure_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        std::fs::create_dir_all(path)
            .with_context(|| format!("failed to create {}", path.display()))?;
    }
    Ok(())
}

pub fn ensure_layout() -> Result<()> {
    for p in [runtime_dir()?, deps_dir()?, config_dir()?, logs_dir()?] {
        ensure_dir(&p)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_root_is_absolute() {
        let root = app_root().expect("app_root resolves");
        assert!(root.is_absolute(), "app_root must be absolute: {root:?}");
    }

    #[test]
    fn known_children_share_the_root() {
        let root = app_root().unwrap();
        for child in [runtime_dir().unwrap(), deps_dir().unwrap(), logs_dir().unwrap()] {
            assert!(child.starts_with(&root));
        }
    }
}
