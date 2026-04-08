const { app, BrowserWindow, Tray, Menu, nativeImage, shell, Notification } = require('electron');
const path = require('path');
const fs   = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const daemon = require('./daemon');

const isMac  = process.platform === 'darwin';
const isWin  = process.platform === 'win32';

const NEXT_PORT = 3000;
const isDev     = process.env.NODE_ENV !== 'production';
const VM_URL    = process.env.VM_SERVER_URL || 'http://localhost:4000';
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, '..', '.data');
const SESSION_FILE   = path.join(DATA_DIR, 'daemon-session.json');
const APP_STATE_FILE = path.join(DATA_DIR, 'app-state.json');

let tray       = null;
let mainWindow = null;
let nextProcess = null;
let isQuitting  = false;

// ─────────────────────────────────────────────────────
// 앱 상태 (트레이 vs 종료)
// ─────────────────────────────────────────────────────
function readAppState() {
  try {
    return JSON.parse(fs.readFileSync(APP_STATE_FILE, 'utf8'));
  } catch {
    return { state: 'quit' };
  }
}

function writeAppState(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(APP_STATE_FILE, JSON.stringify({ state }), 'utf8');
}

// ─────────────────────────────────────────────────────
// SQLite 백업
// ─────────────────────────────────────────────────────
async function backupSqlite() {
  const dbPath = path.join(DATA_DIR, 'local.db');
  if (!fs.existsSync(dbPath)) return;

  const cookie = daemon.getSessionCookie();
  if (!cookie) return;

  try {
    const buf = fs.readFileSync(dbPath);
    const res = await fetch(`${VM_URL}/api/backup/sqlite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Cookie: `session=${cookie}` },
      body: buf,
    });
    if (res.ok) {
      const data = await res.json();
      console.log('[backup] SQLite 백업 완료:', data.timestamp);
      updateTray();
    }
  } catch (err) {
    console.error('[backup] SQLite 백업 실패:', err);
  }
}

// 트레이 중: 1시간마다
let backupTimer = null;

function startHourlyBackup() {
  if (backupTimer) return;
  backupTimer = setInterval(backupSqlite, 60 * 60 * 1000);
}

function stopHourlyBackup() {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
}

// ─────────────────────────────────────────────────────
// Vault 잠금
// ─────────────────────────────────────────────────────
function lockVault() {
  // 세션 파일 삭제 → 재로그인 필요
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  mainWindow?.show();
  mainWindow?.focus();
  mainWindow?.loadURL(`http://localhost:${NEXT_PORT}/login`);
}

// ─────────────────────────────────────────────────────
// Next.js 서버 시작 (프로덕션 전용)
// ─────────────────────────────────────────────────────
function startNextServer() {
  if (isDev) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const appRoot = path.join(__dirname, '..');
    // Windows: .bin/next.cmd, macOS/Linux: .bin/next
    const nextBin = path.join('node_modules', '.bin', isWin ? 'next.cmd' : 'next');
    nextProcess = spawn(nextBin, ['start', '--port', String(NEXT_PORT)], {
      cwd: appRoot,
      env: { ...process.env, NODE_ENV: 'production' },
      shell: isWin, // Windows에서 .cmd 실행에 필요
    });
    nextProcess.stdout.on('data', (data) => { if (data.toString().includes('Ready')) resolve(); });
    nextProcess.stderr.on('data', (data) => console.error('[next]', data.toString()));
    nextProcess.on('error', reject);
    setTimeout(resolve, 5000);
  });
}

function waitForNext(retries = 20) {
  return new Promise((resolve) => {
    const tryConnect = (n) => {
      http.get(`http://localhost:${NEXT_PORT}`, () => resolve()).on('error', () => {
        if (n > 0) setTimeout(() => tryConnect(n - 1), 500);
        else resolve();
      });
    };
    tryConnect(retries);
  });
}

// ─────────────────────────────────────────────────────
// 메인 윈도우
// ─────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${NEXT_PORT}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      writeAppState('tray');
      startHourlyBackup();
    }
  });
}

// ─────────────────────────────────────────────────────
// 시스템 트레이
// ─────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  const count = daemon.getRunningCount();
  const statusLabel = count > 0
    ? `실행 중인 작업: ${count}개`
    : '대기 중 — 작업 없음';

  const menu = Menu.buildFromTemplate([
    { label: 'AI Hub', enabled: false },
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: '대시보드 열기',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.loadURL(`http://localhost:${NEXT_PORT}/live`);
      },
    },
    {
      label: '메인으로 돌아가기',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.loadURL(`http://localhost:${NEXT_PORT}`);
      },
    },
    { type: 'separator' },
    {
      label: 'Vault 잠금',
      click: lockVault,
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => { isQuitting = true; app.quit(); },
    },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(`AI Hub — ${count > 0 ? `${count}개 작업 실행 중` : '대기 중'}`);
}

function createTray() {
  // Windows는 반드시 유효한 아이콘이 필요, macOS는 빈 이미지 가능
  let icon;
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
    if (isWin) icon = icon.resize({ width: 16, height: 16 });
  } else {
    // 기본 1x1 아이콘 생성 (아이콘 파일 없을 때 fallback)
    icon = nativeImage.createFromBuffer(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAADklEQVQ4jWNgGAWDEwAAAhAAATFrFCAAAAAASUVORK5CYII=', 'base64'),
      { width: 16, height: 16 }
    );
  }
  tray = new Tray(icon);
  updateTray();

  // macOS: 더블클릭, Windows/Linux: 싱글클릭으로 창 열기
  tray.on(isMac ? 'double-click' : 'click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  // 30초마다 트레이 메뉴 갱신 (작업 수 반영)
  setInterval(updateTray, 30 * 1000);
}

// ─────────────────────────────────────────────────────
// 앱 초기화
// ─────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  await startNextServer();
  await waitForNext();
  createTray();
  createWindow();

  // 데몬 시작
  daemon.start();

  // 이전에 완전 종료된 상태였다면 → 즉시 백업
  const prevState = readAppState();
  if (prevState.state === 'quit') {
    // 데몬 세션 로드까지 15초 대기 후 백업 시도
    setTimeout(backupSqlite, 15_000);
  }
});

// macOS: 창 닫아도 트레이에서 계속 실행
// Windows/Linux: 모든 창 닫으면 종료
app.on('window-all-closed', (e) => {
  if (isMac) {
    e.preventDefault();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopHourlyBackup();
  writeAppState('quit');
  daemon.stop();
  if (nextProcess) nextProcess.kill();
});

// macOS: dock 클릭 시 창 다시 표시
app.on('activate', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});
