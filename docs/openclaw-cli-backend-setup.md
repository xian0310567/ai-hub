# OpenClaw Claude CLI 백엔드 설정 기능 명세서

> **목적**: AI Hub에서 OpenClaw을 Claude CLI(c3) 백엔드로 구동하도록 설정하는 기능을 구현한다.
> API 키 없이, c3 구독 인증만으로 OpenClaw의 모든 기능(크론, 채널, 에이전트)을 사용한다.
>
> **작성일**: 2026-04-11

---

## 1. 배경과 동기

### 1.1 현재 문제

OpenClaw 게이트웨이는 `--allow-unconfigured` 플래그로 프로세스만 띄워져 있다.

```
현재: openclaw gateway run --allow-unconfigured
     → 프로세스는 살아있지만 AI 호출 불가
     → 설정 파일(openclaw.json) 없음
     → API 키 없음 → 에이전트 실행 불가
     → 크론/채널/세션 기능 전부 비활성
```

사실상 **빈 껍데기**가 돌고 있는 상태다.

### 1.2 해결 방향

OpenClaw은 `claude-cli` 백엔드를 정식 지원한다. 이를 활용하면:

```
목표: openclaw gateway run (정상 설정 파일로 기동)
     → claude-cli 백엔드 사용
     → c3의 로컬 인증(구독) 재사용 → API 키 불필요
     → 에이전트가 c3를 통해 AI 호출
     → 크론/채널/세션 기능 모두 활성화
```

**핵심: Anthropic API 키 없이, Claude Code 구독만으로 OpenClaw 전체 기능 사용 가능**

### 1.3 이 기능이 오케스트레이터의 전제 조건인 이유

`docs/orchestrator-design.md`에서 설계한 미션 오케스트레이터는 OpenClaw의 크론, 채널, 에이전트 기능에 의존한다.
하지만 현재 OpenClaw이 제대로 설정되지 않았으므로 오케스트레이터를 구현해도 실행할 수 없다.
**이 설정 기능이 오케스트레이터 구현의 Phase 0**이다.

---

## 2. OpenClaw의 Claude CLI 백엔드 이해

### 2.1 작동 원리

```
사용자 → AI Hub → OpenClaw Gateway (localhost:18789)
                       ↓
                  에이전트 런타임
                       ↓
                  claude CLI 프로세스 spawn
                       ↓
                  c3가 자체 인증으로 Anthropic API 호출
                       ↓
                  결과를 JSONL 스트림으로 반환
```

OpenClaw은 직접 API를 호출하지 않고, `claude` 바이너리를 자식 프로세스로 실행한다.
c3는 자체 OAuth/구독 인증을 사용하므로 `ANTHROPIC_API_KEY`가 필요 없다.

### 2.2 OpenClaw이 c3를 호출할 때 사용하는 인자

`extensions/anthropic/cli-backend.ts`에 정의된 하드코딩 설정:

```typescript
{
  id: "claude-cli",
  config: {
    command: "claude",                    // PATH에서 찾음
    args: [
      "-p",                               // pipe mode (비대화형)
      "--output-format", "stream-json",   // JSONL 스트림 출력
      "--include-partial-messages",       // 부분 응답 포함
      "--verbose",                        // 디버그 로그
      "--setting-sources", "user",        // 사용자 설정 사용
      "--permission-mode", "bypassPermissions", // 권한 확인 건너뜀
    ],
    output: "jsonl",
    input: "stdin",                       // 프롬프트를 stdin으로 전달
    modelArg: "--model",
    sessionArg: "--session-id",
    sessionMode: "always",                // 항상 세션 유지
    serialize: true,                      // 동시 실행 방지
  },
  bundleMcp: true,                        // OpenClaw 도구를 MCP로 c3에 전달
  bundleMcpMode: "claude-config-file",
}
```

### 2.3 사용 가능한 모델 ID

| 모델 참조 | CLI에서 사용하는 별칭 |
|-----------|---------------------|
| `claude-cli/claude-sonnet-4-6` | `sonnet` |
| `claude-cli/claude-opus-4-6` | `opus` |
| `claude-cli/claude-haiku-4-5` | `haiku` |
| `claude-cli/claude-sonnet-4-5` | `sonnet` |
| `claude-cli/claude-opus-4-5` | `opus` |

### 2.4 최소 필요 설정 (`openclaw.json`)

```json
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "auth": {
      "mode": "none"
    }
  },
  "agents": {
    "defaults": {
      "model": "claude-cli/claude-sonnet-4-6"
    }
  }
}
```

이것만 있으면 된다. API 키도 채널 토큰도 필요 없다.

---

## 3. 현재 AI Hub의 설정 시스템 분석

### 3.1 설정 저장소

| 요소 | 현재 상태 |
|------|----------|
| **DB 테이블** | `settings(key TEXT PK, value TEXT NOT NULL)` |
| **허용 키** | `gateway_auto_start` 1개뿐 |
| **API 엔드포인트** | `GET/POST /api/settings` (화이트리스트 방식) |
| **UI** | 설정 페이지에 6개 탭 (Hosts, Audit, Team, Org, Backup, MCP) |

### 3.2 게이트웨이 관리자

`gateway-manager.ts`가 OpenClaw 프로세스를 관리:

```typescript
// 현재 기동 명령
spawn(binary, [
  'gateway', 'run',
  '--bind', 'loopback',
  '--port', '18789',
  '--force',
  '--allow-unconfigured',  // ← 이게 문제. 설정 없이 기동
], {
  env: {
    PATH, HOME, ANTHROPIC_API_KEY,  // ← API 키가 있어도 전달만 할 뿐
    // openclaw.json은 없으니 실제로 에이전트 실행 불가
  }
});
```

### 3.3 설정 변경을 위한 두 가지 경로

OpenClaw 설정을 변경하는 방법은 2가지:

| 방법 | 장점 | 단점 |
|------|------|------|
| **A. 파일 직접 생성** (`~/.openclaw/openclaw.json`) | 게이트웨이 미실행 시에도 가능 | 파일 I/O, 경로 해석 필요 |
| **B. 게이트웨이 HTTP API** (`POST /v1/config/set`) | 유효성 검사 내장, 핫 리로드 | 게이트웨이가 실행 중이어야 함 |

**채택: A + B 복합 방식**
- 최초 설정: 파일 직접 생성 (게이트웨이가 아직 안 떠 있으므로)
- 이후 변경: 게이트웨이 HTTP API 사용 (유효성 검사 + 핫 리로드)

---

## 4. 구현 설계

### 4.1 전체 흐름

```
┌─────────────────────────────────────────────────────────────────┐
│ 사용자가 설정 페이지에서 "OpenClaw 설정" 탭 진입                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ① c3 사용 가능 여부 확인                                        │
│     └→ `which claude` 또는 `claude --version` 실행               │
│     └→ 불가 시: "Claude Code CLI가 설치되어 있지 않습니다" 안내     │
│                                                                 │
│  ② 현재 OpenClaw 설정 상태 표시                                   │
│     └→ openclaw.json 존재 여부                                   │
│     └→ 현재 모델 설정                                            │
│     └→ 게이트웨이 연결 상태                                       │
│                                                                 │
│  ③ 모델 선택                                                     │
│     └→ claude-cli/claude-sonnet-4-6 (기본값, 권장)               │
│     └→ claude-cli/claude-opus-4-6                                │
│     └→ claude-cli/claude-haiku-4-5                               │
│                                                                 │
│  ④ "설정 적용" 버튼                                               │
│     └→ openclaw.json 생성/업데이트                               │
│     └→ 게이트웨이 재시작                                          │
│     └→ 헬스체크로 정상 기동 확인                                   │
│                                                                 │
│  ⑤ 설정 완료 후 상태 표시                                         │
│     └→ "OpenClaw이 Claude CLI 백엔드로 정상 작동 중입니다"         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 파일 변경 목록

```
packages/electron-app/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── settings/
│   │   │   │   └── route.ts                  # [수정] ALLOWED_KEYS 확장
│   │   │   └── openclaw/
│   │   │       ├── config/
│   │   │       │   └── route.ts              # [신규] OpenClaw 설정 API
│   │   │       └── gateway/
│   │   │           └── route.ts              # [수정] 재시작 액션 추가
│   │   └── settings/
│   │       └── page.tsx                      # [수정] OpenClaw 탭 추가
│   └── lib/
│       ├── openclaw-config.ts                # [신규] openclaw.json 관리 모듈
│       └── gateway-manager.ts                # [수정] --allow-unconfigured 조건부
```

---

## 5. 상세 구현

### 5.1 `openclaw-config.ts` — 설정 파일 관리 모듈

```typescript
// packages/electron-app/src/lib/openclaw-config.ts

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

// ── 경로 해석 ────────────────────────────────────────────────────

const OPENCLAW_DIR = process.env.OPENCLAW_STATE_DIR
  || path.join(process.env.HOME || '', '.openclaw');
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH
  || path.join(OPENCLAW_DIR, 'openclaw.json');

// ── 타입 ─────────────────────────────────────────────────────────

export interface OpenClawConfig {
  gateway: {
    mode: 'local';
    port: number;
    bind: 'loopback' | 'lan';
    auth: { mode: 'none' };
  };
  agents: {
    defaults: {
      model: string;               // "claude-cli/claude-sonnet-4-6"
      cliBackends?: {
        'claude-cli'?: {
          command?: string;         // claude 바이너리 경로 (기본: "claude")
        };
      };
    };
  };
}

// 지원하는 모델 목록
export const SUPPORTED_MODELS = [
  { id: 'claude-cli/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: '빠르고 균형 잡힌 모델 (권장)', default: true },
  { id: 'claude-cli/claude-opus-4-6',   label: 'Claude Opus 4.6',   description: '최고 성능, 느린 속도' },
  { id: 'claude-cli/claude-haiku-4-5',  label: 'Claude Haiku 4.5',  description: '빠른 응답, 가벼운 작업용' },
] as const;

export const DEFAULT_MODEL = 'claude-cli/claude-sonnet-4-6';

// ── 설정 파일 관리 ───────────────────────────────────────────────

/** 현재 openclaw.json 읽기. 없으면 null */
export function readConfig(): OpenClawConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** openclaw.json 생성/덮어쓰기 */
export function writeConfig(config: OpenClawConfig): void {
  mkdirSync(OPENCLAW_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** 기본 설정 생성 (claude-cli 백엔드, 지정 모델) */
export function buildDefaultConfig(model?: string, claudePath?: string): OpenClawConfig {
  const config: OpenClawConfig = {
    gateway: {
      mode: 'local',
      port: parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10),
      bind: 'loopback',
      auth: { mode: 'none' },
    },
    agents: {
      defaults: {
        model: model || DEFAULT_MODEL,
      },
    },
  };

  // claude 바이너리가 PATH에 없는 경우 명시적 경로 설정
  if (claudePath && claudePath !== 'claude') {
    config.agents.defaults.cliBackends = {
      'claude-cli': { command: claudePath },
    };
  }

  return config;
}

// ── Claude CLI 확인 ──────────────────────────────────────────────

export interface ClaudeCliStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  error?: string;
}

/** c3(claude CLI)가 설치되어 있는지 확인 */
export function checkClaudeCli(): ClaudeCliStatus {
  try {
    const bin = execSync('which claude', { encoding: 'utf8', timeout: 5000 }).trim();
    if (!bin) return { available: false, path: null, version: null, error: 'claude not in PATH' };

    let version: string | null = null;
    try {
      version = execSync('claude --version', { encoding: 'utf8', timeout: 5000 }).trim();
    } catch {}

    return { available: true, path: bin, version };
  } catch {
    return { available: false, path: null, version: null, error: 'claude CLI를 찾을 수 없습니다' };
  }
}

// ── 종합 상태 ────────────────────────────────────────────────────

export interface OpenClawSetupStatus {
  configExists: boolean;
  configPath: string;
  currentModel: string | null;
  claudeCli: ClaudeCliStatus;
  isConfigured: boolean;        // claude-cli 백엔드로 설정 완료 여부
}

export function getSetupStatus(): OpenClawSetupStatus {
  const config = readConfig();
  const claudeCli = checkClaudeCli();
  const currentModel = config?.agents?.defaults?.model ?? null;
  const isConfigured = !!(
    config
    && config.gateway?.mode === 'local'
    && currentModel?.startsWith('claude-cli/')
    && claudeCli.available
  );

  return {
    configExists: config !== null,
    configPath: CONFIG_PATH,
    currentModel,
    claudeCli,
    isConfigured,
  };
}
```

### 5.2 `api/openclaw/config/route.ts` — 설정 API

```typescript
// packages/electron-app/src/app/api/openclaw/config/route.ts

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import {
  getSetupStatus,
  readConfig,
  writeConfig,
  buildDefaultConfig,
  SUPPORTED_MODELS,
} from '@/lib/openclaw-config';

/**
 * GET /api/openclaw/config — 현재 설정 상태 조회
 */
export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const status = getSetupStatus();
  return Response.json({
    ok: true,
    status,
    supportedModels: SUPPORTED_MODELS,
  });
}

/**
 * POST /api/openclaw/config — 설정 적용
 *
 * Body: { model?: string }
 *
 * 1. openclaw.json 생성
 * 2. 게이트웨이 재시작 (설정 반영)
 */
export async function POST(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  try {
    const { model } = await req.json();

    // 모델 유효성 검사
    const validModels = SUPPORTED_MODELS.map(m => m.id);
    if (model && !validModels.includes(model)) {
      return Response.json({
        ok: false,
        error: `지원하지 않는 모델: ${model}`,
      }, { status: 400 });
    }

    // Claude CLI 사용 가능 확인
    const { checkClaudeCli } = await import('@/lib/openclaw-config');
    const cliStatus = checkClaudeCli();
    if (!cliStatus.available) {
      return Response.json({
        ok: false,
        error: 'Claude Code CLI가 설치되어 있지 않습니다. `claude` 명령어가 PATH에 있는지 확인하세요.',
      }, { status: 400 });
    }

    // 설정 파일 생성
    const config = buildDefaultConfig(model, cliStatus.path ?? undefined);
    writeConfig(config);

    // 게이트웨이 재시작
    const { stopGateway, startGateway } = await import('@/lib/gateway-manager');
    stopGateway();

    // 잠시 대기 후 재시작 (프로세스 정리 시간)
    await new Promise(r => setTimeout(r, 1000));
    const result = await startGateway(true);

    return Response.json({
      ok: true,
      config: {
        model: config.agents.defaults.model,
        gatewayMode: config.gateway.mode,
        gatewayPort: config.gateway.port,
      },
      gateway: {
        restarted: true,
        running: result.ok,
        reason: result.reason,
        detail: result.detail,
      },
    });
  } catch (err) {
    console.error('[POST /api/openclaw/config] 오류:', err);
    return Response.json({
      ok: false,
      error: err instanceof Error ? err.message : '설정 적용 실패',
    }, { status: 500 });
  }
}
```

### 5.3 `gateway-manager.ts` 변경사항

```typescript
// 변경 1: --allow-unconfigured를 조건부로 적용

import { readConfig } from './openclaw-config';

export async function startGateway(manual = false) {
  // ... 기존 코드 ...

  const args = [
    'gateway', 'run',
    '--bind', GATEWAY_BIND,
    '--port', GATEWAY_PORT,
    '--force',
  ];

  // openclaw.json이 있으면 --allow-unconfigured 생략
  const config = readConfig();
  if (!config) {
    args.push('--allow-unconfigured');
  }

  if (configDir) args.push('--config', configDir);

  // ... 나머지 동일 ...
}
```

```typescript
// 변경 2: spawn 환경변수에서 ANTHROPIC_API_KEY 제거
// (claude-cli 백엔드는 자체 인증 사용, API 키 전달 불필요)

_process = spawn(binary, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // ANTHROPIC_API_KEY: 제거 — claude-cli 백엔드는 자체 인증 사용
    OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    OPENCLAW_CONFIG_DIR: process.env.OPENCLAW_CONFIG_DIR,
    DATA_DIR: process.env.DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
  },
});
```

### 5.4 `settings/page.tsx` — OpenClaw 설정 탭 추가

기존 설정 페이지의 탭 네비게이션에 "OpenClaw" 탭을 추가한다.

```tsx
// 탭 목록에 추가
const TABS = ['hosts', 'openclaw', 'audit', 'team', 'org', 'backup', 'mcp'] as const;

// OpenClaw 탭 컴포넌트
function OpenClawTab() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // 상태 조회
  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/openclaw/config');
    const d = await res.json();
    if (d.ok) {
      setStatus(d.status);
      setModels(d.supportedModels);
      setSelectedModel(d.status.currentModel || d.supportedModels[0]?.id || '');
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // 설정 적용
  const apply = async () => {
    setApplying(true);
    setResult(null);
    try {
      const res = await fetch('/api/openclaw/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel }),
      });
      const d = await res.json();
      if (d.ok) {
        setResult({ ok: true, message: '설정이 적용되었습니다.' });
        loadStatus();
      } else {
        setResult({ ok: false, message: d.error });
      }
    } catch (err) {
      setResult({ ok: false, message: '설정 적용 중 오류가 발생했습니다.' });
    }
    setApplying(false);
  };

  if (!status) return <div>로딩 중...</div>;

  return (
    <div>
      {/* 헤더 */}
      <div style={S.sec}>OpenClaw 설정</div>
      <div style={S.hint}>
        OpenClaw 게이트웨이가 Claude CLI를 백엔드로 사용하도록 설정합니다.
        API 키 없이 Claude Code 구독만으로 작동합니다.
      </div>

      {/* Claude CLI 상태 카드 */}
      <div style={S.card}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Claude CLI 상태
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              ...S.badge,
              background: status.claudeCli.available ? '#14ae5c20' : '#ef444420',
              color: status.claudeCli.available ? '#14ae5c' : '#ef4444',
            }}>
              {status.claudeCli.available ? '사용 가능' : '미설치'}
            </span>
            {status.claudeCli.version && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {status.claudeCli.version}
              </span>
            )}
          </div>
          {!status.claudeCli.available && (
            <div style={{
              marginTop: 12, padding: '10px 14px',
              background: 'var(--bg-canvas)', borderRadius: 6, fontSize: 12,
            }}>
              Claude Code CLI를 먼저 설치하세요:
              <code style={{
                display: 'block', marginTop: 8, padding: '8px 12px',
                background: 'var(--bg-elevated)', borderRadius: 4,
                fontFamily: 'monospace',
              }}>
                npm install -g @anthropic-ai/claude-code
              </code>
            </div>
          )}
        </div>
      </div>

      {/* 설정 상태 카드 */}
      <div style={S.card}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            설정 상태
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px 12px', fontSize: 13 }}>
            <span style={{ color: 'var(--text-muted)' }}>설정 파일</span>
            <span>{status.configExists ? '✓ 존재' : '✗ 없음'}</span>
            <span style={{ color: 'var(--text-muted)' }}>경로</span>
            <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{status.configPath}</span>
            <span style={{ color: 'var(--text-muted)' }}>현재 모델</span>
            <span>{status.currentModel || '(미설정)'}</span>
            <span style={{ color: 'var(--text-muted)' }}>설정 완료</span>
            <span style={{
              color: status.isConfigured ? '#14ae5c' : 'var(--text-muted)'
            }}>
              {status.isConfigured ? '✓ 정상 구성됨' : '✗ 설정 필요'}
            </span>
          </div>
        </div>
      </div>

      {/* 모델 선택 카드 */}
      {status.claudeCli.available && (
        <div style={S.card}>
          <div style={{ padding: '16px 20px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
              기본 모델 선택
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {models.map(m => (
                <label key={m.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 14px', borderRadius: 6, cursor: 'pointer',
                  border: selectedModel === m.id
                    ? '2px solid var(--accent)'
                    : '1px solid var(--border)',
                  background: selectedModel === m.id
                    ? 'var(--accent-subtle)'
                    : 'var(--bg-canvas)',
                }}>
                  <input
                    type="radio"
                    name="model"
                    value={m.id}
                    checked={selectedModel === m.id}
                    onChange={() => setSelectedModel(m.id)}
                  />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {m.label}
                      {m.default && (
                        <span style={{
                          ...S.badge, marginLeft: 8,
                          background: 'var(--accent)', color: '#fff', fontSize: 10,
                        }}>권장</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                      {m.description}
                    </div>
                  </div>
                </label>
              ))}
            </div>

            {/* 적용 버튼 */}
            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                style={{ ...S.btn, opacity: applying ? 0.6 : 1 }}
                onClick={apply}
                disabled={applying}
              >
                {applying ? '적용 중...' : '설정 적용'}
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                적용 시 게이트웨이가 자동으로 재시작됩니다
              </span>
            </div>

            {/* 결과 메시지 */}
            {result && (
              <div style={{
                marginTop: 12, padding: '10px 14px', borderRadius: 6,
                background: result.ok ? '#14ae5c15' : '#ef444415',
                color: result.ok ? '#14ae5c' : '#ef4444',
                fontSize: 13,
              }}>
                {result.message}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## 6. 구현 단계

### Phase 1: 설정 인프라 (파일 3개 변경/추가)

| 순서 | 작업 | 파일 |
|------|------|------|
| 1-1 | `openclaw-config.ts` 모듈 생성 | `src/lib/openclaw-config.ts` |
| 1-2 | 설정 API 라우트 생성 | `src/app/api/openclaw/config/route.ts` |
| 1-3 | `gateway-manager.ts`에서 `--allow-unconfigured` 조건부 적용 | `src/lib/gateway-manager.ts` |

### Phase 2: 설정 UI (파일 1개 수정)

| 순서 | 작업 | 파일 |
|------|------|------|
| 2-1 | 설정 페이지에 OpenClaw 탭 추가 | `src/app/settings/page.tsx` |
| 2-2 | 탭 네비게이션에 "OpenClaw" 항목 추가 | 위와 동일 |

### Phase 3: 연동 보강 (파일 2개 수정)

| 순서 | 작업 | 파일 |
|------|------|------|
| 3-1 | `OpenClawStatus.tsx` 팝오버에 설정 미완료 안내 추가 | `src/components/OpenClawStatus.tsx` |
| 3-2 | `gateway/route.ts`에 설정 상태 필드 추가 | `src/app/api/openclaw/gateway/route.ts` |

---

## 7. 주의사항

### 7.1 보안

- `openclaw.json`에 API 키를 넣지 않는다 (claude-cli 전용이므로 불필요)
- `gateway.auth.mode: "none"`은 loopback 바인딩(127.0.0.1)에서만 허용
- LAN 바인딩 시에는 토큰 인증 필수 → 현재 범위에서는 loopback만 지원

### 7.2 경로 호환성

- `OPENCLAW_STATE_DIR` 환경변수를 우선 사용
- 없으면 `~/.openclaw/` 기본 경로 사용
- 레거시 `~/.clawdbot/` 경로는 무시 (OpenClaw이 자체 마이그레이션 처리)

### 7.3 기존 설정 파일 존재 시

- 이미 `openclaw.json`이 있는 경우: 모델만 변경하고 나머지는 유지해야 한다
- 현재 설계는 **전체 덮어쓰기** → 향후 `readConfig()` 결과에 머지하도록 개선 필요
- Phase 1에서는 단순화를 위해 전체 덮어쓰기로 시작 (claude-cli 전용이므로 안전)

### 7.4 게이트웨이 재시작 타이밍

- 설정 적용 후 `stopGateway()` → 1초 대기 → `startGateway()` 순서
- 프로세스 종료에 시간이 걸릴 수 있으므로 1초 대기 삽입
- 게이트웨이가 `SIGTERM`을 받으면 graceful shutdown 수행 (내부적으로 ~2초)
- 재시작 실패 시에도 설정 파일은 이미 저장된 상태 → 수동 재시작 가능

### 7.5 c3 인증 상태

- c3가 PATH에 있더라도 **로그인되지 않은 상태**일 수 있다
- `claude --version`은 성공하지만 실제 AI 호출 시 인증 에러 발생 가능
- 이 문제는 Phase 1에서는 별도 처리하지 않고, 미션 실행 시 에러로 표시
- 향후 `claude auth status` 같은 명령으로 사전 확인 추가 고려

---

## 8. 기대 효과

### 설정 전 (현재)

```
사용자: "내일 아침 10시에 뉴스 분석해줘"
시스템: ❌ OpenClaw 설정 안됨 → Claude CLI 직접 호출
       → "스케줄을 설정할 수 없습니다"
```

### 설정 후

```
사용자: "내일 아침 10시에 뉴스 분석해줘"
시스템: ✅ OpenClaw(claude-cli 백엔드) → cron add
       → 다음날 10시에 자동 실행
       → 결과를 사용자에게 전달
```

### 오케스트레이터 연동

이 설정이 완료되면 `docs/orchestrator-design.md`의 Phase 1(라우팅 분석기)을
바로 구현할 수 있다:

```
미션 입력 → 오케스트레이터 분석 → capability_tags 생성
  ├→ [scheduling, channel_delivery] → OpenClaw (이제 정상 작동!)
  └→ [file_io, code_generation]     → c3 직접 실행 (기존 방식)
```

---

## 9. 파일 변경 요약

| 파일 | 작업 | 설명 |
|------|------|------|
| `src/lib/openclaw-config.ts` | **신규** | openclaw.json 읽기/쓰기, c3 확인, 상태 조회 |
| `src/app/api/openclaw/config/route.ts` | **신규** | 설정 조회/적용 API |
| `src/lib/gateway-manager.ts` | **수정** | `--allow-unconfigured` 조건부, env 정리 |
| `src/app/settings/page.tsx` | **수정** | OpenClaw 탭 추가 |
| `src/components/OpenClawStatus.tsx` | **수정** | 설정 미완료 안내 문구 |
| `src/app/api/openclaw/gateway/route.ts` | **수정** | 설정 상태 필드 추가 |

총 **2개 신규**, **4개 수정**
