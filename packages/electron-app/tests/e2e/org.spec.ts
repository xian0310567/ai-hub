/**
 * 조직 관리 페이지 (/org) 테스트
 */
import { test, expect } from '@playwright/test';

test.describe('조직 관리 (/org)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/org', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
  });

  test('페이지 정상 로딩 — + 부문 버튼 존재', async ({ page }) => {
    expect(page.url()).not.toContain('/login');
    await expect(page.getByRole('button', { name: '+ 부문' })).toBeVisible({ timeout: 5_000 });
  });

  test('nav — 표준 nav 링크 존재 (대시보드·미션·스케줄)', async ({ page }) => {
    await expect(page.locator('nav a[href="/"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('nav a[href="/missions"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('nav a[href="/schedules"]')).toBeVisible({ timeout: 5_000 });
  });

  test('nav — 조직 관리 active 표시', async ({ page }) => {
    // 조직 관리는 active span (링크 아닌 span)으로 표시
    const active = page.locator('nav span').filter({ hasText: '조직 관리' });
    await expect(active).toBeVisible({ timeout: 5_000 });
  });

  test('부문(Division) 생성', async ({ page }) => {
    await page.getByRole('button', { name: '+ 부문' }).click();
    await page.waitForTimeout(400);

    // 이름 입력: label 이름이 '이름'인 input
    await expect(page.locator('input.modal-input').first()).toBeVisible({ timeout: 3_000 });
    await page.locator('input.modal-input').first().fill('PW테스트부문');

    await page.locator('.modal-btn-ok').click();
    await page.waitForTimeout(1200);
    await expect(page.getByText('PW테스트부문').first()).toBeVisible({ timeout: 5_000 });
  });

  test('실(Department) 생성', async ({ page }) => {
    const hasDivision = await page.getByText('PW테스트부문').count();
    if (!hasDivision) { test.skip(); }

    // 부문 expand
    const expandBtn = page.locator('button').filter({ hasText: /▸|▾/ }).first();
    if (await expandBtn.count() > 0) {
      await expandBtn.click();
      await page.waitForTimeout(400);
    }

    const addDeptBtn = page.getByRole('button', { name: '+ 실 추가' }).first();
    if (await addDeptBtn.count() === 0) { test.skip(); }

    await addDeptBtn.click();
    await page.waitForTimeout(400);
    await expect(page.locator('input.modal-input').first()).toBeVisible({ timeout: 3_000 });
    await page.locator('input.modal-input').first().fill('PW테스트실');
    await page.locator('.modal-btn-ok').click();
    await page.waitForTimeout(1200);
    await expect(page.getByText('PW테스트실').first()).toBeVisible({ timeout: 5_000 });
  });

  test('팀 생성', async ({ page }) => {
    const addTeamBtns = page.getByRole('button', { name: /\+ 팀 추가/ });
    if (await addTeamBtns.count() === 0) { test.skip(); }

    await addTeamBtns.first().click();
    await page.waitForTimeout(400);
    await expect(page.locator('input.modal-input').first()).toBeVisible({ timeout: 3_000 });
    await page.locator('input.modal-input').first().fill('PW테스트팀');
    await page.locator('.modal-btn-ok').click();
    await page.waitForTimeout(1200);
    await expect(page.getByText('PW테스트팀').first()).toBeVisible({ timeout: 5_000 });
  });
});
