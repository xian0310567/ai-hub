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

  test('미션 삭제 버튼 — 확인 다이얼로그 출력', async ({ page }) => {
    // 미션이 있을 때만 테스트 (없으면 skip)
    const deleteBtn = page.locator('button').filter({ hasText: '✕' }).first();
    if (await deleteBtn.count() === 0) { test.skip(); return; }

    let dialogShown = false;
    page.once('dialog', async dialog => {
      dialogShown = true;
      await dialog.dismiss(); // 실제 삭제는 하지 않음
    });

    await deleteBtn.click();
    await page.waitForTimeout(500);
    expect(dialogShown).toBe(true);
  });

  test('nav — 대시보드·스케줄 링크 존재', async ({ page }) => {
    await expect(page.locator('nav a[href="/"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('nav a[href="/schedules"]')).toBeVisible({ timeout: 5_000 });
  });

  test('API: 삭제된 채팅 API 미존재 — 404', async ({ page }) => {
    const r1 = await page.request.post('/api/chat/send', { data: {} });
    expect(r1.status()).toBe(404);
    const r2 = await page.request.get('/api/chat/history/test-agent');
    expect(r2.status()).toBe(404);
  });

  test('API: Human Gate approve — 없는 미션·잡 404', async ({ page }) => {
    const res = await page.request.patch('/api/missions/nonexistent-id/jobs/nonexistent-job/approve');
    expect(res.status()).toBe(404);
  });

  test('API: resume — 없는 미션 404', async ({ page }) => {
    const res = await page.request.post('/api/missions/nonexistent-id/resume');
    expect(res.status()).toBe(404);
  });

  test('미션 목록에 실패 미션 재개 버튼 존재', async ({ page }) => {
    // 실패 미션이 있을 때만 테스트
    const resumeBtn = page.getByRole('button', { name: /재개/ });
    if (await resumeBtn.count() === 0) { test.skip(); return; }
    await expect(resumeBtn.first()).toBeVisible({ timeout: 3_000 });
  });
});
