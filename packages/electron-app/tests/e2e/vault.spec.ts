/**
 * Vault 관리 페이지 (/vault) 테스트
 */
import { test, expect } from '@playwright/test';

const VAULT_NAME = 'PW테스트Vault';

test.describe('Vault 관리 (/vault)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/vault', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
  });

  test('페이지 정상 로딩 — Vaults 헤딩 + + 생성 버튼', async ({ page }) => {
    expect(page.url()).not.toContain('/login');
    await expect(page.getByText('Vaults')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ 생성' })).toBeVisible();
  });

  test('Vault 생성', async ({ page }) => {
    await page.getByRole('button', { name: '+ 생성' }).click();
    await page.waitForTimeout(500);

    // 이름 입력 (placeholder: 예: 인스타그램 API 키)
    const nameInput = page.getByPlaceholder(/인스타그램/);
    await expect(nameInput).toBeVisible({ timeout: 3_000 });
    await nameInput.fill(VAULT_NAME);

    // 확인 버튼 (class: modal-btn-ok)
    await page.locator('.modal-btn-ok').first().click();
    await page.waitForTimeout(1500);

    await expect(page.getByText(VAULT_NAME)).toBeVisible({ timeout: 5_000 });
  });

  test('Vault 선택 시 우측 패널 표시', async ({ page }) => {
    const vaultItem = page.getByText(VAULT_NAME).first();
    if (await vaultItem.count() === 0) {
      // vault가 없으면 빈 상태 확인
      await expect(page.getByText('좌측에서 Vault를 선택하세요')).toBeVisible();
      return;
    }
    await vaultItem.click();
    await page.waitForTimeout(500);
    // 상세 패널: 시크릿 추가 버튼
    await expect(page.getByRole('button', { name: /시크릿 추가/ })).toBeVisible({ timeout: 3_000 });
  });

  test('시크릿 추가', async ({ page }) => {
    const vaultItem = page.getByText(VAULT_NAME).first();
    if (await vaultItem.count() === 0) {
      test.skip();
    }
    await vaultItem.click();
    await page.waitForTimeout(500);

    await page.getByRole('button', { name: /시크릿 추가/ }).click();
    await page.waitForTimeout(300);

    const keyInput = page.getByPlaceholder(/API_KEY|key_name/i).first();
    if (await keyInput.isVisible()) {
      await keyInput.fill('PW_TEST_KEY');
      const valInput = page.getByPlaceholder(/value|값/i).first();
      if (await valInput.isVisible()) await valInput.fill('pw-secret-value');
      await page.getByRole('button', { name: /추가|저장|확인/ }).last().click();
      await page.waitForTimeout(800);
      await expect(page.getByText('PW_TEST_KEY')).toBeVisible({ timeout: 5_000 });
    }
  });

  test('Vault 삭제', async ({ page }) => {
    const vaultItem = page.getByText(VAULT_NAME).first();
    if (await vaultItem.count() === 0) {
      test.skip();
    }
    await vaultItem.click();
    await page.waitForTimeout(500);

    page.on('dialog', d => d.accept());
    const delBtn = page.getByRole('button', { name: /삭제/ });
    if (await delBtn.isVisible()) {
      await delBtn.click();
      await page.waitForTimeout(1000);
      await expect(page.getByText(VAULT_NAME)).not.toBeVisible({ timeout: 5_000 });
    }
  });
});
