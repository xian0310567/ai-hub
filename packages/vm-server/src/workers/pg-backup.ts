/**
 * PostgreSQL 자동 백업 워커
 * pg_dump를 실행하여 DATA_DIR/backups/postgres/ 에 저장.
 * 기본값: 6시간마다, 최대 7개 보관.
 */

import { exec as execCmd } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(execCmd);

const DATA_DIR = process.env.DATA_DIR || '.data';
const PG_BACKUP_DIR = path.join(DATA_DIR, 'backups', 'postgres');
const MAX_PG_BACKUPS = 7;
const INTERVAL_MS = Number(process.env.PG_BACKUP_INTERVAL_MS) || 6 * 60 * 60 * 1000; // 6시간

async function runPgDump(): Promise<void> {
  fs.mkdirSync(PG_BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(PG_BACKUP_DIR, `${ts}.sql`);
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/aihub';

  try {
    await execAsync(`pg_dump "${url}" --no-password -f "${outPath}"`);
    console.log(`[pg-backup] 완료: ${outPath}`);

    // 오래된 백업 정리
    const files = fs.readdirSync(PG_BACKUP_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
    while (files.length > MAX_PG_BACKUPS) {
      fs.unlinkSync(path.join(PG_BACKUP_DIR, files.shift()!));
    }
  } catch (err) {
    console.error('[pg-backup] pg_dump 실패:', err);
  }
}

export function startPgBackup(): void {
  if (!process.env.DATABASE_URL) {
    console.warn('[pg-backup] DATABASE_URL 없음 — pg_dump 건너뜀');
    return;
  }
  // 서버 완전 시작 후 30초 뒤 첫 백업
  setTimeout(runPgDump, 30_000);
  setInterval(runPgDump, INTERVAL_MS);
  console.log(`[pg-backup] 시작 (${INTERVAL_MS / 3600000}시간 간격)`);
}
