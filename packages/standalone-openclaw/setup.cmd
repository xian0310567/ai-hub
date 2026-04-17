@echo off
setlocal enabledelayedexpansion

:: ─────────────────────────────────────────────────────────────
:: Standalone OpenClaw — Setup Script (Windows cmd.exe)
:: ─────────────────────────────────────────────────────────────
:: NOTE: In PowerShell, use setup.ps1 instead (better encoding).
:: Prerequisites: Node.js >= 22.12, pnpm (required)
:: ─────────────────────────────────────────────────────────────

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

:: ── Step 2: Ensure pnpm ─────────────────────────────────────
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN]  pnpm not found. pnpm is required.
    set /p "INSTALL_PNPM=Install pnpm globally via 'npm install -g pnpm'? [Y/n] "
    if /i "!INSTALL_PNPM!"=="" set "INSTALL_PNPM=y"
    if /i "!INSTALL_PNPM!"=="y" (
        echo [INFO]  Installing pnpm...
        npm install -g pnpm
        if %errorlevel% neq 0 (
            echo [ERROR] pnpm install failed.
            exit /b 1
        )
    ) else (
        echo [ERROR] Cannot continue without pnpm.
        exit /b 1
    )
)
echo [OK]    pnpm installed

:: ── Step 3: Install dependencies ────────────────────────────
cd /d "%SCRIPT_DIR%"

set "NEEDS_INSTALL=0"
if not exist "node_modules" set "NEEDS_INSTALL=1"

if "%NEEDS_INSTALL%"=="1" (
    echo [INFO]  Installing dependencies with pnpm --ignore-workspace...
    pnpm install --ignore-workspace
    if %errorlevel% neq 0 (
        echo [ERROR] Install failed.
        exit /b 1
    )
    echo [OK]    Dependencies installed
) else (
    echo [OK]    node_modules already exists
)

:: ── Step 4: Build if dist is missing ────────────────────────
if exist "%SCRIPT_DIR%dist\entry.js" goto :check_claude
if exist "%SCRIPT_DIR%dist\entry.mjs" goto :check_claude

echo [WARN]  dist/ not built. Running build ^(this may take several minutes^)...
pnpm --ignore-workspace run build
if not exist "%SCRIPT_DIR%dist\entry.js" (
    if not exist "%SCRIPT_DIR%dist\entry.mjs" (
        echo [ERROR] Build failed.
        exit /b 1
    )
)
echo [OK]    Build complete

:: ── Step 5: Check Claude CLI ────────────────────────────────
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
echo     pnpm --ignore-workspace add @anthropic-ai/claude-code
echo.

set /p "INSTALL_CLAUDE=Install Claude CLI locally now? [y/N] "
if /i "%INSTALL_CLAUDE%"=="y" (
    echo [INFO]  Installing @anthropic-ai/claude-code...
    pnpm --ignore-workspace add @anthropic-ai/claude-code
    echo [OK]    Claude CLI installed
)

:: ── Step 6: Run onboard wizard ──────────────────────────────
:setup_config
echo.
echo [INFO]  Running interactive onboard wizard...
echo.

node "%SCRIPT_DIR%openclaw.mjs" onboard

echo.
echo ===================================================
echo   Setup complete!
echo ===================================================
echo.
echo   Start the gateway:
echo     run.cmd   (or .\run.ps1 in PowerShell)
echo.

endlocal
