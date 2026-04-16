// src-tauri/src/bootstrap.rs
//
// First-run bootstrap of the runtime layout described in `paths.rs`.
//
// Flow:
//
// 1. Check whether `runtime\node.exe` + `deps\node_modules\standalone-openclaw\openclaw.mjs`
//    already exist. If yes, nothing to do.
// 2. Download a pinned Node.js zip for the current OS+arch into a tmp file,
//    then extract into `runtime\`.
// 3. Run `npm.cmd install --prefix <deps> --no-fund --no-audit <bundled standalone-openclaw tarball> @anthropic-ai/claude-code@latest`.
//    The standalone-openclaw package isn't published to npm; we ship it as a
//    Tauri resource (packed by `scripts/pack-openclaw.mjs`) and install from
//    that local tarball. @anthropic-ai/claude-code still resolves from the
//    public registry.
// 4. Emit `launcher://bootstrap-progress` events so the wizard UI can show a
//    step-by-step progress view.
//
// Network operations use `reqwest` with rustls and streaming to a tempfile so
// large zips don't sit in memory. We deliberately keep the bootstrap logic
// small and synchronous-friendly: if anything goes wrong, the user sees the
// error and can retry from the wizard.

use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

use crate::paths;

// Keep this pinned per launcher release. Bump alongside the launcher version.
const NODE_VERSION: &str = "22.22.2";
const CLAUDE_CODE_VERSION: &str = "latest";
const BUNDLED_OPENCLAW_TARBALL: &str = "resources/standalone-openclaw.tgz";

#[derive(Debug, Clone, Serialize)]
pub struct BootstrapProgress {
    pub step: &'static str,
    pub message: String,
    pub percent: Option<u8>,
}

pub fn needs_bootstrap() -> Result<bool> {
    Ok(!paths::node_exe()?.exists() || !paths::openclaw_entry()?.exists())
}

pub async fn run_bootstrap(handle: &AppHandle) -> Result<()> {
    paths::ensure_layout()?;

    emit(handle, "starting", "Preparing runtime directories", Some(5));

    if !paths::node_exe()?.exists() {
        emit(handle, "node-download", "Downloading portable Node.js", Some(15));
        download_and_extract_node(handle).await?;
    } else {
        emit(handle, "node-skip", "Portable Node.js already present", Some(35));
    }

    emit(handle, "npm-install", "Installing standalone-openclaw + claude-code", Some(55));
    npm_install(handle).await?;

    emit(handle, "done", "Bootstrap complete", Some(100));
    Ok(())
}

fn emit(handle: &AppHandle, step: &'static str, message: impl Into<String>, percent: Option<u8>) {
    let payload = BootstrapProgress {
        step,
        message: message.into(),
        percent,
    };
    if let Err(err) = handle.emit("launcher://bootstrap-progress", payload) {
        tracing::warn!(?err, "failed to emit bootstrap progress");
    }
}

async fn download_and_extract_node(handle: &AppHandle) -> Result<()> {
    let url = node_download_url()?;
    tracing::info!(url = %url, "downloading Node.js runtime");

    let response = reqwest::Client::builder()
        .user_agent("standalone-openclaw-launcher")
        .build()?
        .get(&url)
        .send()
        .await
        .with_context(|| format!("download {url}"))?;

    if !response.status().is_success() {
        bail!("node download failed: HTTP {}", response.status());
    }

    let total = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let tmp_path = paths::runtime_dir()?.join("node-download.tmp");
    let mut file = tokio::fs::File::create(&tmp_path).await?;

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.context("read node zip chunk")?;
        downloaded += bytes.len() as u64;
        file.write_all(&bytes).await?;
        if total > 0 {
            let pct = ((downloaded as f64 / total as f64) * 25.0) as u8 + 15;
            emit(handle, "node-download", "Downloading portable Node.js", Some(pct.min(40)));
        }
    }
    file.flush().await?;
    drop(file);

    emit(handle, "node-extract", "Extracting portable Node.js", Some(45));
    extract_node_zip(&tmp_path, &paths::runtime_dir()?)?;
    fs::remove_file(&tmp_path).ok();
    Ok(())
}

fn node_download_url() -> Result<String> {
    // Pinned archive name patterns mirror https://nodejs.org/dist/.
    let (os, arch, ext) = if cfg!(target_os = "windows") {
        (
            "win",
            if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            },
            "zip",
        )
    } else if cfg!(target_os = "macos") {
        (
            "darwin",
            if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            },
            "tar.gz",
        )
    } else if cfg!(target_os = "linux") {
        (
            "linux",
            if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            },
            "tar.xz",
        )
    } else {
        bail!("unsupported platform for bootstrap");
    };
    Ok(format!(
        "https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-{os}-{arch}.{ext}"
    ))
}

#[cfg(target_os = "windows")]
fn extract_node_zip(zip_path: &Path, runtime_dir: &Path) -> Result<()> {
    let file = fs::File::open(zip_path).context("open node zip")?;
    let mut archive = zip::ZipArchive::new(file).context("read node zip")?;

    // The archive contains a top-level dir `node-v<ver>-win-x64/`. We flatten
    // it so `runtime\node.exe` lands at the expected location.
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let Some(stripped) = enclosed
            .components()
            .skip(1)
            .collect::<std::path::PathBuf>()
            .to_str()
            .map(String::from)
        else {
            continue;
        };
        if stripped.is_empty() {
            continue;
        }
        let out_path = runtime_dir.join(&stripped);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&out_path)
            .with_context(|| format!("create {}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn extract_node_zip(_zip_path: &Path, _runtime_dir: &Path) -> Result<()> {
    // On non-Windows hosts we accept that bootstrap is a no-op: the end user
    // is expected to supply their own Node. Development/test runs on Linux
    // simply expect `runtime/bin/node` to be a symlink to a system Node.
    bail!("automatic Node bootstrap is Windows-only; install Node manually for this platform")
}

#[cfg(target_os = "windows")]
fn strip_windows_extended_prefix(path: &Path) -> std::path::PathBuf {
    use std::path::PathBuf;
    let s = path.as_os_str().to_string_lossy();
    // Handle both `\\?\C:\...` (local drive) and `\\?\UNC\server\share` forms.
    // For UNC we keep it as-is since stripping would change the meaning.
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if rest.starts_with("UNC\\") {
            path.to_path_buf()
        } else {
            PathBuf::from(rest)
        }
    } else {
        path.to_path_buf()
    }
}

async fn npm_install(handle: &AppHandle) -> Result<()> {
    let npm = paths::npm_cmd()?;
    let deps = paths::deps_dir()?;
    paths::ensure_dir(&deps)?;

    // standalone-openclaw ships bundled with the installer as a tarball
    // because it's not published to the public npm registry. Resolve its
    // on-disk path so npm can install it as a local file spec.
    let openclaw_tarball = handle
        .path()
        .resolve(BUNDLED_OPENCLAW_TARBALL, BaseDirectory::Resource)
        .context("resolve bundled standalone-openclaw tarball")?;
    if !openclaw_tarball.exists() {
        bail!(
            "bundled standalone-openclaw tarball missing at {}",
            openclaw_tarball.display()
        );
    }
    // Tauri's path resolver returns Windows extended-length paths
    // (`\\?\C:\...`). npm's arg parser mis-interprets the `\\?\` prefix as
    // part of a `file:` URL, truncates the real path to `file:C:\ (null)`,
    // then tries to read that and fails with EISDIR. Strip the prefix for
    // npm so it sees a plain `C:\...` path. Safe here because the resource
    // path is well under the 260-char limit that would actually require
    // the extended prefix.
    #[cfg(target_os = "windows")]
    let openclaw_tarball = strip_windows_extended_prefix(&openclaw_tarball);

    emit(handle, "npm-install", "Running npm install…", Some(60));

    let mut cmd = tokio::process::Command::new(&npm);
    cmd.arg("install")
        .arg("--prefix")
        .arg(&deps)
        .arg("--no-fund")
        .arg("--no-audit")
        .arg("--omit=dev")
        .arg("--loglevel=http")
        .arg(&openclaw_tarball)
        .arg(format!("@anthropic-ai/claude-code@{CLAUDE_CODE_VERSION}"))
        .env("NODE_NO_WARNINGS", "1")
        .env("NPM_CONFIG_UPDATE_NOTIFIER", "false")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn {}", npm.display()))?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    // Stream stderr line by line → emit each line to the wizard UI.
    // Also collect the full output so we can surface it on failure.
    let handle_stderr = handle.clone();
    let drain_stderr = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stderr).lines();
        let mut collected: Vec<u8> = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                emit(&handle_stderr, "npm-log", &line, None);
                collected.extend_from_slice(line.as_bytes());
                collected.push(b'\n');
            }
        }
        collected
    });

    // Stream stdout line by line → emit each line to the wizard UI.
    let handle_stdout = handle.clone();
    let drain_stdout = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                emit(&handle_stdout, "npm-log", &line, None);
            }
        }
    });

    let status = child.wait().await.context("wait for npm")?;

    let stderr_bytes = drain_stderr.await.unwrap_or_default();
    let _ = drain_stdout.await;

    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr_bytes);
        bail!("npm install failed: {stderr}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_url_targets_current_platform() {
        let url = node_download_url().expect("platform supported");
        assert!(url.starts_with("https://nodejs.org/dist/v"));
        assert!(url.contains(NODE_VERSION));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn strips_local_drive_extended_prefix() {
        let input = Path::new(r"\\?\C:\Users\the_c\AppData\Local\StandaloneOpenClaw\tarball.tgz");
        let out = strip_windows_extended_prefix(input);
        assert_eq!(
            out.as_os_str().to_string_lossy(),
            r"C:\Users\the_c\AppData\Local\StandaloneOpenClaw\tarball.tgz"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn leaves_plain_path_untouched() {
        let input = Path::new(r"C:\Users\the_c\tarball.tgz");
        let out = strip_windows_extended_prefix(input);
        assert_eq!(out, input);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn preserves_unc_extended_prefix() {
        // `\\?\UNC\server\share` needs the prefix to stay meaningful; don't strip.
        let input = Path::new(r"\\?\UNC\server\share\file.tgz");
        let out = strip_windows_extended_prefix(input);
        assert_eq!(out, input);
    }
}
