/**
 * electron-app 인증 헬퍼
 * 세션은 vm-server에서 관리되며, vm_session 쿠키로 중계됨
 */
import { NextRequest } from 'next/server';
import path from 'path';

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');

export interface SessionUser {
  id: string;
  username: string;
  orgId?: string;
  role?: string;
}

/**
 * 요청에서 vm_session 쿠키를 꺼내 vm-server /api/auth/me로 검증
 * API 라우트에서 현재 사용자 정보가 필요할 때 사용
 */
export async function getSession(req: NextRequest): Promise<SessionUser | null> {
  const session = req.cookies.get('vm_session')?.value;
  if (!session) return null;

  try {
    const res = await fetch(`${VM_URL}/api/auth/me`, {
      headers: { Cookie: `session=${session}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as { id: string; username: string; orgs: { org_id: string; role: string }[] };
    return {
      id: data.id,
      username: data.username,
      orgId: data.orgs?.[0]?.org_id,
      role: data.orgs?.[0]?.role,
    };
  } catch {
    return null;
  }
}

/** vm_session 쿠키값만 꺼내기 (vm-server 직접 호출 시 사용) */
export function getVmSessionCookie(req: NextRequest): string {
  const session = req.cookies.get('vm_session')?.value;
  return session ? `session=${session}` : '';
}

// 유저별 로컬 경로 헬퍼 (Claude CLI 실행용)
export function getUserWorkspacesDir(userId: string): string {
  return path.join(DATA_DIR, 'users', userId, 'workspaces');
}

export function getUserClaudeConfigDir(userId: string): string {
  return path.join(DATA_DIR, 'users', userId, '.claude');
}

export function getUserSessionsDir(userId: string): string {
  return path.join(DATA_DIR, 'users', userId, 'sessions');
}
