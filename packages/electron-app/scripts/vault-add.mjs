#!/usr/bin/env node
/**
 * aihub vault add — Personal Vault CLI 마법사
 *
 * 사용법:
 *   node scripts/vault-add.mjs
 *   VM_SERVER_URL=http://192.168.1.10:4000 node scripts/vault-add.mjs
 *
 * 또는 package.json scripts에 추가:
 *   "vault:add": "node scripts/vault-add.mjs"
 *
 * 환경변수:
 *   VM_SERVER_URL      vm-server 주소 (기본: http://localhost:4000)
 *   DATA_DIR           데이터 디렉토리 (기본: .data)
 *   AIHUB_SESSION      vm_session 쿠키값 (없으면 마법사가 로그인 요청)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createInterface } from 'readline';

const VM_URL = process.env.VM_SERVER_URL ?? 'http://localhost:4000';
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), '.data');

// ── 암호화 폴백 (keytar 미사용 — CLI는 항상 파일 폴백 사용) ──────────
const FALLBACK_KEY = crypto
  .createHash('sha256')
  .update(`ai-hub:personal-vault:${DATA_DIR}`)
  .digest();
const FALLBACK_PATH = path.join(DATA_DIR, 'personal-vault.enc');

function readStore() {
  try {
    const raw = fs.readFileSync(FALLBACK_PATH);
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', FALLBACK_KEY, iv);
    decipher.setAuthTag(authTag);
    return JSON.parse(
      Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'),
    );
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', FALLBACK_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  fs.writeFileSync(FALLBACK_PATH, Buffer.concat([iv, authTag, encrypted]));
}

// ── readline 헬퍼 ──────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function askHidden(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.setRawMode?.(true);
    let value = '';
    const onData = (char) => {
      const str = char.toString();
      if (str === '\r' || str === '\n') {
        process.stdin.setRawMode?.(false);
        process.stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (str === '\u0003') {
        process.exit(0);
      } else if (str === '\u007f') {
        if (value.length > 0) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        value += str;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

// ── vm-server API ──────────────────────────────────────────────────────
async function vmFetch(path, options = {}) {
  const { body, method = 'GET', cookie } = options;
  const res = await fetch(`${VM_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: `session=${cookie}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

// ── 메인 ──────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔐  AI Hub — Personal Vault CLI 마법사\n');
  console.log(`  vm-server: ${VM_URL}`);
  console.log(`  데이터 디렉토리: ${DATA_DIR}\n`);

  // 1. 세션 확인 / 로그인
  let sessionCookie = process.env.AIHUB_SESSION ?? null;
  let userId = null;

  // 세션 파일에서 읽기
  if (!sessionCookie) {
    const sessionFile = path.join(DATA_DIR, 'daemon-session.json');
    if (fs.existsSync(sessionFile)) {
      try {
        const d = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        sessionCookie = d.session ?? null;
      } catch {}
    }
  }

  // 세션 검증
  if (sessionCookie) {
    const r = await vmFetch('/api/auth/me', { cookie: sessionCookie });
    if (r.ok && r.data?.id) {
      userId = r.data.id;
      console.log(`  ✓ 로그인 상태: ${r.data.username} (${r.data.id})\n`);
    } else {
      sessionCookie = null;
    }
  }

  // 로그인이 필요한 경우
  if (!sessionCookie) {
    console.log('  로그인이 필요합니다.\n');
    const username = await ask('  사용자명: ');
    const password = await askHidden('  비밀번호: ');
    const r = await vmFetch('/api/auth/signin', { method: 'POST', body: { username, password } });
    if (!r.ok) {
      console.error('\n  ✗ 로그인 실패:', r.data?.error ?? '알 수 없는 오류');
      process.exit(1);
    }
    userId = r.data?.user?.id ?? r.data?.id;
    sessionCookie = r.data?.session ?? null;
    // Set-Cookie에서 추출 (fetch API limitation — 실제 쿠키는 응답 헤더에 있음)
    if (!sessionCookie) {
      console.error('\n  ✗ 세션 쿠키를 가져올 수 없습니다. daemon-session.json을 확인하세요.');
      process.exit(1);
    }
    console.log('\n  ✓ 로그인 성공\n');
  }

  if (!userId) {
    console.error('  ✗ 사용자 ID를 확인할 수 없습니다.');
    process.exit(1);
  }

  // 2. Personal Vault 목록 조회
  const vaultsRes = await vmFetch('/api/vaults', { cookie: sessionCookie });
  if (!vaultsRes.ok) {
    console.error('  ✗ Vault 목록 조회 실패');
    process.exit(1);
  }

  const personalVaults = (vaultsRes.data ?? []).filter(v => v.scope === 'personal_meta');

  let vaultId = null;

  if (personalVaults.length === 0) {
    console.log('  개인 Vault가 없습니다. 새로 생성합니다.\n');
    const vaultName = await ask('  Vault 이름 (예: 내 개인 키): ');
    const createRes = await vmFetch('/api/vaults', {
      method: 'POST',
      cookie: sessionCookie,
      body: { name: vaultName.trim() || '내 개인 Vault', scope: 'personal_meta' },
    });
    if (!createRes.ok || !createRes.data?.id) {
      console.error('  ✗ Vault 생성 실패:', createRes.data?.error);
      process.exit(1);
    }
    vaultId = createRes.data.id;
    console.log(`  ✓ Vault 생성됨: ${createRes.data.name} (${vaultId})\n`);
  } else if (personalVaults.length === 1) {
    vaultId = personalVaults[0].id;
    console.log(`  ✓ 개인 Vault: ${personalVaults[0].name} (${vaultId})\n`);
  } else {
    console.log('  개인 Vault를 선택하세요:\n');
    personalVaults.forEach((v, i) => console.log(`    [${i + 1}] ${v.name} (${v.id})`));
    const choice = await ask('\n  번호 입력: ');
    const idx = parseInt(choice.trim(), 10) - 1;
    if (idx < 0 || idx >= personalVaults.length) {
      console.error('  ✗ 잘못된 선택');
      process.exit(1);
    }
    vaultId = personalVaults[idx].id;
    console.log(`  ✓ 선택됨: ${personalVaults[idx].name}\n`);
  }

  // 3. 키 이름 + 값 입력
  const keyName = (await ask('  키 이름 (예: GITHUB_TOKEN): ')).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!keyName) { console.error('  ✗ 키 이름이 비어있습니다.'); process.exit(1); }

  const value = await askHidden(`  값 (${keyName}): `);
  if (!value) { console.error('  ✗ 값이 비어있습니다.'); process.exit(1); }

  // 4. 로컬 파일에 저장
  const store = readStore();
  store[`${userId}/${vaultId}/${keyName}`] = value;
  writeStore(store);
  console.log('  ✓ 로컬 파일에 저장됨');

  // 5. vm-server에 메타데이터 등록
  const secretRes = await vmFetch(`/api/vaults/${vaultId}/secrets`, {
    method: 'POST',
    cookie: sessionCookie,
    body: { key_name: keyName, value: '__personal__' },
  });

  if (!secretRes.ok && secretRes.status !== 409) {
    console.error('  ✗ 메타데이터 등록 실패 (로컬에는 저장됨):', secretRes.data?.error);
    process.exit(1);
  }

  if (secretRes.status === 409) {
    console.log('  ✓ 메타데이터 이미 등록됨 (로컬 값 업데이트)');
  } else {
    console.log('  ✓ vm-server 메타데이터 등록됨');
  }

  console.log(`\n  ✅ ${keyName} 저장 완료!\n`);
  rl.close();
}

main().catch(err => {
  console.error('\n  ✗ 오류:', err.message);
  process.exit(1);
});
