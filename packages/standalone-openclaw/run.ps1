#Requires -Version 5.1
param(
    [int]$Port = $( if ($env:OPENCLAW_GATEWAY_PORT) { $env:OPENCLAW_GATEWAY_PORT } else { 18789 } ),
    [string]$Bind = "loopback",
    [switch]$Dev,
    [switch]$Force,
    [switch]$NoRestart
)

# ── Standalone OpenClaw - Gateway Runner (PowerShell) ──

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-OK   ($msg) { Write-Host "[openclaw] $msg" -ForegroundColor Green }
function Write-Info ($msg) { Write-Host "[openclaw] $msg" -ForegroundColor Cyan }
function Write-Warn ($msg) { Write-Host "[openclaw] $msg" -ForegroundColor Yellow }
function Write-Err  ($msg) { Write-Host "[openclaw] $msg" -ForegroundColor Red }

# Verify setup
if (-not (Test-Path "$ScriptDir\node_modules")) {
    Write-Err "node_modules not found. Run .\setup.ps1 first."
    exit 1
}

# Build arguments
$gatewayArgs = @("$ScriptDir\openclaw.mjs")
if ($Dev) { $gatewayArgs += "--dev" }
$gatewayArgs += "gateway", "run", "--port", $Port, "--bind", $Bind
if ($Force) { $gatewayArgs += "--force" }

# Banner
Write-Host ""
Write-OK "==================================================="
Write-OK "  OpenClaw Gateway"
Write-OK "==================================================="
Write-Info "  Port:    $Port"
Write-Info "  Bind:    $Bind"
Write-Info "  Mode:    $(if ($Dev) { 'development' } else { 'production' })"
Write-Info "  Restart: $(if ($NoRestart) { 'disabled' } else { 'auto (Ctrl+C to stop)' })"
Write-OK "==================================================="
Write-Host ""

Set-Location $ScriptDir

if ($NoRestart) {
    # Single run
    & node @gatewayArgs
    exit $LASTEXITCODE
}

# Auto-restart loop
$backoff = 1
$maxBackoff = 30
$restarts = 0

while ($true) {
    if ($restarts -gt 0) {
        Write-Warn "Restarting gateway (attempt #$restarts, backoff ${backoff}s)..."
    }

    $process = Start-Process -FilePath "node" -ArgumentList $gatewayArgs -NoNewWindow -PassThru
    Write-Info "Gateway started (PID $($process.Id))"

    try {
        $process.WaitForExit()
    } catch {
        # Ctrl+C pressed
        if (-not $process.HasExited) {
            $process.Kill()
        }
        Write-Info "Stopped."
        break
    }

    $exitCode = $process.ExitCode

    if ($exitCode -eq 0) {
        Write-Info "Gateway exited cleanly."
        break
    }

    $restarts++
    Write-Warn "Gateway exited with code $exitCode"
    Write-Warn "Restarting in ${backoff}s... (Ctrl+C to stop)"

    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min($backoff * 2, $maxBackoff)
}
