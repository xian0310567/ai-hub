# AI Hub

AI 조직을 구성하고 Claude Code CLI를 활용해 멀티 에이전트 미션을 자동화하는 셀프호스팅 대시보드입니다.

---

## 목차

1. [개요](#개요)
2. [아키텍처](#아키텍처)
3. [주요 기능](#주요-기능)
4. [기술 스택](#기술-스택)
5. [빠른 시작 (Docker)](#빠른-시작-docker)
6. [개발 환경 설정](#개발-환경-설정)
7. [환경 변수](#환경-변수)
8. [프로젝트 구조](#프로젝트-구조)
9. [조직 구조](#조직-구조)
10. [미션 실행 흐름](#미션-실행-흐름)
11. [데이터베이스 스키마](#데이터베이스-스키마)
12. [라이선스](#라이선스)

---

## 개요

AI Hub는 **AI 에이전트 조직**을 생성하고 관리하며, 자연어 미션을 통해 여러 에이전트가 협력하여 업무를 수행하는 플랫폼입니다.

- 조직도(사업부 → 본부 → 팀 → 파트 → 에이전트)를 구성하고 각 에이전트에 **역할(Soul)** 과 **Claude 모델**을 부여합니다.
- 미션을 작성하면 AI가 조직도를 분석하여 **적합한 에이전트에게 서브태스크를 자동 배분**합니다.
- 에이전트들은 **Claude Code CLI**를 통해 실제 파일을 읽고 쓰며 코드를 실행합니다.
- 실행 중 에이전트 간 **공유 협업 보드**로 실시간 소통하고, 결과는 UI에 스트리밍됩니다.

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                         AI Hub Monorepo (pnpm)                  │
│                                                                 │
│  ┌──────────────────────────┐    ┌──────────────────────────┐  │
│  │     electron-app         │    │       vm-server           │  │
│  │    (Next.js 16 / :3000)  │◄──►│   (Fastify 5 / :4000)    │  │
│  │                          │    │                           │  │
│  │  • UI 대시보드             │    │  • 조직/에이전트 관리       │  │
│  │  • 미션 라우팅 분석         │    │  • 사용자 인증/세션         │  │
│  │  • Claude CLI 실행         │    │  • Vault 비밀 관리          │  │
│  │  • SQLite (로컬 상태)       │    │  • PostgreSQL (공유 데이터) │  │
│  │  • SSE 실시간 스트리밍      │    │  • 스케줄 / 태스크 큐       │  │
│  └──────────────────────────┘    └──────────────────────────┘  │
│             │                                                    │
│             ▼                                                    │
│   ┌─────────────────┐                                           │
│   │  Claude CLI 프로세스 (에이전트별 병렬 실행)                      │
│   │  claude -p "prompt" --allowedTools Edit,Write,Read,Bash     │
│   └─────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 주요 기능

### 🎯 미션 센터
- **자연어 미션 생성** — 업무를 설명하면 AI가 조직도를 분석해 에이전트별 서브태스크를 자동 배정
- **SSE 실시간 스트리밍** — 각 에이전트의 실행 진행 상황을 실시간으로 UI에 표시
- **협업 보드** — 모든 에이전트가 공유하는 Markdown 파일로 진행 상황 기록 및 소통
- **Human Gate** — 특정 단계에 사람 승인이 필요한 워크플로 설정
- **미션 재개** — 실패한 에이전트 잡만 선택적으로 다시 실행
- **품질 채점** — 완료된 잡에 대해 5개 차원(품질·완성도·정확도·신속성·협업) 자동 평가
- **이미지 첨부** — 미션에 참고 이미지 첨부 (클립보드 붙여넣기 / 드래그 앤 드롭)

### 🏢 조직 관리
- **계층적 조직도** — 사업부 → 본부 → 팀 → 파트 → 에이전트 5단계 구조
- **에이전트 설정** — Soul(시스템 프롬프트), Claude 모델, 워크스페이스, 이모지/색상 커스터마이즈
- **드래그 앤 드롭 재정렬** — 조직 내 순서 자유 조정
- **대시보드 캔버스** — 조직도 시각화 및 리드 에이전트와 직접 채팅

### 🔒 Vault (비밀 관리)
- **AES-256-GCM 봉투 암호화** — 마스터 키 → 금고 키 → 시크릿 3단 암호화
- **범위별 금고** — 조직(org), 팀(team), 개인(personal) 금고 분리
- **자동 주입** — 미션 실행 시 에이전트 프로세스에 시크릿을 환경변수로 자동 주입

### 🔌 MCP 서버
- Claude CLI에 외부 도구/데이터 소스 연결 설정
- 설정된 MCP 서버가 미션 실행 시 `--mcp-config`로 자동 전달

### 📅 스케줄 (반복 미션)
- **Cron 표현식** 기반 미션 자동화
- 서버 재시작 후에도 일정 유지

### 🏷️ 미션 템플릿
- 자주 사용하는 워크플로를 템플릿으로 저장 및 재사용
- 기본 제공(built-in) 템플릿 포함

---

## 기술 스택

| 분류 | 기술 | 버전 |
|------|------|------|
| **패키지 관리** | pnpm Workspaces | 10.30 |
| **UI 프레임워크** | Next.js + React | 16.2 / 19.2 |
| **백엔드 API** | Fastify | 5.3 |
| **데스크톱** | Electron | 35.1 |
| **로컬 DB** | SQLite (better-sqlite3) | 12.8 |
| **공유 DB** | PostgreSQL | 16+ |
| **AI 실행** | Claude Code CLI | latest |
| **AI SDK** | @anthropic-ai/sdk | 0.82 |
| **실시간** | SSE + socket.io | 4.8 |
| **타입** | TypeScript | 5 |
| **테스트** | Vitest + Playwright | 2.1 / 1.59 |
| **컨테이너** | Docker / docker-compose | - |

---

## 빠른 시작 (Docker)

### 사전 요구사항

- Docker & docker-compose 설치
- 호스트 머신에 [Claude Code CLI](https://claude.ai/code) 설치 및 로그인 (`claude login`)
- PostgreSQL 16+

### 실행

```bash
git clone https://github.com/xian0310567/ai-hub
cd ai-hub

# 환경 변수 설정 (아래 환경 변수 섹션 참조)
cp .env.example .env

docker-compose up -d
```

브라우저에서 `http://localhost:3001` 접속

### Claude 인증

컨테이너는 호스트의 Claude 인증 정보를 마운트합니다:

```yaml
# docker-compose.yml
volumes:
  - ~/.claude:/root/.claude
  - ~/.claude.json:/root/.claude.json
```

인증이 안 된 경우 컨테이너 안에서 실행:

```bash
docker exec -it ai-hub claude login
```

---

## 개발 환경 설정

### 1. 의존성 설치

```bash
pnpm install
```

### 2. PostgreSQL 실행

```bash
docker run -d \
  --name ai-hub-pg \
  -e POSTGRES_USER=aihub \
  -e POSTGRES_PASSWORD=aihub1234 \
  -e POSTGRES_DB=aihub \
  -p 5432:5432 \
  postgres:16-alpine
```

### 3. 환경 변수 설정

```bash
# vm-server
cp packages/vm-server/.env.example packages/vm-server/.env

# electron-app
cp packages/electron-app/.env.example packages/electron-app/.env.local
```

### 4. 개발 서버 시작

```bash
# vm-server + electron-app 동시 실행
pnpm dev

# 개별 실행
pnpm dev:vm   # vm-server (port 4000)
pnpm dev:app  # electron-app (port 3000)
```

### 5. 테스트

```bash
# 전체 테스트
pnpm test

# Playwright E2E 테스트 (electron-app)
cd packages/electron-app
./node_modules/.bin/playwright test
```

### 빌드

```bash
pnpm build:vm   # TypeScript → dist/
pnpm build:app  # Next.js + Electron 바이너리 생성
```

---

## 환경 변수

### `packages/vm-server/.env`

```env
PORT=4000
HOST=0.0.0.0
ALLOWED_ORIGINS=http://localhost:3000

# PostgreSQL
DATABASE_URL=postgres://aihub:aihub1234@localhost:5432/aihub

# 보안 (반드시 변경)
COOKIE_SECRET=change-me-in-production-32chars-random
VAULT_MASTER_KEY=<32바이트 hex — openssl rand -hex 32>

# 선택
ANTHROPIC_API_KEY=<폴백 데몬용, 미입력 시 비활성화>
DATA_DIR=./.data
WEBHOOK_SECRET=<외부 웹훅 서명 키>
```

> **VAULT_MASTER_KEY 생성**:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

### `packages/electron-app/.env.local`

```env
VM_SERVER_URL=http://localhost:4000
PORT=3000
# DATA_DIR=/custom/path/.data  # 기본값: ./.data
```

### 루트 `.env` (Docker용)

```env
PORT=3001        # 외부 포트
# CLAUDE_DIR=~/.claude  # Claude 설정 디렉터리 (기본값 자동 감지)
```

---

## 프로젝트 구조

```
ai-hub/
├── packages/
│   ├── electron-app/                  # 사용자 앱 (Next.js + Electron)
│   │   ├── electron/
│   │   │   ├── main.js                # Electron 진입점 (BrowserWindow, tray)
│   │   │   └── daemon.js              # 백그라운드 데몬 (인증, 하트비트)
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── page.tsx           # 대시보드 (캔버스 + 채팅)
│   │   │   │   ├── org/               # 조직 관리 UI
│   │   │   │   ├── missions/          # 미션 센터 UI
│   │   │   │   ├── schedules/         # 스케줄 관리 UI
│   │   │   │   ├── tasks/             # 태스크 큐 UI
│   │   │   │   ├── settings/          # 설정 (MCP, 인증 상태)
│   │   │   │   ├── vault/             # Vault 관리 UI
│   │   │   │   └── api/
│   │   │   │       ├── auth/          # 인증 (signin, signout, me)
│   │   │   │       ├── missions/      # 미션 CRUD + run/resume/status
│   │   │   │       ├── templates/     # 미션 템플릿
│   │   │   │       ├── schedules/     # 반복 스케줄
│   │   │   │       ├── mcp-configs/   # MCP 서버 설정
│   │   │   │       ├── vaults/        # Vault + 시크릿
│   │   │   │       └── claude/        # Claude CLI 스트리밍 채팅
│   │   │   └── lib/
│   │   │       ├── db.ts              # SQLite 스키마 + 헬퍼
│   │   │       ├── mission-runner.ts  # 백그라운드 미션 실행 (스케줄러용)
│   │   │       ├── quality-scorer.ts  # 잡 결과 품질 채점
│   │   │       ├── personal-vault.ts  # OS 키체인 연동
│   │   │       ├── auth.ts            # 세션 유틸
│   │   │       └── vm-proxy.ts        # vm-server 프록시
│   │   └── server.ts                  # socket.io + 스케줄러 + 타임아웃 감시
│   │
│   └── vm-server/                     # 중앙 백엔드 (Fastify + PostgreSQL)
│       └── src/
│           ├── index.ts               # 서버 진입점
│           ├── db/
│           │   ├── schema.ts          # PostgreSQL DDL (테이블 정의)
│           │   └── index.ts           # 연결 풀 + 쿼리 래퍼
│           ├── routes/
│           │   ├── auth.ts            # 인증 (세션 쿠키)
│           │   ├── divisions.ts       # 사업부 CRUD
│           │   ├── workspaces.ts      # 본부/워크스페이스 CRUD
│           │   ├── teams.ts           # 팀 CRUD
│           │   ├── parts.ts           # 파트 CRUD
│           │   ├── agents.ts          # 에이전트 CRUD
│           │   ├── tasks.ts           # 태스크 큐 (poll / SKIP LOCKED)
│           │   ├── vaults.ts          # Vault + 봉투 암호화
│           │   ├── hosts.ts           # 호스트 등록 + 하트비트
│           │   ├── audit.ts           # 감사 로그
│           │   └── webhooks.ts        # 외부 웹훅 수신
│           └── workers/
│               ├── scheduler.ts       # Cron 스케줄러 데몬
│               ├── fallback.ts        # Anthropic SDK 폴백 실행 데몬
│               └── pg-backup.ts       # PostgreSQL 백업 데몬
│
├── Dockerfile
├── docker-compose.yml
└── pnpm-workspace.yaml
```

---

## 조직 구조

```
사업부 (Division)
  └─ 본부/워크스페이스 (Department / Workspace)
       └─ 팀 (Team)
            └─ 파트 (Part)
                 └─ 에이전트 (Agent)
```

각 단계는 **리드 에이전트**를 가질 수 있으며, 에이전트마다 아래 속성을 설정합니다:

| 속성 | 설명 |
|------|------|
| **Soul** | 에이전트의 역할/성격을 정의하는 시스템 프롬프트 |
| **Model** | 사용할 Claude 모델 (기본값: 계정 기본 모델) |
| **Workspace** | 에이전트가 작업할 디렉터리 경로 |
| **org_level** | `division` / `department` / `team` / `part` / `agent` |

---

## 미션 실행 흐름

```
① 사용자가 자연어로 미션 작성
      ↓
② Claude가 조직도를 분석해 라우팅 생성
   (어떤 조직/에이전트가 어떤 서브태스크를 담당할지 결정)
      ↓
③ 사용자가 라우팅 확인 후 "미션 실행"
      ↓
④ 각 에이전트에 대해 mission_job 생성 (SQLite 큐)
      ↓
⑤ 에이전트별 병렬 실행 (에이전트별 순차 큐 보장)
   ┌─ 에이전트 A ─────────────────────────────────────────┐
   │  • 큐 대기 (다른 미션과 순서 조율)                       │
   │  • (Human Gate 설정 시) 사람 승인 대기                   │
   │  • 협업 보드 읽기 → 다른 에이전트 진행 상황 파악             │
   │  • claude -p "[soul + 미션 + 서브태스크 + 보드 경로]"     │
   │           --allowedTools Edit,Write,Read,Bash          │
   │           --mcp-config [MCP 설정 파일]                   │
   │  • 협업 보드에 완료 결과 기록                              │
   └──────────────────────────────────────────────────────┘
      ↓
⑥ 모든 잡 완료 → Claude가 결과 통합 → 최종 보고서 생성
      ↓
⑦ SSE를 통해 UI에 실시간 반영
```

### 협업 보드

미션 시작 시 `DATA_DIR/boards/mission-{id}.md` 파일이 생성됩니다.  
에이전트들은 작업 시작 전 보드를 읽어 맥락을 파악하고, 완료 후 결과를 기록합니다.  
SSE `board_update` 이벤트로 4초 간격 UI에 실시간 반영됩니다.

---

## 데이터베이스 스키마

### electron-app (SQLite)

| 테이블 | 설명 |
|--------|------|
| `settings` | 앱 설정 (키-값) |
| `chat_logs` | 에이전트와의 채팅 기록 |
| `notifications` | 사용자 알림 |
| `missions` | 미션 (상태, 라우팅, 단계, 최종 보고서) |
| `mission_jobs` | 미션 잡 큐 (에이전트별 실행 단위) |
| `mission_templates` | 재사용 가능한 워크플로 템플릿 |
| `mcp_server_configs` | MCP 서버 설정 |
| `mission_schedules` | Cron 반복 미션 스케줄 |

### vm-server (PostgreSQL)

| 테이블 | 설명 |
|--------|------|
| `users` | 사용자 계정 |
| `sessions` | 세션 토큰 |
| `organizations` | 테넌트 조직 |
| `divisions` | 사업부 |
| `workspaces` | 본부/워크스페이스 |
| `teams` | 팀 |
| `parts` | 파트 |
| `agents` | AI 에이전트 (soul, model, org_level) |
| `tasks` | 태스크 큐 (pull-based, SKIP LOCKED) |
| `hosts` | 등록된 electron-app 인스턴스 |
| `vaults` | 비밀 금고 |
| `vault_secrets` | 암호화된 시크릿 (AES-256-GCM 봉투 암호화) |
| `schedules` | Cron 스케줄 |
| `audit_logs` | 감사 로그 |

---

## 라이선스

MIT
