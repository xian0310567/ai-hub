/**
 * Unit tests for electron-app/src/lib/vm-proxy.ts
 * All fetch calls are mocked — no real HTTP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch BEFORE importing the module under test
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// We also need NextRequest/NextResponse — mock them minimally
vi.mock('next/server', () => {
  class MockNextRequest {
    url: string;
    cookies: { get: (name: string) => { value: string } | undefined };
    _body: unknown;
    constructor(url: string, init?: { body?: string; headers?: Record<string, string> }) {
      this.url = url;
      this._body = init?.body ? JSON.parse(init.body) : undefined;
      this.cookies = {
        get: (name: string) => {
          if (name === 'vm_session') return { value: 'test-session-id' };
          return undefined;
        },
      };
    }
    async json() { return this._body; }
  }

  class MockNextResponse {
    static _instances: MockNextResponse[] = [];
    body: unknown;
    status: number;
    headers: Headers;
    cookies: { set: (name: string, val: string, opts?: object) => void; _data: Record<string, string> };

    constructor(body: unknown, init?: { status?: number }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers();
      this.cookies = {
        _data: {},
        set(name: string, val: string) { this._data[name] = val; },
      };
    }

    static json(body: unknown, init?: { status?: number }) {
      const inst = new MockNextResponse(body, init);
      MockNextResponse._instances.push(inst);
      return inst;
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

import { getVmCookie, proxyToVm, proxyBodyToVm } from '../lib/vm-proxy.js';
import { NextRequest } from 'next/server';

function makeRequest(hasSession = true) {
  const req = new NextRequest('http://localhost/test') as never;
  if (!hasSession) {
    (req as { cookies: { get: (n: string) => undefined } }).cookies = { get: () => undefined };
  }
  return req;
}

function makeFetchResponse(body: unknown, status = 200, setCookie?: string) {
  const headers = new Headers();
  if (setCookie) headers.set('set-cookie', setCookie);
  return Promise.resolve({
    status,
    headers,
    json: () => Promise.resolve(body),
  } as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getVmCookie', () => {
  it('returns formatted cookie string when vm_session exists', () => {
    const req = makeRequest(true);
    const result = getVmCookie(req);
    expect(result).toBe('session=test-session-id');
  });

  it('returns empty string when no vm_session cookie', () => {
    const req = makeRequest(false);
    const result = getVmCookie(req);
    expect(result).toBe('');
  });
});

describe('proxyToVm', () => {
  it('calls vm-server with Cookie header and returns JSON response', async () => {
    mockFetch.mockReturnValueOnce(makeFetchResponse({ data: 'ok' }, 200));
    const req = makeRequest();
    const res = await proxyToVm(req, '/api/test');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/test');
    expect((init.headers as Record<string, string>)['Cookie']).toBe('session=test-session-id');
    expect((res as { body: unknown }).body).toEqual({ data: 'ok' });
    expect((res as { status: number }).status).toBe(200);
  });

  it('relays Set-Cookie from vm-server as vm_session cookie', async () => {
    mockFetch.mockReturnValueOnce(
      makeFetchResponse({ ok: true }, 200, 'session=new-session-abc; Path=/; HttpOnly')
    );
    const req = makeRequest();
    const res = await proxyToVm(req, '/api/auth/signin');

    const cookieData = (res as { cookies: { _data: Record<string, string> } }).cookies._data;
    expect(cookieData['vm_session']).toBe('new-session-abc');
  });

  it('passes through non-200 status codes', async () => {
    mockFetch.mockReturnValueOnce(makeFetchResponse({ error: 'Not Found' }, 404));
    const req = makeRequest();
    const res = await proxyToVm(req, '/api/missing');
    expect((res as { status: number }).status).toBe(404);
  });
});

describe('proxyBodyToVm', () => {
  it('sends request body as JSON', async () => {
    mockFetch.mockReturnValueOnce(makeFetchResponse({ created: true }, 201));
    const req = new NextRequest('http://localhost/test', {
      body: JSON.stringify({ name: 'test', value: 42 }),
    }) as never;

    const res = await proxyBodyToVm(req, '/api/create', 'POST');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'test', value: 42 });
    expect((res as { status: number }).status).toBe(201);
  });

  it('works with PATCH method', async () => {
    mockFetch.mockReturnValueOnce(makeFetchResponse({ updated: true }, 200));
    const req = new NextRequest('http://localhost/test', {
      body: JSON.stringify({ id: '123', name: 'updated' }),
    }) as never;

    await proxyBodyToVm(req, '/api/items', 'PATCH');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
  });
});
