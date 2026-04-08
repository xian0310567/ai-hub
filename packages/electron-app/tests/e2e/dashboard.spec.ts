/**
 * 메인 대시보드 (/) 테스트
 */
import { test, expect } from '@playwright/test';

test.describe('메인 대시보드', () => {
  test('페이지 정상 로딩 — /login 미리다이렉트', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    expect(page.url()).not.toContain('/login');
  });

  test('캔버스 스테이지 렌더링', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    // 픽셀아트 캔버스 또는 스테이지 div 존재
    const hasCanvas  = await page.locator('canvas').count();
    const hasStage   = await page.locator('div[style*="overflow"]').count();
    expect(hasCanvas + hasStage).toBeGreaterThan(0);
  });

  test('로그아웃 버튼 존재', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    // 대시보드 네비게이션에 로그아웃 또는 사용자 메뉴 존재
    const hasLogout = await page.getByRole('button', { name: /로그아웃|logout/i }).count();
    const hasUserMenu = await page.getByText(/pw_tester|logout/i).count();
    expect(hasLogout + hasUserMenu).toBeGreaterThan(0);
  });

  test('모든 서브페이지 접근 — 크래시 없음', async ({ page }) => {
    const routes = ['/org', '/tasks', '/vault', '/settings', '/live', '/missions'];
    for (const route of routes) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      expect(page.url()).not.toContain('/login');
      await expect(page.locator('body')).not.toBeEmpty();
    }
  });

  test('API /api/auth/me — 인증 상태 확인', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const res = await page.request.get('/api/auth/me', { timeout: 20_000 });
    expect(res.status()).toBe(200);
    const data = await res.json() as { id: string; username: string };
    expect(data.username).toBe('pw_tester');
  });
});
