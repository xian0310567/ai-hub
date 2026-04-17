@echo off
setlocal enabledelayedexpansion

:: ─────────────────────────────────────────────────────────────
:: Standalone OpenClaw — Gateway Runner (Windows)
:: ─────────────────────────────────────────────────────────────
:: Starts the OpenClaw gateway with automatic restart on crash.
::
:: Usage:
::   run.cmd                     default: port 18789, loopback
::   run.cmd --port 9000         custom port
::   run.cmd --bind lan          bind to LAN interface
::   run.cmd --no-restart        run once, no auto-restart
::   run.cmd --dev               dev mode (port 19001)
:: ─────────────────────────────────────────────────────────────

set "SCRIPT_DIR=%~dp0"
set "GATEWAY_PORT=18789"
set "GATEWAY_BIND=loopback"
set "AUTO_RESTART=1"
set "DEV_MODE=0"
set "EXTRA_ARGS="

if defined OPENCLAW_GATEWAY_PORT set "GATEWAY_PORT=%OPENCLAW_GATEWAY_PORT%"

:: Parse arguments
:parse_args
if "%~1"=="" goto :done_args
if /i "%~1"=="--port" (
    set "GATEWAY_PORT=%~2"
    shift & shift
    goto :parse_args
)
if /i "%~1"=="--bind" (
    set "GATEWAY_BIND=%~2"
    shift & shift
    goto :parse_args
)
if /i "%~1"=="--no-restart" (
    set "AUTO_RESTART=0"
    shift
    goto :parse_args
)
if /i "%~1"=="--dev" (
    set "DEV_MODE=1"
    shift
    goto :parse_args
)
if /i "%~1"=="--force" (
    set "EXTRA_ARGS=!EXTRA_ARGS! --force"
    shift
    goto :parse_args
)
if /i "%~1"=="-h" goto :show_help
if /i "%~1"=="--help" goto :show_help
set "EXTRA_ARGS=!EXTRA_ARGS! %~1"
shift
goto :parse_args

:show_help
echo Usage: run.cmd [OPTIONS]
echo.
echo Options:
echo   --port ^<port^>    Gateway port (default: 18789, env: OPENCLAW_GATEWAY_PORT)
echo   --bind ^<mode^>    Bind mode: loopback ^| lan ^| all (default: loopback)
echo   --no-restart     Run once without auto-restart
echo   --dev            Dev mode (port 19001, isolated state)
echo   --force          Kill existing process on the port first
echo   -h, --help       Show this help
exit /b 0

:done_args

:: Verify setup
cd /d "%SCRIPT_DIR%"

if not exist "node_modules" (
    echo [ERROR] node_modules not found. Run setup.cmd first.
    exit /b 1
)

:: Build command
set "CMD=node "%SCRIPT_DIR%openclaw.mjs""
if %DEV_MODE% equ 1 set "CMD=!CMD! --dev"
set "CMD=!CMD! gateway run --port %GATEWAY_PORT% --bind %GATEWAY_BIND%"
if defined EXTRA_ARGS set "CMD=!CMD! %EXTRA_ARGS%"

:: Print banner
echo.
echo ===================================================
echo   OpenClaw Gateway
echo ===================================================
echo   Port:    %GATEWAY_PORT%
echo   Bind:    %GATEWAY_BIND%
if %DEV_MODE% equ 1 (echo   Mode:    development) else (echo   Mode:    production)
if %AUTO_RESTART% equ 1 (echo   Restart: auto ^(Ctrl+C to stop^)) else (echo   Restart: disabled)
echo ===================================================
echo.

:: Run
if %AUTO_RESTART% equ 0 goto :run_once

:: Auto-restart loop
set "BACKOFF=1"
set "MAX_BACKOFF=30"
set "RESTARTS=0"

:restart_loop
echo [openclaw] Starting gateway...
%CMD%
set "EXIT_CODE=%errorlevel%"

if %EXIT_CODE% equ 0 (
    echo [openclaw] Gateway exited cleanly.
    goto :eof
)

set /a RESTARTS+=1
echo [openclaw] Gateway exited with code %EXIT_CODE%
echo [openclaw] Restarting in %BACKOFF%s... ^(Ctrl+C to stop^)
timeout /t %BACKOFF% /nobreak >nul

set /a BACKOFF*=2
if %BACKOFF% gtr %MAX_BACKOFF% set "BACKOFF=%MAX_BACKOFF%"

goto :restart_loop

:run_once
echo [openclaw] Starting gateway (no auto-restart)...
%CMD%
echo [openclaw] Gateway exited with code %errorlevel%.
exit /b %errorlevel%

endlocal
