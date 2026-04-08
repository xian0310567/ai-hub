import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db, newId } from '../db/schema.js';
import { requireAuth, requireRole } from '../db/auth.js';

// personal_meta vault secrets는 값을 서버에 저장하지 않음 (사용자 PC 로컬에만)
const PERSONAL_PLACEHOLDER = '__personal__';

// ─────────────────────────────────────────────────────
// Envelope Encryption 유틸
// KEK: 환경변수 VAULT_MASTER_KEY (32바이트 hex)
// DEK: 시크릿마다 랜덤 생성
// ─────────────────────────────────────────────────────
function getMasterKey(): Buffer {
  const key = process.env.VAULT_MASTER_KEY;
  if (!key || key.length < 64) throw new Error('VAULT_MASTER_KEY must be set (32 bytes hex)');
  return Buffer.from(key, 'hex');
}

function encryptValue(plaintext: string): {
  encryptedValue: string; encryptedDek: string; iv: string; authTag: string;
} {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // KEK으로 DEK 암호화
  const kek = getMasterKey();
  const dekIv = crypto.randomBytes(12);
  const dekCipher = crypto.createCipheriv('aes-256-gcm', kek, dekIv);
  const encryptedDek = Buffer.concat([dekIv, dekCipher.update(dek), dekCipher.final(), dekCipher.getAuthTag()]);

  return {
    encryptedValue: encrypted.toString('base64'),
    encryptedDek: encryptedDek.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decryptValue(encryptedValue: string, encryptedDekB64: string, ivB64: string, authTagB64: string): string {
  const kek = getMasterKey();
  const encryptedDekBuf = Buffer.from(encryptedDekB64, 'base64');
  const dekIv = encryptedDekBuf.slice(0, 12);
  const dekData = encryptedDekBuf.slice(12, -16);
  const dekAuthTag = encryptedDekBuf.slice(-16);

  const dekDecipher = crypto.createDecipheriv('aes-256-gcm', kek, dekIv);
  dekDecipher.setAuthTag(dekAuthTag);
  const dek = Buffer.concat([dekDecipher.update(dekData), dekDecipher.final()]);

  const iv = Buffer.from(ivB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64')), decipher.final()]).toString('utf8');
}

export async function vaultRoutes(app: FastifyInstance) {
  // Vault 목록 (personal_meta는 본인 것만)
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    return db.prepare(`
      SELECT id,org_id,scope,team_id,owner_user_id,name,description,expires_at,created_at
      FROM vaults
      WHERE org_id = ? AND (scope != 'personal_meta' OR owner_user_id = ?)
      ORDER BY created_at
    `).all(user.orgId, user.userId);
  });

  // Vault 생성
  // - personal_meta: 모든 멤버 생성 가능, owner_user_id = 본인
  // - org/team: org_admin/team_admin만 생성 가능
  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);

    const { name, scope, team_id, description, expires_at } = req.body as {
      name: string; scope?: string; team_id?: string; description?: string; expires_at?: number;
    };
    if (!name) return reply.code(400).send({ error: 'name required' });

    const effectiveScope = scope ?? 'org';

    if (effectiveScope === 'personal_meta') {
      const id = newId();
      db.prepare('INSERT INTO vaults(id,org_id,scope,team_id,owner_user_id,name,description,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(
        id, user.orgId, 'personal_meta', null, user.userId, name, description ?? '', expires_at ?? null
      );
      return reply.code(201).send(db.prepare('SELECT * FROM vaults WHERE id = ?').get(id));
    }

    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const id = newId();
    db.prepare('INSERT INTO vaults(id,org_id,scope,team_id,owner_user_id,name,description,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(
      id, user.orgId, effectiveScope, team_id ?? null, null, name, description ?? '', expires_at ?? null
    );
    return reply.code(201).send(db.prepare('SELECT * FROM vaults WHERE id = ?').get(id));
  });

  // 시크릿 추가
  // - personal_meta: key_name만 등록 (값은 사용자 PC 로컬에 저장됨)
  // - org/team: 암호화하여 서버에 저장 (Write-only)
  app.post('/:vaultId/secrets', async (req, reply) => {
    const user = await requireAuth(req, reply);

    const { vaultId } = req.params as { vaultId: string };
    const { key_name, value } = req.body as { key_name: string; value?: string };
    if (!key_name) return reply.code(400).send({ error: 'key_name required' });

    const vault = db.prepare('SELECT id,scope,owner_user_id FROM vaults WHERE id = ? AND org_id = ?').get(vaultId, user.orgId) as {
      id: string; scope: string; owner_user_id: string | null;
    } | undefined;
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });

    const id = newId();
    const now = Math.floor(Date.now() / 1000);

    if (vault.scope === 'personal_meta') {
      // 본인 personal vault만 관리 가능
      if (vault.owner_user_id !== user.userId) return reply.code(403).send({ error: 'Forbidden' });

      // 값은 로컬에만 저장. 서버에는 key_name만 (placeholder)
      db.prepare(`
        INSERT INTO vault_secrets(id,vault_id,key_name,encrypted_value,encrypted_dek,iv,auth_tag,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(vault_id,key_name) DO UPDATE SET updated_at=excluded.updated_at
      `).run(id, vaultId, key_name, PERSONAL_PLACEHOLDER, PERSONAL_PLACEHOLDER, PERSONAL_PLACEHOLDER, PERSONAL_PLACEHOLDER, now, now);

      db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,resource,resource_id,meta) VALUES(?,?,?,?,?,?,?)').run(
        newId(), user.orgId, user.userId, 'vault.personal.key_registered', 'vault_secret', vaultId,
        JSON.stringify({ key_name })
      );
      return reply.code(201).send({ ok: true, key_name });
    }

    // org/team vault
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    if (!value) return reply.code(400).send({ error: 'value required' });

    const { encryptedValue, encryptedDek, iv, authTag } = encryptValue(value);
    db.prepare(`
      INSERT INTO vault_secrets(id,vault_id,key_name,encrypted_value,encrypted_dek,iv,auth_tag,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(vault_id,key_name) DO UPDATE SET
        encrypted_value=excluded.encrypted_value,
        encrypted_dek=excluded.encrypted_dek,
        iv=excluded.iv, auth_tag=excluded.auth_tag, updated_at=excluded.updated_at
    `).run(id, vaultId, key_name, encryptedValue, encryptedDek, iv, authTag, now, now);

    // Audit log
    db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,resource,resource_id,meta) VALUES(?,?,?,?,?,?,?)').run(
      newId(), user.orgId, user.userId, 'vault.secret.write', 'vault_secret', vaultId,
      JSON.stringify({ key_name })
    );

    return reply.code(201).send({ ok: true, key_name });
  });

  // Vault 메타데이터 수정
  app.patch('/:vaultId', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { vaultId } = req.params as { vaultId: string };
    const { name, description, expires_at } = req.body as { name?: string; description?: string; expires_at?: number | null };

    const vault = db.prepare('SELECT id FROM vaults WHERE id = ? AND org_id = ?').get(vaultId, user.orgId);
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });

    if (name !== undefined) db.prepare('UPDATE vaults SET name = ? WHERE id = ?').run(name, vaultId);
    if (description !== undefined) db.prepare('UPDATE vaults SET description = ? WHERE id = ?').run(description, vaultId);
    if (expires_at !== undefined) db.prepare('UPDATE vaults SET expires_at = ? WHERE id = ?').run(expires_at, vaultId);

    return db.prepare('SELECT id,org_id,scope,team_id,name,description,expires_at,created_at FROM vaults WHERE id = ?').get(vaultId);
  });

  // Vault 삭제
  app.delete('/:vaultId', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { vaultId } = req.params as { vaultId: string };
    db.prepare('DELETE FROM vaults WHERE id = ? AND org_id = ?').run(vaultId, user.orgId);
    return { ok: true };
  });

  // 시크릿 키 목록 조회 (값은 마스킹)
  app.get('/:vaultId/secrets', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { vaultId } = req.params as { vaultId: string };

    const vault = db.prepare('SELECT id FROM vaults WHERE id = ? AND org_id = ?').get(vaultId, user.orgId);
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });

    return db.prepare('SELECT id, key_name, created_at, updated_at FROM vault_secrets WHERE vault_id = ? ORDER BY key_name').all(vaultId);
  });

  // 시크릿 삭제
  app.delete('/:vaultId/secrets/:secretId', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { vaultId, secretId } = req.params as { vaultId: string; secretId: string };

    const vault = db.prepare('SELECT id FROM vaults WHERE id = ? AND org_id = ?').get(vaultId, user.orgId);
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });

    db.prepare('DELETE FROM vault_secrets WHERE id = ? AND vault_id = ?').run(secretId, vaultId);
    return { ok: true };
  });

  // 시크릿 Lease (데몬이 작업 실행 시 호출)
  // personal_meta vault는 서버에 값 없음 → 403 반환
  app.post('/:vaultId/lease', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { vaultId } = req.params as { vaultId: string };
    const { task_id, key_names } = req.body as { task_id: string; key_names: string[] };

    const vault = db.prepare('SELECT id,scope FROM vaults WHERE id = ? AND org_id = ?').get(vaultId, user.orgId) as {
      id: string; scope: string;
    } | undefined;
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });

    if (vault.scope === 'personal_meta') {
      return reply.code(403).send({ error: 'personal_meta vault secrets are stored locally on the user\'s PC — use the electron-app personal vault API' });
    }

    const secrets: Record<string, string> = {};
    for (const key_name of key_names) {
      const row = db.prepare('SELECT * FROM vault_secrets WHERE vault_id = ? AND key_name = ?').get(vaultId, key_name) as {
        encrypted_value: string; encrypted_dek: string; iv: string; auth_tag: string;
      } | undefined;
      if (!row) continue;
      secrets[key_name] = decryptValue(row.encrypted_value, row.encrypted_dek, row.iv, row.auth_tag);
    }

    // Audit log
    db.prepare('INSERT INTO audit_logs(id,org_id,user_id,action,resource,resource_id,meta) VALUES(?,?,?,?,?,?,?)').run(
      newId(), user.orgId, user.userId, 'vault.lease', 'vault', vaultId,
      JSON.stringify({ task_id, key_names })
    );

    return { secrets };
  });
}
