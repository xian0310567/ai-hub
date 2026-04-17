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

# ── Step 1: Check Node.js ──
Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "  Standalone OpenClaw - Setup" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

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

# ── Step 2: Install dependencies ──
Set-Location $ScriptDir

if (Test-Path "node_modules") {
    $count = (Get-ChildItem node_modules -Directory | Measure-Object).Count
    Write-OK "node_modules already exists ($count packages)"
} else {
    Write-Info "Installing dependencies..."
    $pnpmPath = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpmPath) {
        Write-Info "Using pnpm..."
        & pnpm install
    } else {
        Write-Info "Using npm..."
        & npm install
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Dependency install failed."
        exit 1
    }
    Write-OK "Dependencies installed"
}

# ── Step 2.5: Build if dist is missing ──
$entryJs = Join-Path $ScriptDir "dist\entry.js"
$entryMjs = Join-Path $ScriptDir "dist\entry.mjs"
if (-not (Test-Path $entryJs) -and -not (Test-Path $entryMjs)) {
    Write-Warn "dist/ not built. Running build (this may take several minutes)..."
    if ($pnpmPath) {
        & pnpm run build
    } else {
        & npm run build
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Build failed. Check the error output above."
        exit 1
    }
    Write-OK "Build complete"
} else {
    Write-OK "dist/ already built"
}

# ── Step 3: Check Claude CLI ──
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
    Write-Host "    npm install @anthropic-ai/claude-code"
    Write-Host ""
    Write-Host "  Option C: Skip if using API keys instead of CLI backend."
    Write-Host ""

    $answer = Read-Host "Install Claude CLI locally now? [y/N]"
    if ($answer -eq 'y' -or $answer -eq 'Y') {
        Write-Info "Installing @anthropic-ai/claude-code..."
        if ($pnpmPath) {
            & pnpm add @anthropic-ai/claude-code
        } else {
            & npm install @anthropic-ai/claude-code
        }
        Write-OK "Claude CLI installed"
    }
}

# ── Step 4: Run onboard wizard ──
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
