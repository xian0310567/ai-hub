import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,  // 단일 Dev 서버 부하 방지
  retries: 1,
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 30_000,
    actionTimeout: 10_000,
    // 외부 폰트 등 서드파티 리소스 로딩 무관하게 DOM 완료 시 ready
    waitForLoadStateOptions: { waitUntil: 'domcontentloaded' } as never,
    launchOptions: {
      executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
      ],
    },
  },

  projects: [
    {
      name: 'setup',
      testMatch: '**/global.setup.ts',
      timeout: 120_000, // 초기 컴파일 대기 포함
    },
    {
      name: 'e2e',
      dependencies: ['setup'],
      use: {
        storageState: '/tmp/ai-hub-test-data/auth.json',
      },
      testIgnore: '**/global.setup.ts',
    },
  ],
});
