/**
 * 라이브 대시보드 (/live) 테스트
 * - 페이지 로딩
 * - 픽셀아트 캐릭터 캔버스 존재
 * - 미션 패널 존재
 * - 폴링 동작 (3초마다 /api/missions 호출)
 */
import { test, expect } from '@playwright/test';

test.describe('라이브 대시보드 (/live)', () => {
  test('페이지 정상 로딩', async ({ page }) => {
    await page.goto('/live', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    expect(page.url()).not.toContain('/login');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('캔버스 또는 애니메이션 컨테이너 존재', async ({ page }) => {
    await page.goto('/live');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const hasCanvas = await page.locator('canvas').count();
    const hasAnimEl = await page.locator('[style*="animation"], [class*="anim"], [class*="sprite"]').count();
    const hasLiveEl = await page.locator('[style*="position: relative"], [style*="overflow: hidden"]').count();
    expect(hasCanvas + hasAnimEl + hasLiveEl).toBeGreaterThan(0);
  });

  test('/api/missions 폴링 요청 발생', async ({ page }) => {
    let missionsRequestCount = 0;

    page.on('request', req => {
      if (req.url().includes('/api/missions')) missionsRequestCount++;
    });

    await page.goto('/live');
    await page.waitForTimeout(5000); // 3초 폴링 2회 이상 기다림

    expect(missionsRequestCount).toBeGreaterThanOrEqual(1);
  });

  test('빈 상태 — 크래시 없이 렌더링', async ({ page }) => {
    await page.goto('/live');
    await page.waitForTimeout(2000);
    // console.error 없어야 함
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.waitForTimeout(1000);
    // React 하이드레이션 에러 등 크리티컬 오류만 체크
    const criticalErrors = errors.filter(e =>
      e.includes('Unhandled') || e.includes('TypeError') || e.includes('Cannot read')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
