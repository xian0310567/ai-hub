#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# ── Standalone OpenClaw - Setup Script (PowerShell) ──

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$MinNodeMajor = 22
$MinNodeMinor = 12

function Write-OK    ($msg) { Write-Host "[OK]    $msg" -ForegroundColor Green }
function Write-Info  ($msg) { Write-Host "[INFO]  $msg" -ForegroundColor Cyan }
function Write-Warn  ($msg) { Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Err   ($msg) { Write-Host "[ERROR] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "  Standalone OpenClaw - Setup" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Check Node.js ──
$nodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodePath) {
    Write-Err "Node.js not found. Install Node.js >= $MinNodeMajor.$MinNodeMinor first."
    Write-Host "  https://nodejs.org/en/download"
    exit 1
}

$nodeVer = (node -v) -replace '^v', ''
$parts = $nodeVer.Split('.')
$major = [int]$parts[0]
$minor = [int]$parts[1]

if ($major -lt $MinNodeMajor -or ($major -eq $MinNodeMajor -and $minor -lt $MinNodeMinor)) {
    Write-Err "Node.js v$nodeVer is too old. Need >= $MinNodeMajor.$MinNodeMinor."
    exit 1
}
Write-OK "Node.js v$nodeVer"

# ── Step 2: Ensure pnpm is installed ──
# pnpm is REQUIRED because:
# 1. The build script internally calls `pnpm` commands
# 2. It respects `pnpm-workspace.yaml` exclusions (standalone-openclaw is excluded)
# 3. npm would hoist deps to the monorepo root, breaking standalone usage
$pnpmPath = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmPath) {
    Write-Warn "pnpm not found. pnpm is required (the build uses it internally)."
    $answer = Read-Host "Install pnpm globally now via 'npm install -g pnpm'? [Y/n]"
    if ($answer -eq '' -or $answer -eq 'y' -or $answer -eq 'Y') {
        Write-Info "Installing pnpm..."
        & npm install -g pnpm
        if ($LASTEXITCODE -ne 0) {
            Write-Err "pnpm install failed. Run manually: npm install -g pnpm"
            exit 1
        }
        # Re-resolve
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        $pnpmPath = Get-Command pnpm -ErrorAction SilentlyContinue
        if (-not $pnpmPath) {
            Write-Err "pnpm installed but not on PATH. Open a new PowerShell window and rerun setup.ps1."
            exit 1
        }
    } else {
        Write-Err "Cannot continue without pnpm. Exiting."
        exit 1
    }
}
Write-OK "pnpm $(pnpm --version)"

# ── Step 3: Install dependencies ──
Set-Location $ScriptDir

$needsInstall = $false
if (-not (Test-Path "node_modules")) {
    $needsInstall = $true
} else {
    # Sanity check — if node_modules has very few dirs, npm probably hoisted to parent
    $count = (Get-ChildItem node_modules -Directory | Measure-Object).Count
    if ($count -lt 50) {
        Write-Warn "node_modules only has $count packages — likely installed into parent workspace by npm."
        Write-Warn "Removing and reinstalling with pnpm..."
        Remove-Item -Recurse -Force node_modules
        $needsInstall = $true
    } else {
        Write-OK "node_modules already exists ($count packages)"
    }
}

if ($needsInstall) {
    Write-Info "Installing dependencies with pnpm (ignoring parent workspace)..."
    # --ignore-workspace: don't let parent ai-hub workspace interfere
    & pnpm install --ignore-workspace
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Dependency install failed."
        exit 1
    }
    Write-OK "Dependencies installed"
}

# ── Step 4: Build if dist is missing ──
$entryJs = Join-Path $ScriptDir "dist\entry.js"
$entryMjs = Join-Path $ScriptDir "dist\entry.mjs"
if (-not (Test-Path $entryJs) -and -not (Test-Path $entryMjs)) {
    Write-Warn "dist/ not built. Running build (this may take several minutes)..."
    & pnpm --ignore-workspace run build
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Build failed. Check the error output above."
        exit 1
    }
    Write-OK "Build complete"
} else {
    Write-OK "dist/ already built"
}

# ── Step 5: Check Claude CLI ──
$claudePath = Get-Command claude -ErrorAction SilentlyContinue
$claudeLocal = Join-Path $ScriptDir "node_modules\.bin\claude.cmd"

if ($claudePath) {
    Write-OK "Claude CLI found at: $($claudePath.Source)"
} elseif (Test-Path $claudeLocal) {
    Write-OK "Claude CLI found in node_modules"
} else {
    Write-Warn "Claude CLI not found in PATH."
    Write-Host ""
    Write-Host "  Option A: Install globally:"
    Write-Host "    npm install -g @anthropic-ai/claude-code"
    Write-Host ""
    Write-Host "  Option B: Install locally:"
    Write-Host "    pnpm add @anthropic-ai/claude-code"
    Write-Host ""
    Write-Host "  Option C: Skip if using API keys instead of CLI backend."
    Write-Host ""

    $answer = Read-Host "Install Claude CLI locally now? [y/N]"
    if ($answer -eq 'y' -or $answer -eq 'Y') {
        Write-Info "Installing @anthropic-ai/claude-code..."
        & pnpm --ignore-workspace add @anthropic-ai/claude-code
        Write-OK "Claude CLI installed"
    }
}

# ── Step 6: Run onboard wizard ──
Write-Host ""
Write-Info "Running interactive onboard wizard..."
Write-Host "  (This will configure your channels, models, and workspace)"
Write-Host ""

& node "$ScriptDir\openclaw.mjs" onboard
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Onboard wizard exited. You can run it later with:"
    Write-Host "    node openclaw.mjs onboard"
}

Write-Host ""
Write-Host "===================================================" -ForegroundColor Green
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Start the gateway:"
Write-Host "    .\run.ps1" -ForegroundColor White
Write-Host ""
Write-Host "  Other useful commands:"
Write-Host "    node openclaw.mjs doctor      # Health check"
Write-Host "    node openclaw.mjs status      # Channel status"
Write-Host "    node openclaw.mjs onboard     # Re-run setup wizard"
Write-Host "    node openclaw.mjs --help      # Full CLI help"
Write-Host ""
