@echo off
setlocal enabledelayedexpansion

:: ─────────────────────────────────────────────────────────────
:: Standalone OpenClaw — Setup Script (Windows)
:: ────────��────────────────────────────────────────────────────
:: Prerequisites: Node.js >= 22.12
::
:: Usage:
::   setup.cmd
:: ──────────────���──────────────────────────────────────────────

set "SCRIPT_DIR=%~dp0"
set "MIN_NODE_MAJOR=22"
set "MIN_NODE_MINOR=12"

echo.
echo ===================================================
echo   Standalone OpenClaw — Setup
echo ===================================================
echo.

:: ── Step 1: Check Node.js ───────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install Node.js ^>= %MIN_NODE_MAJOR%.%MIN_NODE_MINOR% first.
    echo   https://nodejs.org/en/download
    exit /b 1
)

for /f "tokens=1 delims=v" %%a in ('node -v') do set "NODE_VER=%%a"
for /f "tokens=1 delims=." %%a in ('node -v') do set "NODE_RAW=%%a"
set "NODE_RAW=%NODE_RAW:v=%"

for /f "tokens=1,2 delims=." %%a in ('node -v') do (
    set "NODE_MAJOR=%%a"
    set "NODE_MINOR=%%b"
)
set "NODE_MAJOR=%NODE_MAJOR:v=%"

if %NODE_MAJOR% lss %MIN_NODE_MAJOR% (
    echo [ERROR] Node.js v%NODE_MAJOR%.%NODE_MINOR% is too old. Need ^>= %MIN_NODE_MAJOR%.%MIN_NODE_MINOR%.
    exit /b 1
)
if %NODE_MAJOR% equ %MIN_NODE_MAJOR% (
    if %NODE_MINOR% lss %MIN_NODE_MINOR% (
        echo [ERROR] Node.js v%NODE_MAJOR%.%NODE_MINOR% is too old. Need ^>= %MIN_NODE_MAJOR%.%MIN_NODE_MINOR%.
        exit /b 1
    )
)
echo [OK]    Node.js v%NODE_MAJOR%.%NODE_MINOR%

:: ── Step 2: Install dependencies ────────────────────────────
cd /d "%SCRIPT_DIR%"

if exist "node_modules" (
    echo [OK]    node_modules already exists
    goto :check_claude
)

echo [INFO]  Installing dependencies...
where pnpm >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO]  Using pnpm...
    pnpm install
) else (
    where npm >nul 2>&1
    if %errorlevel% equ 0 (
        echo [INFO]  Using npm...
        npm install
    ) else (
        echo [ERROR] Neither pnpm nor npm found.
        exit /b 1
    )
)
echo [OK]    Dependencies installed

:: ── Step 3: Check Claude CLI ────────────────────────────────
:check_claude
where claude >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK]    Claude CLI found in PATH
    goto :setup_config
)

if exist "%SCRIPT_DIR%node_modules\.bin\claude.cmd" (
    echo [OK]    Claude CLI found in node_modules
    goto :setup_config
)

echo [WARN]  Claude CLI not found in PATH.
echo.
echo   Option A: Install globally:
echo     npm install -g @anthropic-ai/claude-code
echo.
echo   Option B: Install locally:
echo     cd %SCRIPT_DIR% ^&^& npm install @anthropic-ai/claude-code
echo.
echo   Option C: Skip if using API keys instead of CLI backend.
echo.

set /p "INSTALL_CLAUDE=Install Claude CLI locally now? [y/N] "
if /i "%INSTALL_CLAUDE%"=="y" (
    echo [INFO]  Installing @anthropic-ai/claude-code...
    cd /d "%SCRIPT_DIR%"
    where pnpm >nul 2>&1
    if %errorlevel% equ 0 (
        pnpm add @anthropic-ai/claude-code
    ) else (
        npm install @anthropic-ai/claude-code
    )
    echo [OK]    Claude CLI installed
)

:: ── Step 4: Run onboard wizard ──────────────────────────────
:setup_config
echo.
echo [INFO]  Running interactive onboard wizard...
echo   (This will configure your channels, models, and workspace)
echo.

cd /d "%SCRIPT_DIR%"
node openclaw.mjs onboard
if %errorlevel% neq 0 (
    echo [WARN]  Onboard wizard exited. You can run it later with:
    echo     cd %SCRIPT_DIR% ^&^& node openclaw.mjs onboard
)

echo.
echo ===================================================
echo   Setup complete!
echo ===================================================
echo.
echo   Start the gateway:
echo     run.cmd
echo.
echo   Or run manually:
echo     cd %SCRIPT_DIR%
echo     node openclaw.mjs gateway run
echo.
echo   Other useful commands:
echo     node openclaw.mjs doctor      Health check
echo     node openclaw.mjs status      Channel status
echo     node openclaw.mjs onboard     Re-run setup wizard
echo     node openclaw.mjs --help      Full CLI help
echo.

endlocal
