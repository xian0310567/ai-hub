import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { db, newId } from '../db/schema.js';
import { requireAuth, requireRole } from '../db/auth.js';

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
  // Vault 목록
  app.get('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    return db.prepare('SELECT id,org_id,scope,team_id,name,description,expires_at,created_at FROM vaults WHERE org_id = ? ORDER BY created_at').all(user.orgId);
  });

  // Vault 생성 (org_admin만)
  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;

    const { name, scope, team_id, description, expires_at } = req.body as {
      name: string; scope?: string; team_id?: string; description?: string; expires_at?: number;
    };
    if (!name) return reply.code(400).send({ error: 'name required' });

    const id = newId();
    db.prepare('INSERT INTO vaults(id,org_id,scope,team_id,name,description,expires_at) VALUES(?,?,?,?,?,?,?)').run(
      id, user.orgId, scope ?? 'org', team_id ?? null, name, description ?? '', expires_at ?? null
    );
    return reply.code(201).send(db.prepare('SELECT * FROM vaults WHERE id = ?').get(id));
  });

  // 시크릿 추가 (Write-only: 저장 후 값은 다시 조회 불가)
  app.post('/:vaultId/secrets', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;

    const { vaultId } = req.params as { vaultId: string };
    const { key_name, value } = req.body as { key_name: string; value: string };
    if (!key_name || !value) return reply.code(400).send({ error: 'key_name and value required' });

    const vault = db.prepare('SELECT id FROM vaults WHERE id = ? AND org_id = ?').get(vaultId, user.orgId);
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });

    const { encryptedValue, encryptedDek, iv, authTag } = encryptValue(value);
    const id = newId();
    const now = Math.floor(Date.now() / 1000);
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

  // 시크릿 키 목록 조회 (값은 마스킹)
  app.get('/:vaultId/secrets', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { vaultId } = req.params as { vaultId: string };

    const vault = db.prepare('SELECT id FROM vaults WHERE id = ? AND org_id = ?').get(vaultId, user.orgId);
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });

    return db.prepare('SELECT id, key_name, created_at, updated_at FROM vault_secrets WHERE vault_id = ? ORDER BY key_name').all(vaultId);
  });

  // 시크릿 Lease (데몬이 작업 실행 시 호출)
  app.post('/:vaultId/lease', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { vaultId } = req.params as { vaultId: string };
    const { task_id, key_names } = req.body as { task_id: string; key_names: string[] };

    const vault = db.prepare('SELECT id FROM vaults WHERE id = ? AND org_id = ?').get(vaultId, user.orgId);
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });

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
