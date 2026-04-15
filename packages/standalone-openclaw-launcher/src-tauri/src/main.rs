// src-tauri/src/main.rs
//
// Launcher entry point. On Windows the `windows_subsystem = "windows"` attribute
// prevents a console window from popping up when the launcher is started from
// the Startup folder shortcut.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

fn main() {
    standalone_openclaw_launcher_lib::run();
}
