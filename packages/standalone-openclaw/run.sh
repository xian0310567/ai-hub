#!/usr/bin/env bash
set -euo pipefail

# ───────────���─────────────────────��───────────────────────────
# Standalone OpenClaw — Gateway Runner (macOS / Linux)
# ─────────────���────────────────────────────────���──────────────
# Starts the OpenClaw gateway with automatic restart on crash.
#
# Usage:
#   ./run.sh                    # default: port 18789, loopback
#   ./run.sh --port 9000        # custom port
#   ./run.sh --bind lan         # bind to LAN interface
#   ./run.sh --no-restart       # run once, no auto-restart
#   ./run.sh --dev              # dev mode (port 19001, isolated state)
# ���──────────────────────────────��─────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Defaults
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
GATEWAY_BIND="loopback"
AUTO_RESTART=true
MAX_BACKOFF=30
EXTRA_ARGS=()
DEV_MODE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)
            GATEWAY_PORT="$2"
            shift 2
            ;;
        --bind)
            GATEWAY_BIND="$2"
            shift 2
            ;;
        --no-restart)
            AUTO_RESTART=false
            shift
            ;;
        --dev)
            DEV_MODE=true
            shift
            ;;
        --force)
            EXTRA_ARGS+=("--force")
            shift
            ;;
        -h|--help)
            printf "Usage: %s [OPTIONS]\n\n" "$0"
            printf "Options:\n"
            printf "  --port <port>    Gateway port (default: 18789, env: OPENCLAW_GATEWAY_PORT)\n"
            printf "  --bind <mode>    Bind mode: loopback | lan | all (default: loopback)\n"
            printf "  --no-restart     Run once without auto-restart\n"
            printf "  --dev            Dev mode (port 19001, isolated state)\n"
            printf "  --force          Kill existing process on the port first\n"
            printf "  -h, --help       Show this help\n"
            exit 0
            ;;
        *)
            EXTRA_ARGS+=("$1")
            shift
            ;;
    esac
done

info()  { printf "${CYAN}[openclaw]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[openclaw]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[openclaw]${NC} %s\n" "$*"; }
error() { printf "${RED}[openclaw]${NC} %s\n" "$*"; }

# Verify setup
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    error "node_modules not found. Run ./setup.sh first."
    exit 1
fi

if [ ! -f "$SCRIPT_DIR/dist/entry.js" ] && [ ! -f "$SCRIPT_DIR/dist/entry.mjs" ]; then
    error "dist/ not found. The package may not be built."
    exit 1
fi

# Build command
build_cmd() {
    local cmd=("node" "$SCRIPT_DIR/openclaw.mjs")

    if $DEV_MODE; then
        cmd+=("--dev")
    fi

    cmd+=("gateway" "run")
    cmd+=("--port" "$GATEWAY_PORT")
    cmd+=("--bind" "$GATEWAY_BIND")
    cmd+=("${EXTRA_ARGS[@]}")

    echo "${cmd[@]}"
}

# Graceful shutdown
CHILD_PID=""
cleanup() {
    if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
        info "Shutting down gateway (PID $CHILD_PID)..."
        kill -TERM "$CHILD_PID" 2>/dev/null || true
        wait "$CHILD_PID" 2>/dev/null || true
    fi
    info "Stopped."
    exit 0
}
trap cleanup SIGINT SIGTERM

# Single run mode
run_once() {
    local cmd
    cmd="$(build_cmd)"
    info "Starting gateway..."
    info "  Command: $cmd"
    info "  Port:    $GATEWAY_PORT"
    info "  Bind:    $GATEWAY_BIND"
    printf "\n"

    eval "$cmd" &
    CHILD_PID=$!
    wait "$CHILD_PID"
}

# Auto-restart loop
run_with_restart() {
    local backoff=1
    local restarts=0

    while true; do
        local cmd
        cmd="$(build_cmd)"

        if [ "$restarts" -eq 0 ]; then
            printf "\n"
            ok "════════════════════════════════════════════════════"
            ok "  OpenClaw Gateway"
            ok "══════════════════════════��═════════════════════════"
            info "  Port:    $GATEWAY_PORT"
            info "  Bind:    $GATEWAY_BIND"
            info "  Mode:    $($DEV_MODE && echo 'development' || echo 'production')"
            info "  PID:     (starting...)"
            info "  Restart: auto (Ctrl+C to stop)"
            ok "���═══════════════════════════════════════════════════"
            printf "\n"
        else
            warn "Restarting gateway (attempt #$restarts, backoff ${backoff}s)..."
        fi

        eval "$cmd" &
        CHILD_PID=$!

        if [ "$restarts" -eq 0 ]; then
            info "Gateway started (PID $CHILD_PID)"
        fi

        wait "$CHILD_PID" 2>/dev/null
        EXIT_CODE=$?

        # If we got here via signal handler, just exit
        if [ $EXIT_CODE -eq 143 ] || [ $EXIT_CODE -eq 130 ]; then
            break
        fi

        CHILD_PID=""
        restarts=$((restarts + 1))

        if [ $EXIT_CODE -eq 0 ]; then
            info "Gateway exited cleanly."
            break
        fi

        warn "Gateway exited with code $EXIT_CODE"
        warn "Restarting in ${backoff}s... (Ctrl+C to stop)"
        sleep "$backoff"

        # Exponential backoff, capped
        backoff=$((backoff * 2))
        if [ "$backoff" -gt "$MAX_BACKOFF" ]; then
            backoff=$MAX_BACKOFF
        fi
    done
}

# Main
cd "$SCRIPT_DIR"

if $AUTO_RESTART; then
    run_with_restart
else
    run_once
fi
