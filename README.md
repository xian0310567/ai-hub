# AI Hub

AI company management dashboard with Claude harness-based multi-agent orchestration.

## Overview

A self-hosted dashboard for managing AI agent teams. Built with Next.js + Docker + Claude Code CLI.

- **Dashboard** (`/`) — Canvas-based monitoring & direct chat with team leaders
- **Org Management** (`/org`) — Create and manage the organization hierarchy

## Organization Structure

```
Division (부문)
  └─ Department (실)
       └─ Team (팀)
            └─ Part (파트)
                 └─ Agents (에이전트)
```

Each level has a **lead agent** you can chat with directly. Lead agents use Claude Code's native sub-agent spawning to delegate work down the hierarchy.

## How It Works

When you send a message to a team leader:

```
You → Team Lead → Sub-agents (via --allowedTools Task)
                       ├─ Agent A: handles design
                       ├─ Agent B: handles implementation
                       └─ Agent C: handles review
                                ↓
                     Team Lead aggregates results → You
```

Agent definitions are stored as `.claude/agents/*.md` files per workspace. The harness pattern (orchestrator, pipeline, scatter-gather, etc.) is baked into the lead agent's system prompt.

## Stack

- **Frontend**: Next.js 16 + TypeScript
- **Runtime**: `tsx server.ts` (not `next start`) for socket.io support
- **Database**: SQLite via `better-sqlite3`
- **AI**: Claude Code CLI (`claude -p` / `claude --continue --allowedTools Task`)
- **Container**: Docker + docker-compose

## Quick Start

### Prerequisites

- Docker & docker-compose
- Claude Code CLI installed and authenticated on the host machine (`claude login`)

### Run

```bash
git clone https://github.com/xian0310567/ai-hub
cd ai-hub

# Edit docker-compose.yml — update workspace paths to match your machine
docker-compose up -d
```

Open `http://localhost:3001`

### Claude Authentication

The container uses your host machine's Claude auth by mounting `~/.claude` and `~/.claude.json`:

```yaml
# docker-compose.yml
volumes:
  - ~/.claude:/root/.claude
  - ~/.claude.json:/root/.claude.json
```

If not authenticated, run inside the container:

```bash
docker exec -it ai-hub claude login
```

## Project Structure

```
hub/
├── src/
│   ├── app/
│   │   ├── page.tsx          # Dashboard (canvas + chat)
│   │   ├── org/page.tsx      # Org management
│   │   └── api/
│   │       ├── divisions/    # Division CRUD + reorder
│   │       ├── workspaces/   # Department CRUD
│   │       ├── teams/        # Team CRUD
│   │       ├── parts/        # Part CRUD
│   │       ├── agents/       # Agent CRUD + harness file generation
│   │       └── claude/       # Claude CLI streaming chat
│   └── lib/
│       ├── db.ts             # SQLite schema + helpers
│       └── sprites.ts        # Pixel art sprite renderer
├── server.ts                 # HTTP + socket.io server
├── Dockerfile
└── docker-compose.yml
```

## Harness Patterns

| Pattern | Description |
|---|---|
| Orchestrator | Lead delegates to sub-agents sequentially |
| Scatter-Gather | All sub-agents run in parallel, results merged |
| Pipeline | Data flows through agents in sequence |
| Worker Pool | Lead picks the best agent per task |
| Check-Fix | One agent works, another validates and requests fixes |
| Single | Agent handles everything directly |

## License

MIT
