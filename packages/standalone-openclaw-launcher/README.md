# standalone-openclaw-launcher

Windows-native tray launcher for [`standalone-openclaw`](../standalone-openclaw/). Built with Tauri v2: a tiny Rust core (~600 LOC) supervises the gateway child process, embeds the Control UI webview, manages autostart, and runs a first-run setup wizard.

## What it does

- **Bootstraps a portable Node.js runtime** into `%LOCALAPPDATA%\StandaloneOpenClaw\runtime\` on first run.
- **Runs `npm install`** into `%LOCALAPPDATA%\StandaloneOpenClaw\deps\` to get `standalone-openclaw` + `@anthropic-ai/claude-code`.
- **Spawns the gateway** as a child process (`node openclaw.mjs gateway run`) and restarts it on crash with exponential backoff.
- **Shows a system tray icon** that doubles as a status indicator: green (running) / yellow (starting) / red (error) / grey (idle).
- **Auto-starts on Windows login** via a Startup-folder shortcut (no UAC prompt, no Task Scheduler).
- **Embeds the Control UI** (`http://127.0.0.1:18789`) in a Tauri webview for the dashboard window.
- **First-run wizard** collects the local Claude CLI path, Telegram bot token, workspace folder, then writes `openclaw.json`.

## Layout

```
%LOCALAPPDATA%\StandaloneOpenClaw\
├── runtime\node.exe                        # portable Node bundled on first run
├── deps\node_modules\
│   ├── standalone-openclaw\openclaw.mjs
│   └── @anthropic-ai\claude-code\bin\claude.cmd
├── config\
│   ├── launcher.json                       # launcher-owned state
│   └── openclaw.json                       # OPENCLAW_CONFIG_PATH target
└── logs\
    ├── gateway.log
    └── launcher.log
```

## Development

```bash
# From the repo root
pnpm install
pnpm --filter standalone-openclaw-launcher tauri dev
```

Rust tests (process supervisor, config writer, path resolution):

```bash
cd packages/standalone-openclaw-launcher/src-tauri
cargo test
```

Frontend tests (wizard state machine):

```bash
pnpm --filter standalone-openclaw-launcher test
```

## Build (Windows)

```bash
pnpm --filter standalone-openclaw-launcher tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`:

- `msi/Standalone OpenClaw_0.1.0_x64_en-US.msi`
- `nsis/Standalone OpenClaw_0.1.0_x64-setup.exe`

## Design notes

- **No OpenClaw code fork.** The launcher drives `standalone-openclaw` entirely through its existing CLI surface: `openclaw gateway run`, `OPENCLAW_CONFIG_PATH`, and the Control UI HTTP endpoint.
- **Config is additive.** `openclaw.json` is read, minimally patched, and written back — user edits survive wizard reruns.
- **Claude auth is delegated.** The launcher spawns `claude auth login` in a terminal when asked; it never touches Anthropic OAuth itself. OpenClaw reads `~/.claude/.credentials.json` at runtime.
- **Tray is the home screen.** Closing any window hides to the tray; only the tray "Quit" item exits the process.
- **Autostart is Startup-folder, not Task Scheduler.** Avoids the UAC prompt and the `schtasks` hang described in `packages/standalone-openclaw/docs/platforms/windows.md`.

## Spec

Full design document: [`/docs/standalone-openclaw-launcher.md`](../../docs/standalone-openclaw-launcher.md).
