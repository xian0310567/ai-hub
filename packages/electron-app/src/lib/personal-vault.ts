/**
 * Personal Vault — OS 키체인 기반 시크릿 관리
 *
 * 우선순위:
 *   1. keytar (macOS Keychain / Windows Credential Manager / Linux Secret Service)
 *   2. 파일 기반 폴백 (DATA_DIR/personal-vault.enc, AES-256-GCM)
 *
 * vm-server에는 key_name 메타데이터만 존재. 실제 값은 절대 서버에 보내지 않음.
 */

import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

const SERVICE_NAME = 'ai-hub';
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), '.data');

// ── keytar (optional) ──────────────────────────────────────────────────
type Keytar = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

let _keytar: Keytar | null | undefined; // undefined = 미초기화

async function getKeytar(): Promise<Keytar | null> {
  if (_keytar !== undefined) return _keytar;
  try {
    const mod = await import('keytar');
    _keytar = (mod.default ?? mod) as unknown as Keytar;
    return _keytar;
  } catch {
    _keytar = null;
    return null;
  }
}

// ── 파일 기반 폴백 ─────────────────────────────────────────────────────
// DATA_DIR 경로를 기반으로 머신 고유 키를 파생 (개발/CI 환경용)
const FALLBACK_KEY = crypto
  .createHash('sha256')
  .update(`ai-hub:personal-vault:${DATA_DIR}`)
  .digest();

function getFallbackPath(): string {
  return path.join(DATA_DIR, 'personal-vault.enc');
}

function readFallbackStore(): Record<string, string> {
  try {
    const raw = fs.readFileSync(getFallbackPath());
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', FALLBACK_KEY, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeFallbackStore(store: Record<string, string>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', FALLBACK_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(store), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // 파일 형식: [iv(12)] [authTag(16)] [encrypted]
  fs.writeFileSync(getFallbackPath(), Buffer.concat([iv, authTag, encrypted]));
}

// ── 계정 키 형식: "userId/vaultId/keyName" ────────────────────────────
function accountKey(userId: string, vaultId: string, keyName: string): string {
  return `${userId}/${vaultId}/${keyName}`;
}

// ── Public API ─────────────────────────────────────────────────────────

export async function savePersonalSecret(
  userId: string,
  vaultId: string,
  keyName: string,
  value: string,
): Promise<void> {
  const kt = await getKeytar();
  if (kt) {
    await kt.setPassword(SERVICE_NAME, accountKey(userId, vaultId, keyName), value);
  } else {
    const store = readFallbackStore();
    store[accountKey(userId, vaultId, keyName)] = value;
    writeFallbackStore(store);
  }
}

export async function readPersonalSecret(
  userId: string,
  vaultId: string,
  keyName: string,
): Promise<string | null> {
  const kt = await getKeytar();
  if (kt) {
    return kt.getPassword(SERVICE_NAME, accountKey(userId, vaultId, keyName));
  }
  const store = readFallbackStore();
  return store[accountKey(userId, vaultId, keyName)] ?? null;
}

export async function deletePersonalSecret(
  userId: string,
  vaultId: string,
  keyName: string,
): Promise<void> {
  const kt = await getKeytar();
  if (kt) {
    await kt.deletePassword(SERVICE_NAME, accountKey(userId, vaultId, keyName));
  } else {
    const store = readFallbackStore();
    delete store[accountKey(userId, vaultId, keyName)];
    writeFallbackStore(store);
  }
}

/** 여러 key_name에 대해 한 번에 조회. 값이 없으면 결과에 포함하지 않음 */
export async function readAllPersonalSecrets(
  userId: string,
  vaultId: string,
  keyNames: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await Promise.all(
    keyNames.map(async (keyName) => {
      const value = await readPersonalSecret(userId, vaultId, keyName);
      if (value !== null) result[keyName] = value;
    }),
  );
  return result;
}
