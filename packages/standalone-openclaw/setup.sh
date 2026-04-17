#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Standalone OpenClaw — Setup Script (macOS / Linux)
# ─────────────────────────────────────────────────────────────
# Prerequisites: Node.js >= 22.12, pnpm (or npm)
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
# ─────────────────────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12

info()  { printf "${CYAN}[INFO]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*"; }

# ── Step 1: Check Node.js ───────────────────────────────────
check_node() {
    if ! command -v node &>/dev/null; then
        error "Node.js not found. Install Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} first."
        printf "  https://nodejs.org/en/download\n"
        printf "  Or use nvm: nvm install %s && nvm use %s\n" "$MIN_NODE_MAJOR" "$MIN_NODE_MAJOR"
        exit 1
    fi

    local ver
    ver="$(node -v | sed 's/^v//')"
    local major minor
    major="$(echo "$ver" | cut -d. -f1)"
    minor="$(echo "$ver" | cut -d. -f2)"

    if (( major < MIN_NODE_MAJOR )) || { (( major == MIN_NODE_MAJOR )) && (( minor < MIN_NODE_MINOR )); }; then
        error "Node.js v${ver} is too old. Need >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}."
        printf "  Current: v%s\n" "$ver"
        printf "  Run: nvm install %s && nvm use %s\n" "$MIN_NODE_MAJOR" "$MIN_NODE_MAJOR"
        exit 1
    fi

    ok "Node.js v${ver}"
}

# ── Step 2: Install dependencies ────────────────────────────
install_deps() {
    cd "$SCRIPT_DIR"

    if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ] || [ -d "node_modules/.pnpm" ] || [ "$(ls -A node_modules 2>/dev/null | head -1)" != "" ]; then
        ok "node_modules already exists ($(ls node_modules | wc -l | tr -d ' ') packages)"
        return 0
    fi

    info "Installing dependencies..."

    if command -v pnpm &>/dev/null; then
        info "Using pnpm..."
        pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1
    elif command -v npm &>/dev/null; then
        info "Using npm..."
        npm install 2>&1
    else
        error "Neither pnpm nor npm found. Install one of them first."
        exit 1
    fi

    ok "Dependencies installed"
}

# ── Step 2.5: Build if dist is missing ──────────────────────
build_if_needed() {
    cd "$SCRIPT_DIR"

    if [ -f "dist/entry.js" ] || [ -f "dist/entry.mjs" ]; then
        ok "dist/ already built"
        return 0
    fi

    warn "dist/ not built. Running build (this may take several minutes)..."
    if command -v pnpm &>/dev/null; then
        pnpm run build
    else
        npm run build
    fi

    if [ ! -f "dist/entry.js" ] && [ ! -f "dist/entry.mjs" ]; then
        error "Build failed — dist/entry.js still missing."
        exit 1
    fi
    ok "Build complete"
}

# ── Step 3: Check Claude CLI ────────────────────────────────
check_claude_cli() {
    if command -v claude &>/dev/null; then
        local claude_path
        claude_path="$(command -v claude)"
        ok "Claude CLI found at: ${claude_path}"
        return 0
    fi

    # Check if @anthropic-ai/claude-code is in node_modules
    if [ -x "$SCRIPT_DIR/node_modules/.bin/claude" ]; then
        ok "Claude CLI found in node_modules"
        return 0
    fi

    warn "Claude CLI not found in PATH."
    printf "\n"
    printf "  ${BOLD}Option A:${NC} Install globally:\n"
    printf "    npm install -g @anthropic-ai/claude-code\n"
    printf "\n"
    printf "  ${BOLD}Option B:${NC} Install locally in this project:\n"
    printf "    cd %s && npm install @anthropic-ai/claude-code\n" "$SCRIPT_DIR"
    printf "\n"
    printf "  ${BOLD}Option C:${NC} Skip if you'll use API keys instead of CLI backend.\n"
    printf "\n"

    read -rp "Install Claude CLI locally now? [y/N] " answer
    if [[ "$answer" =~ ^[Yy]$ ]]; then
        info "Installing @anthropic-ai/claude-code..."
        if command -v pnpm &>/dev/null; then
            (cd "$SCRIPT_DIR" && pnpm add @anthropic-ai/claude-code)
        else
            (cd "$SCRIPT_DIR" && npm install @anthropic-ai/claude-code)
        fi
        ok "Claude CLI installed"
    else
        info "Skipping Claude CLI installation"
    fi
}

# ── Step 4: Create default config ───────────────────────────
setup_config() {
    local config_dir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    local config_file="${OPENCLAW_CONFIG_PATH:-$config_dir/openclaw.json}"

    if [ -f "$config_file" ]; then
        ok "Config already exists at: ${config_file}"
        read -rp "Run onboard wizard again? [y/N] " answer
        if [[ ! "$answer" =~ ^[Yy]$ ]]; then
            return 0
        fi
    fi

    printf "\n"
    info "Running interactive onboard wizard..."
    printf "  (This will configure your channels, models, and workspace)\n\n"

    cd "$SCRIPT_DIR"
    node openclaw.mjs onboard || {
        warn "Onboard wizard exited. You can run it later with:"
        printf "    cd %s && node openclaw.mjs onboard\n" "$SCRIPT_DIR"
        printf "  Or manually edit: %s\n" "$config_file"
    }
}

# ── Main ────────────────────────────────────────────────────
main() {
    printf "\n"
    printf "${BOLD}${CYAN}═══════════════════════════════════════════════════${NC}\n"
    printf "${BOLD}${CYAN}  Standalone OpenClaw — Setup${NC}\n"
    printf "${BOLD}${CYAN}═══════════════════════════════════════════════════${NC}\n"
    printf "\n"

    check_node
    install_deps
    build_if_needed
    check_claude_cli
    setup_config

    printf "\n"
    printf "${BOLD}${GREEN}═══════════════════════════════════════════════════${NC}\n"
    printf "${GREEN}  Setup complete!${NC}\n"
    printf "${BOLD}${GREEN}═══════════════════════════════════════════════════${NC}\n"
    printf "\n"
    printf "  Start the gateway:\n"
    printf "    ${BOLD}./run.sh${NC}\n"
    printf "\n"
    printf "  Or run manually:\n"
    printf "    ${BOLD}cd %s${NC}\n" "$SCRIPT_DIR"
    printf "    ${BOLD}node openclaw.mjs gateway run${NC}\n"
    printf "\n"
    printf "  Other useful commands:\n"
    printf "    node openclaw.mjs doctor      # Health check\n"
    printf "    node openclaw.mjs status      # Channel status\n"
    printf "    node openclaw.mjs onboard     # Re-run setup wizard\n"
    printf "    node openclaw.mjs --help      # Full CLI help\n"
    printf "\n"
}

main "$@"
