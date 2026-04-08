/**
 * 백업 라우트 — SQLite 파일 업로드/다운로드/목록
 *
 * POST /api/backup/sqlite         — SQLite 파일 업로드 (application/octet-stream)
 * GET  /api/backup/sqlite         — 백업 목록 조회
 * GET  /api/backup/sqlite/:ts     — 특정 백업 다운로드
 */

import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../db/auth.js';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || '.data';
const MAX_BACKUPS = 10;

function sqliteDir(userId: string): string {
  const dir = path.join(DATA_DIR, 'backups', 'sqlite', userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listBackups(userId: string) {
  const dir = sqliteDir(userId);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.db'))
    .sort()
    .reverse()
    .map(f => ({
      timestamp: f.replace('.db', ''),
      size: fs.statSync(path.join(dir, f)).size,
      created_at: fs.statSync(path.join(dir, f)).mtimeMs,
    }));
}

export async function backupRoutes(app: FastifyInstance) {
  // Raw binary body parser
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  // POST /sqlite — SQLite 파일 업로드
  app.post('/sqlite', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const body = req.body as Buffer;
    if (!body || body.length === 0)
      return reply.code(400).send({ error: 'Empty body' });

    const dir = sqliteDir(user.userId);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `${ts}.db`);
    fs.writeFileSync(filePath, body);

    // 오래된 백업 정리 (최대 MAX_BACKUPS 개 유지)
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
    while (files.length > MAX_BACKUPS) {
      fs.unlinkSync(path.join(dir, files.shift()!));
    }

    return { ok: true, timestamp: ts, size: body.length };
  });

  // GET /sqlite — 백업 목록
  app.get('/sqlite', async (req, reply) => {
    const user = await requireAuth(req, reply);
    return { ok: true, backups: listBackups(user.userId) };
  });

  // GET /sqlite/:ts — 특정 백업 다운로드
  app.get('/sqlite/:ts', async (req, reply) => {
    const user = await requireAuth(req, reply);
    const { ts } = req.params as { ts: string };
    const filePath = path.join(sqliteDir(user.userId), `${ts}.db`);
    if (!fs.existsSync(filePath))
      return reply.code(404).send({ error: 'Backup not found' });

    const data = fs.readFileSync(filePath);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="aihub-local-${ts}.db"`);
    return reply.send(data);
  });
}
