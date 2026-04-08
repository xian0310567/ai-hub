/**
 * personal-vault.ts 단위 테스트
 *
 * keytar 없이 파일 기반 폴백을 사용하는 환경에서 동작을 검증한다.
 * `keytar` 임포트가 실패하도록 vi.mock으로 처리하고, 실제 파일 I/O는
 * 임시 DATA_DIR에서 수행한다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// keytar를 사용 불가로 mock (파일 폴백 강제)
vi.mock('keytar', () => { throw new Error('keytar unavailable'); });

// 임시 디렉토리 설정
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-vault-'));
  process.env.DATA_DIR = tmpDir;
  // 모듈 캐시 초기화 (DATA_DIR 변경 반영)
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

// ── 헬퍼 ──────────────────────────────────────────────────────────────
async function getModule() {
  // vi.resetModules() 이후 재임포트
  const mod = await import('@/lib/personal-vault');
  return mod;
}

describe('personal-vault (파일 폴백)', () => {
  it('저장 → 읽기 → 삭제 기본 흐름', async () => {
    const { savePersonalSecret, readPersonalSecret, deletePersonalSecret } = await getModule();

    await savePersonalSecret('u1', 'v1', 'MY_TOKEN', 'abc123');

    const val = await readPersonalSecret('u1', 'v1', 'MY_TOKEN');
    expect(val).toBe('abc123');

    await deletePersonalSecret('u1', 'v1', 'MY_TOKEN');
    const after = await readPersonalSecret('u1', 'v1', 'MY_TOKEN');
    expect(after).toBeNull();
  });

  it('없는 키 조회 시 null 반환', async () => {
    const { readPersonalSecret } = await getModule();
    const val = await readPersonalSecret('u1', 'v1', 'NONEXISTENT');
    expect(val).toBeNull();
  });

  it('여러 키를 독립적으로 저장', async () => {
    const { savePersonalSecret, readPersonalSecret } = await getModule();

    await savePersonalSecret('u1', 'v1', 'KEY_A', 'value-a');
    await savePersonalSecret('u1', 'v1', 'KEY_B', 'value-b');
    await savePersonalSecret('u1', 'v2', 'KEY_A', 'value-a-vault2');

    expect(await readPersonalSecret('u1', 'v1', 'KEY_A')).toBe('value-a');
    expect(await readPersonalSecret('u1', 'v1', 'KEY_B')).toBe('value-b');
    expect(await readPersonalSecret('u1', 'v2', 'KEY_A')).toBe('value-a-vault2');
  });

  it('다른 userId는 분리됨', async () => {
    const { savePersonalSecret, readPersonalSecret } = await getModule();

    await savePersonalSecret('u1', 'v1', 'SHARED_KEY', 'user1-value');
    await savePersonalSecret('u2', 'v1', 'SHARED_KEY', 'user2-value');

    expect(await readPersonalSecret('u1', 'v1', 'SHARED_KEY')).toBe('user1-value');
    expect(await readPersonalSecret('u2', 'v1', 'SHARED_KEY')).toBe('user2-value');
  });

  it('값 덮어쓰기', async () => {
    const { savePersonalSecret, readPersonalSecret } = await getModule();

    await savePersonalSecret('u1', 'v1', 'TOKEN', 'old');
    await savePersonalSecret('u1', 'v1', 'TOKEN', 'new');

    expect(await readPersonalSecret('u1', 'v1', 'TOKEN')).toBe('new');
  });

  it('readAllPersonalSecrets — 일괄 조회', async () => {
    const { savePersonalSecret, readAllPersonalSecrets } = await getModule();

    await savePersonalSecret('u1', 'v1', 'K1', 'v1');
    await savePersonalSecret('u1', 'v1', 'K2', 'v2');

    const result = await readAllPersonalSecrets('u1', 'v1', ['K1', 'K2', 'K_MISSING']);
    expect(result).toEqual({ K1: 'v1', K2: 'v2' });
    expect(result).not.toHaveProperty('K_MISSING');
  });

  it('암호화 파일이 손상된 경우 빈 스토어로 복구', async () => {
    const { savePersonalSecret, readPersonalSecret } = await getModule();

    // 정상 저장
    await savePersonalSecret('u1', 'v1', 'K', 'val');

    // 파일 손상
    const encFile = path.join(tmpDir, 'personal-vault.enc');
    fs.writeFileSync(encFile, 'corrupted-data');

    // 손상된 파일 → null (스토어 초기화)
    const val = await readPersonalSecret('u1', 'v1', 'K');
    expect(val).toBeNull();
  });
});
