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
    // 타임스탬프 기반 유니크 이름 — 중복 충돌 없음
    const divName = `PW부문-${Date.now()}`;

    await page.getByRole('button', { name: '+ 부문' }).click();
    await page.waitForTimeout(400);

    await expect(page.locator('input.modal-input').first()).toBeVisible({ timeout: 3_000 });
    await page.locator('input.modal-input').first().fill(divName);

    await page.locator('.modal-btn-ok').click();
    await page.waitForTimeout(1500);
    await expect(page.getByText(divName).first()).toBeVisible({ timeout: 8_000 });
  });

  test('실(Department) 생성', async ({ page }) => {
    // 부문이 하나라도 있어야 실 추가 가능
    const expandBtn = page.locator('button').filter({ hasText: /▸|▾/ }).first();
    if (await expandBtn.count() === 0) { test.skip(); return; }

    await expandBtn.click();
    await page.waitForTimeout(400);

    const addDeptBtn = page.getByRole('button', { name: '+ 실 추가' }).first();
    if (await addDeptBtn.count() === 0) { test.skip(); return; }

    const deptName = `PW실-${Date.now()}`;
    await addDeptBtn.click();
    await page.waitForTimeout(400);
    await expect(page.locator('input.modal-input').first()).toBeVisible({ timeout: 3_000 });
    await page.locator('input.modal-input').first().fill(deptName);
    await page.locator('.modal-btn-ok').click();
    await page.waitForTimeout(1200);
    await expect(page.getByText(deptName).first()).toBeVisible({ timeout: 5_000 });
  });

  test('팀 생성', async ({ page }) => {
    const addTeamBtns = page.getByRole('button', { name: /\+ 팀 추가/ });
    if (await addTeamBtns.count() === 0) { test.skip(); return; }

    const teamName = `PW팀-${Date.now()}`;
    await addTeamBtns.first().click();
    await page.waitForTimeout(400);
    await expect(page.locator('input.modal-input').first()).toBeVisible({ timeout: 3_000 });
    await page.locator('input.modal-input').first().fill(teamName);
    await page.locator('.modal-btn-ok').click();
    await page.waitForTimeout(1200);
    await expect(page.getByText(teamName).first()).toBeVisible({ timeout: 5_000 });
  });
});
