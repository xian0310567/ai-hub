/**
 * Unit tests for electron-app/src/lib/auth.ts
 * Pure function / path helper tests (no file I/O).
 * getSession is tested with mocked fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock fetch globally before the module loads
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock next/server (not used by auth.ts, but imported transitively)
vi.mock('next/server', () => {
  class MockNextRequest {
    cookies: { get: (name: string) => { value: string } | undefined };
    constructor() {
      this.cookies = { get: () => undefined };
    }
  }
  return { NextRequest: MockNextRequest };
});

import {
  getVmSessionCookie,
  getUserWorkspacesDir,
  getUserClaudeConfigDir,
  getUserSessionsDir,
  getSession,
} from '../lib/auth.js';
import { NextRequest } from 'next/server';

function makeRequest(sessionValue?: string) {
  const req = new NextRequest() as never;
  (req as { cookies: { get: (n: string) => { value: string } | undefined } }).cookies = {
    get: (name: string) => (name === 'vm_session' && sessionValue ? { value: sessionValue } : undefined),
  };
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DATA_DIR;
});

describe('getVmSessionCookie', () => {
  it('returns formatted session string', () => {
    const req = makeRequest('abc123');
    expect(getVmSessionCookie(req)).toBe('session=abc123');
  });

  it('returns empty string when no cookie', () => {
    const req = makeRequest();
    expect(getVmSessionCookie(req)).toBe('');
  });
});

describe('path helpers', () => {
  const userId = 'user-123';

  // DATA_DIR is captured at module load time, so we verify path structure
  // rather than a specific absolute root.

  it('getUserWorkspacesDir ends with correct relative path', () => {
    const result = getUserWorkspacesDir(userId);
    expect(result).toMatch(/users[/\\]user-123[/\\]workspaces$/);
  });

  it('getUserClaudeConfigDir ends with correct relative path', () => {
    const result = getUserClaudeConfigDir(userId);
    expect(result).toMatch(/users[/\\]user-123[/\\]\.claude$/);
  });

  it('getUserSessionsDir ends with correct relative path', () => {
    const result = getUserSessionsDir(userId);
    expect(result).toMatch(/users[/\\]user-123[/\\]sessions$/);
  });
});

describe('getSession', () => {
  it('returns null when no vm_session cookie', async () => {
    const req = makeRequest();
    const result = await getSession(req);
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls /api/auth/me and returns SessionUser on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'u1',
        username: 'alice',
        orgs: [{ org_id: 'org1', role: 'org_admin' }],
      }),
    });

    const req = makeRequest('test-session');
    const result = await getSession(req);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('u1');
    expect(result!.username).toBe('alice');
    expect(result!.orgId).toBe('org1');
    expect(result!.role).toBe('org_admin');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/auth/me');
    expect((init.headers as Record<string, string>)['Cookie']).toBe('session=test-session');
  });

  it('returns null when vm-server returns non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });

    const req = makeRequest('expired-session');
    const result = await getSession(req);
    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const req = makeRequest('some-session');
    const result = await getSession(req);
    expect(result).toBeNull();
  });

  it('returns orgId and role from first org', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'u2',
        username: 'bob',
        orgs: [
          { org_id: 'orgA', role: 'member' },
          { org_id: 'orgB', role: 'org_admin' },
        ],
      }),
    });

    const req = makeRequest('bob-session');
    const result = await getSession(req);
    expect(result!.orgId).toBe('orgA'); // first org only
    expect(result!.role).toBe('member');
  });
});
