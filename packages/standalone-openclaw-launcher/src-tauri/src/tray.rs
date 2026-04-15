// src-tauri/src/tray.rs
//
// System tray icon + menu. The tray is always present; the menu exposes the
// handful of actions a user actually needs day-to-day:
//
//   - Open Dashboard   (shows the embedded Control UI webview)
//   - Pause / Resume   (stops/starts the gateway child process)
//   - Open Logs Folder (shells out to the logs dir)
//   - Re-authenticate Claude (spawns `claude auth login` in a new terminal)
//   - Check for Updates
//   - Quit
//
// Tray icon color doubles as the status indicator:
//
//   - Running: green
//   - Warn/Starting/Restarting/Bootstrapping: yellow
//   - Error: red
//   - Idle/Paused/Stopped: grey

use anyhow::Result;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::LauncherState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayStatus {
    Running,
    Warn,
    Error,
    Idle,
}

impl TrayStatus {
    fn resource_name(self) -> &'static str {
        match self {
            TrayStatus::Running => "tray-running.png",
            TrayStatus::Warn => "tray-warn.png",
            TrayStatus::Error => "tray-error.png",
            TrayStatus::Idle => "tray-grey.png",
        }
    }
}

pub fn build_tray(app: &AppHandle) -> Result<()> {
    let open_item = MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)?;
    let pause_item = MenuItem::with_id(app, "pause_resume", "Pause gateway", true, None::<&str>)?;
    let logs_item = MenuItem::with_id(app, "open_logs", "Open Logs Folder", true, None::<&str>)?;
    let wizard_item =
        MenuItem::with_id(app, "open_wizard", "Re-run Setup Wizard", true, None::<&str>)?;
    let reauth_item =
        MenuItem::with_id(app, "reauth_claude", "Re-authenticate Claude", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open_item,
            &pause_item,
            &sep1,
            &logs_item,
            &wizard_item,
            &reauth_item,
            &sep2,
            &quit_item,
        ],
    )?;

    let initial_icon = load_tray_icon(app, TrayStatus::Idle)?;

    TrayIconBuilder::with_id("main")
        .tooltip("Standalone OpenClaw")
        .icon(initial_icon)
        .menu(&menu)
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                open_dashboard_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

pub fn set_status(handle: &AppHandle, status: TrayStatus) {
    let Ok(icon) = load_tray_icon(handle, status) else {
        tracing::warn!(?status, "failed to load tray icon for status");
        return;
    };
    if let Some(tray) = handle.tray_by_id("main") {
        if let Err(err) = tray.set_icon(Some(icon)) {
            tracing::warn!(?err, "failed to set tray icon");
        }
    }
}

fn load_tray_icon(handle: &AppHandle, status: TrayStatus) -> Result<Image<'static>> {
    let name = status.resource_name();
    let resource_path = handle
        .path()
        .resolve(format!("resources/{name}"), tauri::path::BaseDirectory::Resource)?;
    Ok(Image::from_path(resource_path)?)
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open_dashboard" => open_dashboard_window(app),
        "open_wizard" => open_wizard_window(app),
        "pause_resume" => toggle_pause(app),
        "open_logs" => {
            if let Ok(logs) = crate::paths::logs_dir() {
                let _ = tauri_plugin_shell::ShellExt::shell(app)
                    .open(logs.display().to_string(), None);
            }
        }
        "reauth_claude" => spawn_reauth_terminal(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn open_dashboard_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("dashboard") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn open_wizard_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("wizard") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn toggle_pause(app: &AppHandle) {
    let Some(state) = app.try_state::<LauncherState>() else {
        return;
    };
    let sup = state.supervisor.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let snap = sup.snapshot().await;
        use crate::supervisor::GatewayState;
        match snap.state {
            GatewayState::Paused | GatewayState::Stopped => sup.resume(),
            _ => sup.pause(),
        }
        // Echo back a status event so menu labels/tooltips refresh on the
        // frontend; tray menu label itself is not updated dynamically to keep
        // the Tauri v2 Menu API surface minimal.
        let _ = tauri::Emitter::emit(&handle, "launcher://pause-toggled", ());
    });
}

fn spawn_reauth_terminal(app: &AppHandle) {
    // We spawn `cmd.exe /c start cmd /k claude auth login` so the user sees
    // the OAuth prompt in a real console. Claude's auth flow is interactive
    // and opens the browser itself.
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_shell::ShellExt;
        let shell = app.shell();
        let _ = shell
            .command("cmd")
            .args(["/c", "start", "cmd", "/k", "claude", "auth", "login"])
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        use tauri_plugin_shell::ShellExt;
        let _ = app.shell().command("claude").args(["auth", "login"]).spawn();
    }
}
