/**
 * AI Hub 로컬 데몬
 * - vm-server에 호스트 등록
 * - 30초 heartbeat
 * - 5초마다 작업 큐 폴링
 * - Claude CLI로 작업 실행
 * - 결과 vm-server에 push
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const SESSION_FILE = path.join(DATA_DIR, 'daemon-session.json');

let hostId = null;
let sessionCookie = null;
let heartbeatTimer = null;
let pollTimer = null;
let isRunning = false;

// ─────────────────────────────────────────────────────
// 세션 읽기 (Next.js 로그인 후 파일에 저장된 vm_session)
// ─────────────────────────────────────────────────────
function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      sessionCookie = data.session || null;
      return !!sessionCookie;
    }
  } catch {}
  return false;
}

async function vmFetch(path, options = {}) {
  const { body, method = 'GET' } = options;
  try {
    const res = await fetch(`${VM_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(sessionCookie ? { Cookie: `session=${sessionCookie}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────
// 호스트 등록
// ─────────────────────────────────────────────────────
async function registerHost() {
  const name = `${os.hostname()}-${os.userInfo().username}`;
  const result = await vmFetch('/api/hosts/register', {
    method: 'POST',
    body: { name },
  });
  if (result?.id) {
    hostId = result.id;
    console.log(`[daemon] 호스트 등록 완료: ${hostId} (${name})`);
    return true;
  }
  console.warn('[daemon] 호스트 등록 실패 — vm-server 연결 확인 필요');
  return false;
}

// ─────────────────────────────────────────────────────
// Heartbeat
// ─────────────────────────────────────────────────────
async function sendHeartbeat() {
  if (!hostId) return;
  await vmFetch(`/api/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    body: { status: isRunning ? 'busy' : 'idle' },
  });
}

// ─────────────────────────────────────────────────────
// 작업 실행 (Claude CLI spawn)
// ─────────────────────────────────────────────────────
function runTask(task) {
  return new Promise((resolve) => {
    const { id, title, description, agent_id } = task;
    const prompt = description || title;

    // 작업 디렉토리: DATA_DIR/workspaces/<agent_id> 또는 fallback
    const cwd = path.join(DATA_DIR, 'workspaces', agent_id || 'default');
    if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

    const args = ['-p', prompt, '--output-format', 'text'];
    const timeout = 10 * 60 * 1000; // 10분

    execFile('claude', args, { cwd, encoding: 'utf8', timeout, env: { ...process.env } },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, result: stderr || err.message });
        } else {
          resolve({ ok: true, result: stdout.trim() });
        }
      }
    );
  });
}

// ─────────────────────────────────────────────────────
// 작업 큐 폴링
// ─────────────────────────────────────────────────────
async function pollTasks() {
  if (!hostId || !sessionCookie) return;

  const data = await vmFetch('/api/tasks/poll', {
    method: 'POST',
    body: { host_id: hostId, trigger_type: 'interactive' },
  });

  const task = data?.task;
  if (!task) return;

  console.log(`[daemon] 작업 수신: ${task.id} — ${task.title}`);
  isRunning = true;

  // running 상태로 변경
  await vmFetch('/api/tasks', {
    method: 'PATCH',
    body: { id: task.id, status: 'running' },
  });

  // Claude CLI 실행
  const { ok, result } = await runTask(task);

  // 결과 push
  await vmFetch('/api/tasks', {
    method: 'PATCH',
    body: {
      id: task.id,
      status: ok ? 'completed' : 'failed',
      result,
    },
  });

  console.log(`[daemon] 작업 완료: ${task.id} (${ok ? '성공' : '실패'})`);
  isRunning = false;
}

// ─────────────────────────────────────────────────────
// 데몬 시작 / 종료
// ─────────────────────────────────────────────────────
async function start() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // 세션 로드 재시도 (로그인 전에 데몬이 먼저 뜰 수 있음)
  let retries = 0;
  while (!loadSession() && retries < 10) {
    console.log(`[daemon] 세션 대기 중... (${retries + 1}/10)`);
    await new Promise(r => setTimeout(r, 3000));
    retries++;
  }

  if (!sessionCookie) {
    console.warn('[daemon] 세션 없음 — 로그인 후 자동 재시도');
    // 세션 파일 감시 후 재시작
    watchSessionFile();
    return;
  }

  const registered = await registerHost();
  if (!registered) {
    console.warn('[daemon] 30초 후 재시도');
    setTimeout(start, 30000);
    return;
  }

  // Heartbeat 30초 주기
  heartbeatTimer = setInterval(sendHeartbeat, 30 * 1000);

  // 폴링 5초 주기
  pollTimer = setInterval(pollTasks, 5 * 1000);

  console.log('[daemon] 시작 완료 — 작업 대기 중');
}

function stop() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (pollTimer)      { clearInterval(pollTimer);      pollTimer = null; }
  if (hostId) {
    vmFetch(`/api/hosts/${hostId}/heartbeat`, {
      method: 'POST',
      body: { status: 'offline' },
    }).catch(() => {});
  }
  console.log('[daemon] 종료');
}

// 세션 파일 생성 감지 → 자동 재시작
function watchSessionFile() {
  const dir = path.dirname(SESSION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const watcher = fs.watch(dir, (event, filename) => {
    if (filename === path.basename(SESSION_FILE) && fs.existsSync(SESSION_FILE)) {
      watcher.close();
      console.log('[daemon] 세션 감지 — 데몬 재시작');
      start();
    }
  });
}

module.exports = { start, stop };
