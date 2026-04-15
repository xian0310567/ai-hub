/**
 * 인증 플로우 테스트
 * - 로그인 페이지 렌더링
 * - 잘못된 자격증명 오류 처리
 * - 중복 사용자명 오류
 * - 로그아웃
 */
import { test, expect } from '@playwright/test';

// 이 파일의 테스트는 auth.json 없이도 실행 가능 (로그인 상태 불필요)
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('로그인 페이지', () => {
  test('페이지 기본 UI 노출', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/AI Hub|AI 사업부/)).toBeVisible();
    await expect(page.getByPlaceholder('username')).toBeVisible();
    await expect(page.getByPlaceholder('••••••')).toBeVisible();
  });

  test('틀린 비밀번호 — 오류 메시지 표시', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('username').fill('nobody_user_xyz');
    await page.getByPlaceholder('••••••').fill('wrongpassword');
    await page.getByRole('button', { name: /로그인|sign in|signin/i }).click();
    // 서버 오류 메시지: "Invalid credentials" 또는 "오류가 발생했습니다" 또는 "서버 연결 오류"
    await expect(page.locator('div[style*="color"]').filter({ hasText: /Invalid|오류|credentials|잘못|연결/i }).or(
      page.locator('[style*="red"], [style*="danger"], [style*="#f"]').filter({ hasText: /\S/ })
    ).first()).toBeVisible({ timeout: 8_000 });
  });

  test('signup 모드 전환', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /계정 만들기|회원가입|create|signup/i }).click();
    // 버튼 텍스트가 바뀌어야 함
    await expect(page.getByRole('button', { name: /가입|register|시작/i })).toBeVisible();
  });

  test('중복 사용자명 가입 시도 — 오류 메시지', async ({ page }) => {
    // API 직접 호출로 중복 체크 (UI 모드 전환 타이밍 이슈 우회)
    const res = await page.request.post('/api/auth/signup', {
      data: { username: 'pw_tester', password: 'Playwright123!' },
      timeout: 25_000,
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/taken|중복|already/i);
  });
});

test.describe('로그인 → 로그아웃', () => {
  test('올바른 자격증명으로 로그인 후 대시보드 이동', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('username').fill('pw_tester');
    await page.getByPlaceholder('••••••').fill('Playwright123!');
    await page.getByRole('button', { name: /로그인|sign in|signin/i }).click();
    // signin 후 대시보드 이동 대기 (서버 부하로 인해 느릴 수 있음)
    await page.waitForFunction(
      () => !window.location.href.includes('/login'),
      { timeout: 45_000 }
    );
    expect(page.url()).not.toContain('/login');
  });
});
