/**
 * AI Hub 로컬 데몬
 * - vm-server에 호스트 등록 + heartbeat
 * - 5초마다 작업 큐 폴링
 * - Claude CLI로 작업 실행 (Personal Vault 환경변수 주입)
 * - Vault 만료 알림 (7일/3일/당일, Electron Notification + 로컬 DB)
 */

const { execFile } = require('child_process');
const { Notification } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';
const NEXT_URL = 'http://localhost:3000';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const SESSION_FILE = path.join(DATA_DIR, 'daemon-session.json');
const NOTIF_SENT_FILE = path.join(DATA_DIR, 'vault-notif-sent.json');

let hostId = null;
let sessionCookie = null;
let currentUserId = null;
let heartbeatTimer = null;
let pollTimer = null;
let expiryTimer = null;
let isRunning = false;
let runningTaskCount = 0;

// ─────────────────────────────────────────────────────
// Personal Vault 파일 폴백 읽기
// ─────────────────────────────────────────────────────
function readPersonalVaultStore() {
  const filePath = path.join(DATA_DIR, 'personal-vault.enc');
  try {
    const raw = fs.readFileSync(filePath);
    const key = crypto.createHash('sha256').update(`ai-hub:personal-vault:${DATA_DIR}`).digest();
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    return {};
  }
}

async function collectPersonalVaultEnv() {
  if (!currentUserId || !sessionCookie) return {};
  try {
    const res = await fetch(`${VM_URL}/api/vaults`, {
      headers: { Cookie: `session=${sessionCookie}` },
    });
    if (!res.ok) return {};
    const vaults = await res.json();
    const personalVaults = vaults.filter(v => v.scope === 'personal_meta');
    if (!personalVaults.length) return {};

    const store = readPersonalVaultStore();
    const envVars = {};
    for (const vault of personalVaults) {
      const secretsRes = await fetch(`${VM_URL}/api/vaults/${vault.id}/secrets`, {
        headers: { Cookie: `session=${sessionCookie}` },
      });
      if (!secretsRes.ok) continue;
      const secrets = await secretsRes.json();
      for (const secret of secrets) {
        const storeKey = `${currentUserId}/${vault.id}/${secret.key_name}`;
        if (store[storeKey] !== undefined) envVars[secret.key_name] = store[storeKey];
      }
    }
    return envVars;
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────
// Vault 만료 알림 (7일 / 3일 / 당일)
// ─────────────────────────────────────────────────────
function loadSentNotifs() {
  try {
    return JSON.parse(fs.readFileSync(NOTIF_SENT_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSentNotifs(data) {
  fs.writeFileSync(NOTIF_SENT_FILE, JSON.stringify(data), 'utf8');
}

/** 오늘 날짜 문자열 YYYY-MM-DD */
function today() {
  return new Date().toISOString().slice(0, 10);
}

async function checkVaultExpiry() {
  if (!sessionCookie || !currentUserId) return;
  try {
    const res = await fetch(`${VM_URL}/api/vaults`, {
      headers: { Cookie: `session=${sessionCookie}` },
    });
    if (!res.ok) return;
    const vaults = await res.json();
    const sent = loadSentNotifs();
    const nowSec = Math.floor(Date.now() / 1000);
    const todayStr = today();

    for (const vault of vaults) {
      if (!vault.expires_at) continue;
      const daysLeft = Math.floor((vault.expires_at - nowSec) / 86400);
      if (daysLeft < 0 || daysLeft > 7) continue;

      // 7일, 3일, 당일(0일) 알림
      const targets = [7, 3, 0].filter(d => d >= daysLeft && daysLeft <= d);
      const threshold = targets[0]; // 가장 촉박한 것
      if (threshold === undefined) continue;

      const key = `${vault.id}_${threshold}_${todayStr}`;
      if (sent[key]) continue; // 오늘 이미 보냄

      const label = threshold === 0 ? '오늘 만료' : `${daysLeft}일 후 만료`;
      const title = `Vault 만료 알림: ${vault.name}`;
      const body  = `"${vault.name}" vault가 ${label}됩니다. 갱신이 필요하면 확인해주세요.`;

      // Electron 알림
      if (Notification.isSupported()) {
        new Notification({ title, body, urgency: daysLeft === 0 ? 'critical' : 'normal' }).show();
      }

      // 로컬 DB에 저장 (Next.js API를 통해)
      fetch(`${NEXT_URL}/api/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `vm_session=${sessionCookie}` },
        body: JSON.stringify({
          type: daysLeft === 0 ? 'error' : 'warning',
          title,
          message: body,
        }),
      }).catch(() => {});

      sent[key] = todayStr;
    }

    saveSentNotifs(sent);
  } catch (err) {
    console.error('[vault-expiry] 체크 오류:', err);
  }
}

// ─────────────────────────────────────────────────────
// 세션 읽기
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

/** main.js에서 백업용으로 세션 쿠키 획득 */
function getSessionCookie() {
  return sessionCookie;
}

/** main.js에서 트레이 메뉴용 실행 중 작업 수 획득 */
function getRunningCount() {
  return runningTaskCount;
}

async function vmFetch(urlPath, options = {}) {
  const { body, method = 'GET' } = options;
  try {
    const res = await fetch(`${VM_URL}${urlPath}`, {
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
  const result = await vmFetch('/api/hosts/register', { method: 'POST', body: { name } });
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
// 작업 실행
// ─────────────────────────────────────────────────────
async function runTask(task) {
  const { title, description, agent_id } = task;
  const prompt = description || title;
  const cwd = path.join(DATA_DIR, 'workspaces', agent_id || 'default');
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });

  const vaultEnv = await collectPersonalVaultEnv();
  const args = ['-p', prompt, '--output-format', 'text'];
  const env = { ...process.env, ...vaultEnv };

  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd  = isWin ? 'claude.cmd' : 'claude';
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout: 10 * 60 * 1000, env, shell: isWin },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, result: stderr || err.message });
        else     resolve({ ok: true,  result: stdout.trim() });
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
  runningTaskCount++;

  await vmFetch('/api/tasks', { method: 'PATCH', body: { id: task.id, status: 'running' } });
  const { ok, result } = await runTask(task);
  await vmFetch('/api/tasks', {
    method: 'PATCH',
    body: { id: task.id, status: ok ? 'completed' : 'failed', result },
  });

  runningTaskCount = Math.max(0, runningTaskCount - 1);
  isRunning = runningTaskCount > 0;
  console.log(`[daemon] 작업 완료: ${task.id} (${ok ? '성공' : '실패'})`);
}

// ─────────────────────────────────────────────────────
// 데몬 시작 / 종료
// ─────────────────────────────────────────────────────
async function start() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  let retries = 0;
  while (!loadSession() && retries < 10) {
    console.log(`[daemon] 세션 대기 중... (${retries + 1}/10)`);
    await new Promise(r => setTimeout(r, 3000));
    retries++;
  }

  if (!sessionCookie) {
    console.warn('[daemon] 세션 없음 — 로그인 후 자동 재시도');
    watchSessionFile();
    return;
  }

  const me = await vmFetch('/api/auth/me');
  if (me?.id) currentUserId = me.id;

  const registered = await registerHost();
  if (!registered) {
    console.warn('[daemon] 30초 후 재시도');
    setTimeout(start, 30000);
    return;
  }

  // Vault 만료 체크 — 시작 직후 + 24시간마다
  await checkVaultExpiry();
  expiryTimer = setInterval(checkVaultExpiry, 24 * 60 * 60 * 1000);

  // Heartbeat 30초 주기
  heartbeatTimer = setInterval(sendHeartbeat, 30 * 1000);

  // 폴링 5초 주기
  pollTimer = setInterval(pollTasks, 5 * 1000);

  console.log('[daemon] 시작 완료 — 작업 대기 중');
}

function stop() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (pollTimer)      { clearInterval(pollTimer);      pollTimer = null; }
  if (expiryTimer)    { clearInterval(expiryTimer);    expiryTimer = null; }
  if (hostId) {
    vmFetch(`/api/hosts/${hostId}/heartbeat`, { method: 'POST', body: { status: 'offline' } })
      .catch(() => {});
  }
  console.log('[daemon] 종료');
}

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

module.exports = { start, stop, getSessionCookie, getRunningCount };
