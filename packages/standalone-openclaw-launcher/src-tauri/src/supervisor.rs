// src-tauri/src/supervisor.rs
//
// Owns the gateway child process lifecycle. Responsibilities:
//
// 1. Ensure the runtime layout exists (bootstrap step).
// 2. Spawn `node deps\node_modules\standalone-openclaw\openclaw.mjs gateway run`.
// 3. Stream stdout/stderr to `logs\gateway.log`.
// 4. Emit `launcher://status` events so the tray + frontend update.
// 5. Restart on unexpected exit with exponential backoff (capped).
// 6. Cleanly kill on app shutdown or pause.
//
// Cancellation is handled via a `tokio::sync::watch<Signal>` channel rather
// than by stashing the `Child` handle across await points. The loop blocks on
// `tokio::select!(child.wait(), signal.changed())` so pause/shutdown requests
// cleanly tear down the child without sharing owned process handles across
// tasks.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{watch, RwLock};

use crate::bootstrap;
use crate::config::LauncherConfig;
use crate::paths;
use crate::tray::{self, TrayStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GatewayState {
    Stopped,
    Bootstrapping,
    Starting,
    Running,
    Restarting,
    Error,
    Paused,
}

impl From<GatewayState> for TrayStatus {
    fn from(state: GatewayState) -> Self {
        match state {
            GatewayState::Running => TrayStatus::Running,
            GatewayState::Starting | GatewayState::Restarting | GatewayState::Bootstrapping => {
                TrayStatus::Warn
            }
            GatewayState::Error => TrayStatus::Error,
            GatewayState::Paused | GatewayState::Stopped => TrayStatus::Idle,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Signal {
    Run,
    Pause,
    Shutdown,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusSnapshot {
    pub state: GatewayState,
    pub pid: Option<u32>,
    pub restarts: u32,
    pub last_error: Option<String>,
    pub gateway_port: u16,
}

pub struct Supervisor {
    snapshot: RwLock<StatusSnapshot>,
    signal_tx: watch::Sender<Signal>,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Supervisor {
    pub fn new() -> Self {
        let (tx, _rx) = watch::channel(Signal::Run);
        Self {
            snapshot: RwLock::new(StatusSnapshot {
                state: GatewayState::Stopped,
                pid: None,
                restarts: 0,
                last_error: None,
                gateway_port: 18789,
            }),
            signal_tx: tx,
        }
    }

    pub async fn snapshot(&self) -> StatusSnapshot {
        self.snapshot.read().await.clone()
    }

    pub fn pause(&self) {
        let _ = self.signal_tx.send(Signal::Pause);
    }

    pub fn resume(&self) {
        let _ = self.signal_tx.send(Signal::Run);
    }

    pub async fn shutdown(&self) {
        let _ = self.signal_tx.send(Signal::Shutdown);
        // Small yield so the loop can observe the signal and kill the child.
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    /// Top-level loop. Called once from `setup`.
    pub async fn start(
        self: Arc<Self>,
        handle: AppHandle,
        config: Arc<RwLock<LauncherConfig>>,
    ) -> Result<()> {
        paths::ensure_layout()?;

        {
            let cfg = config.read().await;
            self.snapshot.write().await.gateway_port = cfg.gateway_port;
            if !cfg.autostart_gateway {
                self.signal_tx.send(Signal::Pause).ok();
            }
        }

        if bootstrap::needs_bootstrap()? {
            self.set_state(&handle, GatewayState::Bootstrapping, None, None)
                .await;
            if let Err(err) = bootstrap::run_bootstrap(&handle).await {
                self.set_state(
                    &handle,
                    GatewayState::Error,
                    Some(format!("bootstrap failed: {err:#}")),
                    None,
                )
                .await;
                return Err(err);
            }
        }

        // Ensure a minimal openclaw.json exists so the gateway can read a
        // valid port even before the wizard completes.
        {
            let port = config.read().await.gateway_port;
            if let Err(err) = crate::config::ensure_minimal_openclaw_config(port) {
                tracing::warn!(?err, "could not create minimal openclaw.json");
            }
        }

        let mut backoff = Duration::from_secs(1);
        let mut signal_rx = self.signal_tx.subscribe();
        let mut restarts: u32 = 0;

        loop {
            // Copy the current signal value out and drop the borrow before we
            // touch `signal_rx` again — otherwise the Ref<'_, Signal> held by
            // the match would overlap with the &mut self on `.changed().await`
            // in the Pause arm.
            let current = *signal_rx.borrow();
            match current {
                Signal::Shutdown => break,
                Signal::Pause => {
                    self.set_state(&handle, GatewayState::Paused, None, None).await;
                    // Wait for a different signal.
                    if signal_rx.changed().await.is_err() {
                        break;
                    }
                    continue;
                }
                Signal::Run => {}
            }

            self.set_state(&handle, GatewayState::Starting, None, None).await;

            match self.spawn_once(&handle, &config, &mut signal_rx).await {
                Ok(outcome) => match outcome {
                    SpawnOutcome::Shutdown => break,
                    SpawnOutcome::Paused => continue,
                    SpawnOutcome::Exited(status) => {
                        restarts += 1;
                        let message = format!("gateway exited with status {status:?}");
                        tracing::warn!("{message} — restarting after {:?}", backoff);
                        self.set_state(
                            &handle,
                            GatewayState::Restarting,
                            Some(message),
                            Some(restarts),
                        )
                        .await;
                        sleep_or_signal(&mut signal_rx, backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                    }
                },
                Err(err) => {
                    tracing::error!(?err, "failed to spawn gateway child");
                    self.set_state(
                        &handle,
                        GatewayState::Error,
                        Some(format!("spawn failed: {err:#}")),
                        Some(restarts),
                    )
                    .await;
                    sleep_or_signal(&mut signal_rx, Duration::from_secs(10)).await;
                }
            }
        }

        self.set_state(&handle, GatewayState::Stopped, None, None).await;
        Ok(())
    }

    async fn spawn_once(
        &self,
        handle: &AppHandle,
        config: &Arc<RwLock<LauncherConfig>>,
        signal_rx: &mut watch::Receiver<Signal>,
    ) -> Result<SpawnOutcome> {
        let node = paths::node_exe()?;
        let entry = paths::openclaw_entry()?;
        let log_file = paths::logs_dir()?.join("gateway.log");
        let gateway_port = config.read().await.gateway_port;

        let mut cmd = Command::new(&node);
        cmd.arg(&entry)
            .arg("gateway")
            .arg("run")
            .arg("--bind")
            .arg("loopback")
            .arg("--port")
            .arg(gateway_port.to_string())
            .arg("--force")
            .env("OPENCLAW_CONFIG_PATH", paths::openclaw_config_file()?)
            .env("OPENCLAW_DATA_DIR", paths::app_root()?.join("data"))
            .env("NODE_NO_WARNINGS", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        cmd.kill_on_drop(true);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW — hide child console window on Windows.
            cmd.creation_flags(0x0800_0000);
        }

        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawn node process: {}", node.display()))?;

        let pid = child.id();
        tracing::info!(?pid, entry = %entry.display(), "gateway child spawned");
        self.set_state(handle, GatewayState::Running, None, pid).await;

        if let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) {
            let log_path = log_file.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = drain_streams(stdout, stderr, log_path).await {
                    tracing::warn!(?err, "log drain task ended with error");
                }
            });
        }

        loop {
            tokio::select! {
                status = child.wait() => {
                    let status = status.context("waiting on gateway child")?;
                    return Ok(SpawnOutcome::Exited(status));
                }
                changed = signal_rx.changed() => {
                    if changed.is_err() {
                        let _ = child.kill().await;
                        return Ok(SpawnOutcome::Shutdown);
                    }
                    // Copy the signal out and drop the borrow before any
                    // `.await` below — a live Ref<'_, Signal> across await
                    // makes the future non-Send (RwLockReadGuard: !Send).
                    let current = *signal_rx.borrow();
                    match current {
                        Signal::Shutdown => {
                            let _ = child.kill().await;
                            let _ = child.wait().await;
                            return Ok(SpawnOutcome::Shutdown);
                        }
                        Signal::Pause => {
                            let _ = child.kill().await;
                            let _ = child.wait().await;
                            return Ok(SpawnOutcome::Paused);
                        }
                        Signal::Run => {
                            // Already running; ignore spurious notifications.
                            continue;
                        }
                    }
                }
            }
        }
    }

    async fn set_state(
        &self,
        handle: &AppHandle,
        state: GatewayState,
        error: Option<String>,
        pid: Option<u32>,
    ) {
        {
            let mut snap = self.snapshot.write().await;
            snap.state = state;
            if let Some(p) = pid {
                snap.pid = Some(p);
            }
            if matches!(state, GatewayState::Stopped | GatewayState::Paused) {
                snap.pid = None;
            }
            if let Some(msg) = error.clone() {
                snap.last_error = Some(msg);
            }
        }
        let snapshot = self.snapshot.read().await.clone();
        tray::set_status(handle, state.into());
        if let Err(err) = handle.emit("launcher://status", snapshot) {
            tracing::warn!(?err, "failed to emit launcher://status event");
        }
    }
}

#[derive(Debug)]
enum SpawnOutcome {
    Exited(std::process::ExitStatus),
    Paused,
    Shutdown,
}

async fn sleep_or_signal(signal_rx: &mut watch::Receiver<Signal>, duration: Duration) {
    tokio::select! {
        _ = tokio::time::sleep(duration) => {}
        _ = signal_rx.changed() => {}
    }
}

async fn drain_streams<O, E>(stdout: O, stderr: E, log_path: PathBuf) -> Result<()>
where
    O: tokio::io::AsyncRead + Unpin + Send + 'static,
    E: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .await
        .context("open gateway log")?;

    let mut stdout = BufReader::new(stdout).lines();
    let mut stderr = BufReader::new(stderr).lines();

    loop {
        tokio::select! {
            line = stdout.next_line() => match line? {
                Some(text) => {
                    file.write_all(format!("[out] {text}\n").as_bytes()).await?;
                }
                None => break,
            },
            line = stderr.next_line() => match line? {
                Some(text) => {
                    file.write_all(format!("[err] {text}\n").as_bytes()).await?;
                }
                None => {}
            },
        }
    }
    file.flush().await.ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_to_tray_mapping_is_stable() {
        assert_eq!(TrayStatus::from(GatewayState::Running), TrayStatus::Running);
        assert_eq!(TrayStatus::from(GatewayState::Error), TrayStatus::Error);
        assert_eq!(TrayStatus::from(GatewayState::Paused), TrayStatus::Idle);
        assert_eq!(TrayStatus::from(GatewayState::Starting), TrayStatus::Warn);
        assert_eq!(TrayStatus::from(GatewayState::Bootstrapping), TrayStatus::Warn);
    }

    #[tokio::test]
    async fn snapshot_reflects_construction_defaults() {
        let sup = Supervisor::new();
        let snap = sup.snapshot().await;
        assert_eq!(snap.state, GatewayState::Stopped);
        assert_eq!(snap.restarts, 0);
        assert!(snap.pid.is_none());
    }

    #[tokio::test]
    async fn pause_and_resume_emit_signals() {
        let sup = Supervisor::new();
        let mut rx = sup.signal_tx.subscribe();
        sup.pause();
        rx.changed().await.expect("pause signal observed");
        assert_eq!(*rx.borrow(), Signal::Pause);
        sup.resume();
        rx.changed().await.expect("resume signal observed");
        assert_eq!(*rx.borrow(), Signal::Run);
    }
}
