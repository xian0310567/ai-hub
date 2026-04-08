/**
 * 작업 관리 페이지 (/tasks) 테스트
 */
import { test, expect } from '@playwright/test';

test.describe('작업 관리 (/tasks)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tasks', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
  });

  test('페이지 정상 로딩 — 태스크 헤딩', async ({ page }) => {
    expect(page.url()).not.toContain('/login');
    // 정확히 '태스크' span (strict mode 회피)
    await expect(page.getByText('태스크', { exact: true })).toBeVisible();
  });

  test('+ 새 태스크 버튼 존재', async ({ page }) => {
    await expect(page.getByRole('button', { name: '+ 새 태스크' })).toBeVisible();
  });

  test('빈 상태 또는 태스크 목록 표시', async ({ page }) => {
    const hasEmpty = await page.getByText('태스크가 없습니다').count();
    const hasItem  = await page.locator('[style*="border-bottom"]').count();
    expect(hasEmpty + hasItem).toBeGreaterThan(0);
  });

  test('새 태스크 모달 오픈 — 입력창 노출', async ({ page }) => {
    await page.getByRole('button', { name: '+ 새 태스크' }).click();
    await page.waitForTimeout(500);
    await expect(page.getByPlaceholder('에이전트에게 시킬 작업')).toBeVisible({ timeout: 3_000 });
  });

  test('태스크 생성 후 목록 노출', async ({ page }) => {
    await page.getByRole('button', { name: '+ 새 태스크' }).click();
    await page.waitForTimeout(500);

    const titleInput = page.getByPlaceholder('에이전트에게 시킬 작업');
    if (!await titleInput.isVisible()) { test.skip(); }

    await titleInput.fill('PW자동화테스트작업');
    // tasks 모달 저장 버튼 텍스트는 '저장'
    await page.getByRole('button', { name: '저장' }).click();
    await page.waitForTimeout(2000);
    await expect(page.getByText('PW자동화테스트작업').first()).toBeVisible({ timeout: 5_000 });
  });
});
