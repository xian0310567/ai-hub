/**
 * Global Setup — DB 초기 조직 생성 + 테스트 계정 로그인 → auth.json 저장
 */
import { test as setup, expect } from '@playwright/test';
import { execSync } from 'child_process';
import fs from 'fs';

const DATA_DIR = '/tmp/ai-hub-test-data';
const AUTH_FILE = `${DATA_DIR}/auth.json`;
const DB_URL   = 'postgres://aihub:aihub1234@localhost:5432/aihub';

export const TEST_USER = 'pw_tester';
export const TEST_PASS = 'Playwright123!';

function psql(sql: string) {
  try {
    execSync(`psql "${DB_URL}" -c "${sql}"`, { stdio: 'pipe' });
  } catch { /* 이미 존재하는 경우 무시 */ }
}

setup('초기 조직 생성 및 로그인 상태 저장', async ({ page }) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 1. DB에 초기 조직 생성 (첫 signup 시 자동 배정됨)
  psql("INSERT INTO organizations(id,name,slug) VALUES(gen_random_uuid(),'PW테스트조직','pw-test-org') ON CONFLICT(slug) DO NOTHING;");

  // 2. 회원가입 (이미 있으면 409 → UI에서 에러 표시, 무시)
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/AI Hub|AI 사업부/)).toBeVisible();

  const isSignupMode = await page.getByRole('button', { name: /계정 만들기|회원가입|create|signup/i }).count();
  if (isSignupMode) {
    await page.getByRole('button', { name: /계정 만들기|회원가입|create|signup/i }).click();
    await page.getByPlaceholder('username').fill(TEST_USER);
    await page.getByPlaceholder('••••••').fill(TEST_PASS);
    await page.getByRole('button', { name: /가입|signup|register|시작/i }).click();
    await page.waitForTimeout(800);
  }

  // 3. 로그인
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('username').fill(TEST_USER);
  await page.getByPlaceholder('••••••').fill(TEST_PASS);
  await page.getByRole('button', { name: /로그인|sign in|signin/i }).click();
  await page.waitForURL('http://localhost:3000/', { timeout: 15_000, waitUntil: 'domcontentloaded' });

  // 4. 로그인 완료 후 DB에서 org_admin으로 승격 (이제 유저가 존재함)
  psql(`UPDATE org_members SET role='org_admin' WHERE user_id = (SELECT id FROM users WHERE username='${TEST_USER}');`);

  // 5. 페이지 사전 컴파일 워밍업 (Next.js 최초 컴파일 유발, 실패해도 계속)
  for (const route of ['/', '/tasks', '/org', '/vault', '/settings', '/live', '/missions']) {
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch { /* 컴파일 타임아웃은 무시 */ }
  }

  // 6. auth 상태 저장
  await page.context().storageState({ path: AUTH_FILE });
  console.log('✅ 인증 상태 저장 완료:', AUTH_FILE);
});
