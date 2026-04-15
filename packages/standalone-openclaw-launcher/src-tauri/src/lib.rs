// src-tauri/src/lib.rs
//
// Tauri app bootstrap. Wires plugins, tray, windows, IPC commands, and the
// gateway supervisor. The launcher is split into small focused modules:
//
// - `paths`      : resolves `%LOCALAPPDATA%\StandaloneOpenClaw\*` layout.
// - `bootstrap`  : first-run extraction of portable Node + `npm install`.
// - `config`     : reads/writes `~/.openclaw/openclaw.json` for the user.
// - `supervisor` : spawns and monitors the gateway child process.
// - `tray`       : system tray icon, menu, status color.
// - `commands`   : IPC commands invoked from the wizard webview.

mod bootstrap;
mod commands;
mod config;
mod paths;
mod supervisor;
mod tray;

use std::sync::Arc;

use tauri::{Manager, RunEvent};
use tauri_plugin_autostart::MacosLauncher;
use tokio::sync::RwLock;

use crate::supervisor::Supervisor;

/// Shared launcher state, cloned into every IPC command and tray handler.
pub struct LauncherState {
    pub supervisor: Arc<Supervisor>,
    pub config: Arc<RwLock<config::LauncherConfig>>,
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tauri=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let launcher_config = Arc::new(RwLock::new(config::LauncherConfig::load_or_default()));
    let supervisor = Arc::new(Supervisor::new());

    let state = LauncherState {
        supervisor: supervisor.clone(),
        config: launcher_config.clone(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::start_gateway,
            commands::stop_gateway,
            commands::restart_gateway,
            commands::open_dashboard,
            commands::open_logs_dir,
            commands::run_bootstrap,
            commands::check_claude_binary,
            commands::save_wizard_config,
            commands::get_wizard_defaults,
            commands::set_autostart,
            commands::get_autostart,
            commands::quit_launcher,
        ])
        .setup(|app| {
            // Build tray before any async work so the icon shows up immediately.
            tray::build_tray(app.handle())?;

            let handle = app.handle().clone();
            let supervisor_for_task = supervisor.clone();
            let config_for_task = launcher_config.clone();

            // Launch supervisor loop on a background task. It handles:
            //   - first-run bootstrap (portable Node + npm deps) if required
            //   - spawning `node openclaw.mjs gateway run`
            //   - restart-on-crash with exponential backoff
            //   - tray status updates via events
            tauri::async_runtime::spawn(async move {
                if let Err(err) = supervisor_for_task
                    .start(handle.clone(), config_for_task)
                    .await
                {
                    tracing::error!(?err, "supervisor failed to start");
                    tray::set_status(&handle, tray::TrayStatus::Error);
                }
            });

            // Decide which window to show on startup.
            let cfg = launcher_config.blocking_read();
            if cfg.onboarded {
                if let Some(dashboard) = app.get_webview_window("dashboard") {
                    let _ = dashboard.hide();
                }
            } else if let Some(wizard) = app.get_webview_window("wizard") {
                let _ = wizard.show();
                let _ = wizard.set_focus();
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application")
        .run(move |app, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                // Clicking the close button on a window should hide to tray,
                // not terminate the process. The only explicit exit path is
                // the tray "Quit" menu which calls `app.exit(0)` directly.
                api.prevent_exit();
                for label in ["wizard", "dashboard"] {
                    if let Some(w) = app.get_webview_window(label) {
                        let _ = w.hide();
                    }
                }
            }
            RunEvent::Exit => {
                if let Some(state) = app.try_state::<LauncherState>() {
                    // Best-effort child process shutdown on actual exit.
                    let sup = state.supervisor.clone();
                    tauri::async_runtime::block_on(async move {
                        sup.shutdown().await;
                    });
                }
            }
            _ => {}
        });
}
