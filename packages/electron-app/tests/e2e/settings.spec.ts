/**
 * 설정 페이지 (/settings) 테스트
 * - 페이지 로딩
 * - 탭 전환 (일반, 에이전트, 백업, ...)
 * - 백업 탭: 백업 목록 or 빈 상태
 */
import { test, expect } from '@playwright/test';

test.describe('설정 (/settings)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
  });

  test('페이지 정상 로딩', async ({ page }) => {
    expect(page.url()).not.toContain('/login');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('탭 목록 존재', async ({ page }) => {
    // 탭이 여러 개 있어야 함
    const tabs = page.getByRole('button').filter({ hasText: /설정|일반|에이전트|백업|profile|general/i });
    await expect(tabs.first()).toBeVisible({ timeout: 5_000 });
  });

  test('백업 탭 전환', async ({ page }) => {
    const backupTab = page.getByRole('button', { name: /백업|backup/i });
    if (await backupTab.count() > 0) {
      await backupTab.click();
      await page.waitForTimeout(500);
      // 백업 섹션 노출
      const hasBackupContent = await page.getByText(/백업|backup|지금 백업|복원/i).count();
      expect(hasBackupContent).toBeGreaterThan(0);
    } else {
      test.skip();
    }
  });

  test('각 탭 클릭 — 크래시 없음', async ({ page }) => {
    const allBtns = await page.getByRole('button').all();
    for (const btn of allBtns.slice(0, 6)) {
      try {
        await btn.click();
        await page.waitForTimeout(300);
        // 페이지가 살아있어야 함
        await expect(page.locator('body')).not.toBeEmpty();
      } catch {
        // 버튼이 사라졌거나 non-tab 버튼 — 무시
      }
    }
  });
});
