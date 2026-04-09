/**
 * 스케줄 관리 페이지 (/schedules) 테스트
 * - 페이지 로딩
 * - nav 링크 확인
 * - 빈 상태 또는 목록 표시
 * - API 응답
 */
import { test, expect } from '@playwright/test';

test.describe('스케줄 (/schedules)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/schedules', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
  });

  test('페이지 정상 로딩 — 로그인 페이지 미리다이렉트 없음', async ({ page }) => {
    expect(page.url()).not.toContain('/login');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('스케줄 헤딩 존재', async ({ page }) => {
    await expect(page.getByText(/반복 미션 스케줄/)).toBeVisible({ timeout: 5_000 });
  });

  test('빈 상태 또는 스케줄 목록 표시', async ({ page }) => {
    const hasEmpty    = await page.getByText(/등록된 스케줄 없음/).count();
    const hasSchedule = await page.locator('[style*="bg-panel"]').count();
    expect(hasEmpty + hasSchedule).toBeGreaterThan(0);
  });

  test('nav — 대시보드·미션·조직 관리 링크 존재', async ({ page }) => {
    await expect(page.locator('nav a[href="/"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('nav a[href="/missions"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('nav a[href="/org"]')).toBeVisible({ timeout: 5_000 });
  });

  test('nav — 스케줄 active 표시', async ({ page }) => {
    // 스케줄은 현재 페이지이므로 링크가 아닌 span으로 표시
    const active = page.locator('nav span').filter({ hasText: '스케줄' });
    await expect(active).toBeVisible({ timeout: 5_000 });
  });

  test('API: GET /api/schedules — 200 응답', async ({ page }) => {
    const res = await page.request.get('/api/schedules');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('ok', true);
    expect(body).toHaveProperty('schedules');
  });

  test('cron 참고표 존재', async ({ page }) => {
    await expect(page.getByText(/cron 표현식 참고/)).toBeVisible({ timeout: 5_000 });
  });
});
