const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const daemon = require('./daemon');

const NEXT_PORT = 3000;
const isDev = process.env.NODE_ENV !== 'production';

let tray = null;
let mainWindow = null;
let nextProcess = null;
let isQuitting = false;

// ─────────────────────────────────────────────────────
// Next.js 서버 시작 (프로덕션 전용)
// ─────────────────────────────────────────────────────
function startNextServer() {
  if (isDev) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const appRoot = path.join(__dirname, '..');
    nextProcess = spawn('node', ['node_modules/.bin/next', 'start', '--port', String(NEXT_PORT)], {
      cwd: appRoot,
      env: { ...process.env, NODE_ENV: 'production' },
    });

    nextProcess.stdout.on('data', (data) => {
      if (data.toString().includes('Ready')) resolve();
    });
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
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
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
    }
  });
}

// ─────────────────────────────────────────────────────
// 시스템 트레이
// ─────────────────────────────────────────────────────
function updateTrayStatus(status) {
  const labels = { idle: '대기 중', busy: '작업 중', offline: '오프라인' };
  if (tray) tray.setToolTip(`AI Hub — ${labels[status] || status}`);
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const menu = Menu.buildFromTemplate([
    { label: 'AI Hub 열기', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: '종료', click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip('AI Hub — 시작 중');
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ─────────────────────────────────────────────────────
// 앱 초기화
// ─────────────────────────────────────────────────────
app.whenReady().then(async () => {
  await startNextServer();
  await waitForNext();
  createTray();
  createWindow();

  // 데몬 시작
  daemon.start();
  updateTrayStatus('idle');
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // 트레이에서 계속 실행
});

app.on('before-quit', () => {
  isQuitting = true;
  daemon.stop();
  if (nextProcess) nextProcess.kill();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
