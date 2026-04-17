#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Standalone OpenClaw — Setup Script (macOS / Linux)
# ─────────────────────────────────────────────────────────────
# Prerequisites: Node.js >= 22.12
# pnpm is REQUIRED (the build script uses it internally).
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

    local ver major minor
    ver="$(node -v | sed 's/^v//')"
    major="$(echo "$ver" | cut -d. -f1)"
    minor="$(echo "$ver" | cut -d. -f2)"

    if (( major < MIN_NODE_MAJOR )) || { (( major == MIN_NODE_MAJOR )) && (( minor < MIN_NODE_MINOR )); }; then
        error "Node.js v${ver} is too old. Need >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}."
        exit 1
    fi

    ok "Node.js v${ver}"
}

# ── Step 2: Ensure pnpm is installed ────────────────────────
# pnpm is REQUIRED:
# 1. Build script internally calls `pnpm`
# 2. pnpm respects `pnpm-workspace.yaml` exclusions
# 3. npm would hoist deps to the monorepo root
check_pnpm() {
    if command -v pnpm &>/dev/null; then
        ok "pnpm $(pnpm --version)"
        return 0
    fi

    warn "pnpm not found. pnpm is required (build uses it internally)."
    read -rp "Install pnpm globally via 'npm install -g pnpm'? [Y/n] " answer
    if [[ -z "$answer" || "$answer" =~ ^[Yy]$ ]]; then
        info "Installing pnpm..."
        npm install -g pnpm
        if ! command -v pnpm &>/dev/null; then
            error "pnpm installed but not on PATH. Open a new shell and rerun setup.sh."
            exit 1
        fi
        ok "pnpm $(pnpm --version) installed"
    else
        error "Cannot continue without pnpm. Exiting."
        exit 1
    fi
}

# ── Step 3: Install dependencies ────────────────────────────
install_deps() {
    cd "$SCRIPT_DIR"

    local needs_install=0
    if [ ! -d "node_modules" ]; then
        needs_install=1
    else
        # Sanity check — if node_modules has very few dirs, npm hoisted to parent
        local count
        count="$(find node_modules -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
        if [ "$count" -lt 50 ]; then
            warn "node_modules only has $count packages — likely hoisted to parent workspace."
            warn "Removing and reinstalling with pnpm..."
            rm -rf node_modules
            needs_install=1
        else
            ok "node_modules already exists ($count packages)"
        fi
    fi

    if [ "$needs_install" -eq 1 ]; then
        info "Installing dependencies with pnpm (ignoring parent workspace)..."
        pnpm install --ignore-workspace
        ok "Dependencies installed"
    fi
}

# ── Step 4: Build if dist is missing ────────────────────────
build_if_needed() {
    cd "$SCRIPT_DIR"

    if [ -f "dist/entry.js" ] || [ -f "dist/entry.mjs" ]; then
        ok "dist/ already built"
        return 0
    fi

    warn "dist/ not built. Running build (this may take several minutes)..."
    pnpm --ignore-workspace run build

    if [ ! -f "dist/entry.js" ] && [ ! -f "dist/entry.mjs" ]; then
        error "Build failed — dist/entry.js still missing."
        exit 1
    fi
    ok "Build complete"
}

# ── Step 5: Check Claude CLI ────────────────────────────────
check_claude_cli() {
    if command -v claude &>/dev/null; then
        ok "Claude CLI found at: $(command -v claude)"
        return 0
    fi

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
    printf "    pnpm --ignore-workspace add @anthropic-ai/claude-code\n"
    printf "\n"
    printf "  ${BOLD}Option C:${NC} Skip if you'll use API keys instead of CLI backend.\n"
    printf "\n"

    read -rp "Install Claude CLI locally now? [y/N] " answer
    if [[ "$answer" =~ ^[Yy]$ ]]; then
        info "Installing @anthropic-ai/claude-code..."
        (cd "$SCRIPT_DIR" && pnpm --ignore-workspace add @anthropic-ai/claude-code)
        ok "Claude CLI installed"
    else
        info "Skipping Claude CLI installation"
    fi
}

# ── Step 6: Run onboard wizard ──────────────────────────────
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
    check_pnpm
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
    printf "  Other useful commands:\n"
    printf "    node openclaw.mjs doctor      # Health check\n"
    printf "    node openclaw.mjs status      # Channel status\n"
    printf "    node openclaw.mjs onboard     # Re-run setup wizard\n"
    printf "    node openclaw.mjs --help      # Full CLI help\n"
    printf "\n"
}

main "$@"
