/**
 * 미션 페이지 (/missions) 테스트
 * - 페이지 로딩
 * - 미션 생성 UI
 * - 미션 목록
 */
import { test, expect } from '@playwright/test';

test.describe('미션 (/missions)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/missions', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
  });

  test('페이지 정상 로딩', async ({ page }) => {
    expect(page.url()).not.toContain('/login');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('미션 입력창 또는 빈 상태 존재', async ({ page }) => {
    const hasInput  = await page.locator('textarea, input[type="text"]').count();
    const hasEmpty  = await page.getByText(/없음|empty|미션|mission/i).count();
    const hasCreate = await page.getByRole('button', { name: /미션|실행|시작|new/i }).count();
    expect(hasInput + hasEmpty + hasCreate).toBeGreaterThan(0);
  });

  test('API: GET /api/missions — 200 응답', async ({ page }) => {
    const res = await page.request.get('/api/missions');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('ok', true);
  });

  test('API: 알림 목록 조회 — 200 응답', async ({ page }) => {
    const res = await page.request.get('/api/notifications');
    expect(res.status()).toBe(200);
  });
});
