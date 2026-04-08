import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { q1, qall, exec, newId, now } from '../db/pool.js';
import { requireAuth, requireRole } from '../db/auth.js';

const PERSONAL_PLACEHOLDER = '__personal__';

// ── Envelope Encryption ───────────────────────────────────────────────
function getMasterKey(): Buffer {
  const key = process.env.VAULT_MASTER_KEY;
  if (!key || key.length < 64) throw new Error('VAULT_MASTER_KEY must be set (32 bytes hex)');
  return Buffer.from(key, 'hex');
}

function encryptValue(plaintext: string) {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

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
  const dekIv = encryptedDekBuf.subarray(0, 12);
  const dekData = encryptedDekBuf.subarray(12, -16);
  const dekAuthTag = encryptedDekBuf.subarray(-16);

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
    return qall(`
      SELECT id,org_id,scope,team_id,owner_user_id,name,description,expires_at,created_at
      FROM vaults
      WHERE org_id = ? AND (scope != 'personal_meta' OR owner_user_id = ?)
      ORDER BY created_at
    `, [user.orgId, user.userId]);
  });

  // Vault 생성
  app.post('/', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { name, scope, team_id, description, expires_at } = req.body as {
      name: string; scope?: string; team_id?: string; description?: string; expires_at?: number;
    };
    if (!name) return reply.code(400).send({ error: 'name required' });

    const effectiveScope = scope ?? 'org';

    if (effectiveScope === 'personal_meta') {
      const id = newId();
      await exec(
        'INSERT INTO vaults(id,org_id,scope,team_id,owner_user_id,name,description,expires_at) VALUES(?,?,?,?,?,?,?,?)',
        [id, user.orgId, 'personal_meta', null, user.userId, name, description ?? '', expires_at ?? null],
      );
      return reply.code(201).send(await q1('SELECT * FROM vaults WHERE id = ?', [id]));
    }

    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const id = newId();
    await exec(
      'INSERT INTO vaults(id,org_id,scope,team_id,owner_user_id,name,description,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      [id, user.orgId, effectiveScope, team_id ?? null, null, name, description ?? '', expires_at ?? null],
    );
    return reply.code(201).send(await q1('SELECT * FROM vaults WHERE id = ?', [id]));
  });

  // 시크릿 추가
  app.post('/:vaultId/secrets', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { vaultId } = req.params as { vaultId: string };
    const { key_name, value } = req.body as { key_name: string; value?: string };
    if (!key_name) return reply.code(400).send({ error: 'key_name required' });

    const vault = await q1<{ id: string; scope: string; owner_user_id: string | null }>(
      'SELECT id,scope,owner_user_id FROM vaults WHERE id = ? AND org_id = ?',
      [vaultId, user.orgId],
    );
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });

    const id = newId();
    const ts = now();

    if (vault.scope === 'personal_meta') {
      if (vault.owner_user_id !== user.userId) return reply.code(403).send({ error: 'Forbidden' });

      await exec(`
        INSERT INTO vault_secrets(id,vault_id,key_name,encrypted_value,encrypted_dek,iv,auth_tag,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(vault_id,key_name) DO UPDATE SET updated_at = EXCLUDED.updated_at
      `, [id, vaultId, key_name, PERSONAL_PLACEHOLDER, PERSONAL_PLACEHOLDER, PERSONAL_PLACEHOLDER, PERSONAL_PLACEHOLDER, ts, ts]);

      await exec(
        'INSERT INTO audit_logs(id,org_id,user_id,action,resource,resource_id,meta) VALUES(?,?,?,?,?,?,?)',
        [newId(), user.orgId, user.userId, 'vault.personal.key_registered', 'vault_secret', vaultId, JSON.stringify({ key_name })],
      );
      return reply.code(201).send({ ok: true, key_name });
    }

    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    if (!value) return reply.code(400).send({ error: 'value required' });

    const { encryptedValue, encryptedDek, iv, authTag } = encryptValue(value);
    await exec(`
      INSERT INTO vault_secrets(id,vault_id,key_name,encrypted_value,encrypted_dek,iv,auth_tag,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(vault_id,key_name) DO UPDATE SET
        encrypted_value = EXCLUDED.encrypted_value,
        encrypted_dek = EXCLUDED.encrypted_dek,
        iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, updated_at = EXCLUDED.updated_at
    `, [id, vaultId, key_name, encryptedValue, encryptedDek, iv, authTag, ts, ts]);

    await exec(
      'INSERT INTO audit_logs(id,org_id,user_id,action,resource,resource_id,meta) VALUES(?,?,?,?,?,?,?)',
      [newId(), user.orgId, user.userId, 'vault.secret.write', 'vault_secret', vaultId, JSON.stringify({ key_name })],
    );
    return reply.code(201).send({ ok: true, key_name });
  });

  // Vault 메타데이터 수정
  app.patch('/:vaultId', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { vaultId } = req.params as { vaultId: string };
    const { name, description, expires_at } = req.body as {
      name?: string; description?: string; expires_at?: number | null;
    };

    const vault = await q1('SELECT id FROM vaults WHERE id = ? AND org_id = ?', [vaultId, user.orgId]);
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });

    if (name !== undefined) await exec('UPDATE vaults SET name = ? WHERE id = ?', [name, vaultId]);
    if (description !== undefined) await exec('UPDATE vaults SET description = ? WHERE id = ?', [description, vaultId]);
    if (expires_at !== undefined) await exec('UPDATE vaults SET expires_at = ? WHERE id = ?', [expires_at, vaultId]);

    return q1('SELECT id,org_id,scope,team_id,name,description,expires_at,created_at FROM vaults WHERE id = ?', [vaultId]);
  });

  // Vault 삭제
  app.delete('/:vaultId', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin'], reply)) return;
    const { vaultId } = req.params as { vaultId: string };
    await exec('DELETE FROM vaults WHERE id = ? AND org_id = ?', [vaultId, user.orgId]);
    return { ok: true };
  });

  // 시크릿 키 목록 (값 제외)
  app.get('/:vaultId/secrets', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { vaultId } = req.params as { vaultId: string };
    const vault = await q1('SELECT id FROM vaults WHERE id = ? AND org_id = ?', [vaultId, user.orgId]);
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });
    return qall(
      'SELECT id, key_name, created_at, updated_at FROM vault_secrets WHERE vault_id = ? ORDER BY key_name',
      [vaultId],
    );
  });

  // 시크릿 삭제
  app.delete('/:vaultId/secrets/:secretId', async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!requireRole(user, ['org_admin', 'team_admin'], reply)) return;
    const { vaultId, secretId } = req.params as { vaultId: string; secretId: string };
    const vault = await q1('SELECT id FROM vaults WHERE id = ? AND org_id = ?', [vaultId, user.orgId]);
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });
    await exec('DELETE FROM vault_secrets WHERE id = ? AND vault_id = ?', [secretId, vaultId]);
    return { ok: true };
  });

  // Lease (personal_meta는 403)
  app.post('/:vaultId/lease', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { vaultId } = req.params as { vaultId: string };
    const { task_id, key_names } = req.body as { task_id: string; key_names: string[] };

    const vault = await q1<{ id: string; scope: string }>(
      'SELECT id,scope FROM vaults WHERE id = ? AND org_id = ?',
      [vaultId, user.orgId],
    );
    if (!vault) return reply.code(404).send({ error: 'Vault not found' });

    if (vault.scope === 'personal_meta') {
      return reply.code(403).send({
        error: "personal_meta vault secrets are stored locally on the user's PC — use the electron-app personal vault API",
      });
    }

    const secrets: Record<string, string> = {};
    for (const key_name of key_names) {
      const row = await q1<{
        encrypted_value: string; encrypted_dek: string; iv: string; auth_tag: string;
      }>('SELECT * FROM vault_secrets WHERE vault_id = ? AND key_name = ?', [vaultId, key_name]);
      if (!row) continue;
      secrets[key_name] = decryptValue(row.encrypted_value, row.encrypted_dek, row.iv, row.auth_tag);
    }

    await exec(
      'INSERT INTO audit_logs(id,org_id,user_id,action,resource,resource_id,meta) VALUES(?,?,?,?,?,?,?)',
      [newId(), user.orgId, user.userId, 'vault.lease', 'vault', vaultId, JSON.stringify({ task_id, key_names })],
    );

    return { secrets };
  });
}
