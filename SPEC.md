# ai-hub 설계 명세서

> 워크스페이스 기반 멀티유저 Claude 분산 멀티 에이전트 오케스트레이션 시스템

---

## 0. 프로젝트 개요

ai-hub는 Claude Code CLI를 백엔드 런타임으로 사용하는 멀티 에이전트 오케스트레이션 대시보드다.

### 핵심 철학
- Anthropic API SDK를 직접 호출하지 않고, 호스트 머신의 `claude` 바이너리를 자식 프로세스로 spawn
- API 키 관리, 토큰 카운팅, 스트리밍 파싱, 컨텍스트 압축, 권한 시스템, MCP 연결을 Claude Code CLI에 위임
- Pro/Max 구독 한도를 추가 비용 없이 활용

### 워크스페이스 기반 멀티테넌시
- 사용자는 **워크스페이스**를 생성하거나 기존 워크스페이스에 가입
- 같은 워크스페이스에 속한 사용자들은 조직도, 에이전트, 미션 등 모든 데이터를 공유
- 워크스페이스가 다르면 데이터에 접근 불가
- 제품을 다운로드하고 워크스페이스 + 로그인 정보만 입력하면 바로 협업 가능

### 조직 계층 구조
```
Division (부문) → Department/Workspace (실) → Team (팀) → Part (파트) → Agent (에이전트)
```

---

## 1. 아키텍처 결정 (확정)

### 1.1 두 개의 서버

| 서버 | 역할 |
|------|------|
| **vm-server** | 공유 상태 관리 (Fastify + PostgreSQL) |
| **electron-app** | UI + Claude CLI 실행 (Electron + Next.js) |

```
[사용자 PC - Electron App]              [Server - vm-server]
  Electron main process            ◀──▶  Fastify API (port 4000)
  └── Next.js (localhost:3000)           └── PostgreSQL (공유 DB)
  └── Claude CLI spawn                   └── 조직도, Vault, 작업 큐
  └── 작업 큐 폴링                        └── 스케줄러, Fallback 데몬
```

### 1.2 워크스페이스 기반 멀티테넌시
- `organizations` 테이블이 워크스페이스(최상위 테넌트) 단위
- 사용자는 워크스페이스에 소속되어 역할(role)을 가짐
- 같은 워크스페이스에 속한 사용자는 조직도(divisions, workspaces, teams, agents)를 공유
- 개인 데이터(chat_logs, notifications, missions)는 user_id로 격리
- 로그인 흐름: **워크스페이스 입력 → 로그인/회원가입**

### 1.3 실행 분리 원칙
```
실행은 분산 (각 사용자 PC) + 상태는 중앙 (Server)
```

| 구분 | 인터랙티브 작업 | 스케줄링 작업 |
|------|----------------|--------------|
| 트리거 | 사용자 채팅 | cron / webhook |
| 실행 위치 | 사용자 PC (Electron) | Fallback 데몬 (Server) |
| 인증 수단 | 본인 Claude Pro/Max | Anthropic API 키 (봇) |
| Claude 방식 | CLI spawn | Agent SDK |

### 1.4 작업 큐 Pull 방식
- 데몬이 중앙 서버 큐를 폴링하여 작업을 가져감

---

## 2. 현재 구현 상태 (P0 완료)

### 2.1 프로젝트 구조
```
ai-hub/
  packages/
    vm-server/                # 중앙 API 서버
      src/
        db/
          schema.ts           # 전체 DB 스키마 (organizations ~ audit_logs)
          auth.ts             # 세션 검증 미들웨어
        routes/
          auth.ts             # 인증 (signup, signin, signout, me) — 워크스페이스 필수
          orgs.ts             # 조직 관리 + 멤버십
          divisions.ts        # 부문 CRUD + reorder
          workspaces.ts       # 실 CRUD + reorder
          teams.ts            # 팀 CRUD + 팀 멤버 관리
          parts.ts            # 파트 CRUD + reorder
          agents.ts           # 에이전트 CRUD
          hosts.ts            # 호스트 등록 + heartbeat
          tasks.ts            # 작업 큐 (poll 포함)
          vaults.ts           # Vault + envelope encryption
          audit.ts            # Audit log 조회
        index.ts              # Fastify 서버 진입점 (port 4000)
    electron-app/             # 사용자 PC에 설치되는 앱
      electron/
        main.js               # Electron main process + 시스템 트레이
      src/
        lib/
          vm-proxy.ts         # Next.js → vm-server 프록시 유틸
          vm-client.ts        # vm-server API 클라이언트 (타입 포함)
          auth.ts             # vm_session 쿠키 기반 인증
          db.ts               # 로컬 SQLite (개인 데이터만)
        app/api/
          auth/               # vm-server 프록시
          divisions/          # vm-server 프록시
          workspaces/         # vm-server 프록시
          teams/              # vm-server 프록시
          parts/              # vm-server 프록시
          agents/             # vm-server 프록시
          missions/           # 로컬 실행 (Claude CLI)
          chat/               # 로컬 실행
  package.json                # pnpm workspaces 루트
```

### 2.2 인증 흐름
```
사용자가 워크스페이스 slug 입력
→ 로그인/회원가입 (username + password)
→ electron-app /api/auth/signin
→ vm-server /api/auth/signin (프록시) — 워크스페이스 멤버십 확인
→ vm-server가 session 쿠키 발급 (org_id 포함)
→ electron-app이 vm_session 쿠키로 중계
→ 이후 모든 API 요청: 세션의 org_id 기준으로 데이터 접근
```

### 2.3 vm-server DB 스키마 (주요 테이블)

```
organizations       -- 워크스페이스 (org_id가 모든 공유 데이터의 키)
org_members         -- user ↔ 워크스페이스 역할 매핑 (org_admin | team_admin | member)
divisions           -- 부문 (org_id 기준 공유)
workspaces          -- 실 (org_id 기준 공유)
teams               -- 팀 + team_members
parts               -- 파트
agents              -- 에이전트
hosts               -- 사용자 PC 데몬 등록 + heartbeat
tasks               -- 작업 큐 (trigger_type, preferred_host_id 포함)
missions            -- 미션 (vm에 메타만, 실행은 electron-app)
mission_jobs        -- 미션 잡
vaults              -- Vault (org | team | personal_meta)
vault_secrets       -- envelope encryption된 시크릿
workspace_vaults    -- 워크스페이스 ↔ Vault 매핑
audit_logs          -- 전체 액션 이력
schedules           -- cron 스케줄
notifications       -- 개인 알림
chat_logs           -- 개인 대화 기록 (user_id 기준)
```

### 2.4 Vault Envelope Encryption
```
KEK (환경변수 VAULT_MASTER_KEY, DB에 저장 안 함)
  └── DEK (시크릿마다 랜덤 생성, AES-256-GCM으로 시크릿 암호화)
        └── DB 저장: encrypted_value + encrypted_dek + iv + auth_tag
```

---

## 3. Vault 스코프

| 스코프 | 저장 위치 | 예시 |
|--------|----------|------|
| org | vm-server DB (암호화) | 인스타 계정, POD API 키 |
| team | vm-server DB (암호화) | 개발팀 GitHub 봇, Figma 토큰 |
| personal | vm-server DB (암호화) | 본인 GitHub PAT, SSH 키 |

---

## 4. RBAC 역할

| 역할 | 권한 |
|------|------|
| org_admin | 모든 자원 접근, Vault 관리, 멤버 관리 |
| team_admin | 자기 팀 Vault/워크스페이스 관리 |
| member | 작업 트리거, 팀 Vault 메타 읽기, personal Vault 관리 |
| workspace_owner | 자기 워크스페이스 설정 변경, Vault attach |

---

## 5. 단계별 구현 로드맵

### ✅ P0 — 아키텍처 결정 + 기반 구조 (완료)
- 모노레포 구조 (pnpm workspaces)
- vm-server: Fastify + 전체 DB 스키마 + 기본 API 라우트
- electron-app: Electron 래퍼 + Next.js 프록시 전환
- 로컬 DB 경량화 (개인 데이터만)
- 워크스페이스 기반 로그인/회원가입 흐름

### 🔲 Phase 1 — MVP (1인 환경 검증)
- [ ] 작업 큐 API 완성 (trigger_type, deadline, retry_policy 동작 검증)
- [ ] 호스트 등록 + heartbeat 실제 동작 (electron-app 데몬에서 30초 주기 ping)
- [ ] electron-app에서 vm-server 폴링 → Claude CLI spawn → 결과 push 흐름
- [ ] vm-server Docker compose 설정
- [ ] `.env` 설정 가이드 문서화

### 🔲 Phase 2 — 멀티유저 + Vault UI
- [ ] RBAC 미들웨어 완성 (현재 role 체크 일부만 구현)
- [ ] Vault 관리 UI (org/team Vault 화면)
- [ ] 호스트 상태 대시보드 (idle/busy/offline 실시간 표시)
- [ ] Audit log UI (Settings → Audit Log)
- [ ] 팀 멤버십 UI

### 🔲 Phase 3 — Fallback 데몬 + 스케줄러
- [ ] Fallback 데몬 (Anthropic API + Agent SDK 기반, Claude CLI X)
- [ ] trigger_type 라우팅 (interactive → 사용자 PC, scheduled → fallback)
- [ ] cron 스케줄러 (schedules 테이블 기반)
- [ ] 외부 webhook 수신 엔드포인트

### 🔲 Phase 4 — 운영 안정화
- [ ] Vault 만료 알림
- [ ] 자동 백업 + 복원 런북
- [ ] Electron 트레이 앱 고도화
- [ ] 관찰성 대시보드 (토큰 사용량, 작업 처리량)

---

## 6. 미결정 사항

- 스케줄러 UI에서 cron 표현식 비개발자 노출 방식
- 외부 webhook 인증 방식 (HMAC 서명 vs IP 화이트리스트)
- 작업 결과물 저장 위치 (자체 Gitea vs 파일 스토리지)
- 데몬과 fallback의 공통 라이브러리 분리 전략

---

## 7. 환경변수

### vm-server `.env`
```env
PORT=4000
HOST=0.0.0.0
ALLOWED_ORIGINS=http://localhost:3000
COOKIE_SECRET=<랜덤 32자>
VAULT_MASTER_KEY=<32바이트 hex, node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
DATA_DIR=./.data
```

### electron-app `.env`
```env
VM_SERVER_URL=http://<SERVER_IP>:4000
PORT=3000
```

---

## 8. 핵심 원칙

1. 실행은 분산, 상태는 중앙
2. 인터랙티브 작업 → 본인 PC + 본인 Claude 구독 / 스케줄링 작업 → Fallback + API 키
3. 시크릿은 Vault 추상화로 묶이며 스코프(org/team/personal)에 따라 관리
4. 작업 큐는 Pull 방식
5. Audit log는 1일차부터 포함
6. 권한 모델은 처음부터 4역할로 세분화
7. Electron은 서버 실행 + 트레이 역할만. 대시보드는 Electron 창으로 렌더링
8. Fallback 데몬은 Claude Code CLI가 아닌 Anthropic API + Agent SDK
9. 워크스페이스 단위로 데이터 격리 — 같은 워크스페이스 멤버만 데이터 접근 가능
10. 제품 다운로드 후 워크스페이스 + 로그인 정보만 입력하면 즉시 협업 가능
