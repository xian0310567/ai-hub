const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const NEXT_PORT = 3000;
const isDev = process.env.NODE_ENV !== 'production';

let tray = null;
let mainWindow = null;
let nextProcess = null;
let isQuitting = false;

// ─────────────────────────────────────────────────────
// Next.js 서버 시작 (프로덕션 전용 — dev는 별도로 띄움)
// ─────────────────────────────────────────────────────
function startNextServer() {
  if (isDev) return Promise.resolve(); // dev 모드는 `next dev`로 별도 실행

  return new Promise((resolve, reject) => {
    const appRoot = path.join(__dirname, '..');
    nextProcess = spawn('node', ['node_modules/.bin/next', 'start', '--port', String(NEXT_PORT)], {
      cwd: appRoot,
      env: { ...process.env, NODE_ENV: 'production' },
    });

    nextProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Ready')) resolve();
    });

    nextProcess.stderr.on('data', (data) => {
      console.error('[next]', data.toString());
    });

    nextProcess.on('error', reject);

    // 타임아웃 fallback
    setTimeout(resolve, 5000);
  });
}

// ─────────────────────────────────────────────────────
// Next.js가 응답할 때까지 대기
// ─────────────────────────────────────────────────────
function waitForNext(retries = 20) {
  return new Promise((resolve) => {
    const tryConnect = (n) => {
      http.get(`http://localhost:${NEXT_PORT}`, (res) => {
        resolve();
      }).on('error', () => {
        if (n > 0) setTimeout(() => tryConnect(n - 1), 500);
        else resolve(); // 포기하고 진행
      });
    };
    tryConnect(retries);
  });
}

// ─────────────────────────────────────────────────────
// 메인 윈도우 생성
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 외부 링크는 기본 브라우저로
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 닫기 버튼 → 트레이로 최소화 (완전 종료 X)
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
function createTray() {
  const icon = nativeImage.createEmpty(); // TODO: 실제 아이콘으로 교체
  tray = new Tray(icon);

  const menu = Menu.buildFromTemplate([
    { label: 'AI Hub 열기', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: '종료', click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip('AI Hub');
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
});

app.on('window-all-closed', (e) => {
  // macOS: 모든 창이 닫혀도 앱 유지 (트레이에서 관리)
  e.preventDefault();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (nextProcess) nextProcess.kill();
});

app.on('activate', () => {
  // macOS: dock 아이콘 클릭 시 창 복원
  if (mainWindow) {
    mainWindow.show();
  }
});
