import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { Sessions } from './db';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}

export function createSessionToken(userId: string): string {
  const id = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30일
  Sessions.create({ id, user_id: userId, expires_at: expiresAt });
  return id;
}

export function getSession(req: NextRequest): { id: string; username: string } | null {
  const sessionId = req.cookies.get('session')?.value;
  if (!sessionId) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = Sessions.get(sessionId, now);
  if (!row) return null;
  return { id: row.uid, username: row.username };
}

// 유저별 데이터 경로 헬퍼
export function getUserWorkspacesDir(userId: string): string {
  return path.join(DATA_DIR, 'users', userId, 'workspaces');
}

export function getUserClaudeConfigDir(userId: string): string {
  return path.join(DATA_DIR, 'users', userId, '.claude');
}

export function getUserSessionsDir(userId: string): string {
  return path.join(DATA_DIR, 'users', userId, 'sessions');
}
