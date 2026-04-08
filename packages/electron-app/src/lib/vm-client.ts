/**
 * vm-server API 클라이언트
 * electron-app의 Next.js → VM 서버로 요청을 중계
 */

const VM_URL = process.env.VM_SERVER_URL || 'http://localhost:4000';

export class VmApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function vmFetch<T>(
  path: string,
  options: RequestInit & { cookie?: string } = {}
): Promise<T> {
  const { cookie, ...rest } = options;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(cookie ? { Cookie: cookie } : {}),
    ...(rest.headers as Record<string, string> ?? {}),
  };

  const res = await fetch(`${VM_URL}${path}`, { ...rest, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new VmApiError(res.status, body.error ?? 'Unknown error');
  }

  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────
export const vmAuth = {
  me:      (cookie: string) => vmFetch('/api/auth/me', { cookie }),
  signin:  (body: { username: string; password: string }) =>
    vmFetch('/api/auth/signin', { method: 'POST', body: JSON.stringify(body) }),
  signup:  (body: { username: string; password: string; orgSlug?: string }) =>
    vmFetch('/api/auth/signup', { method: 'POST', body: JSON.stringify(body) }),
  signout: (cookie: string) =>
    vmFetch('/api/auth/signout', { method: 'POST', cookie }),
};

// ─────────────────────────────────────────────────────
// Orgs
// ─────────────────────────────────────────────────────
export const vmOrgs = {
  list:    (cookie: string) => vmFetch('/api/orgs', { cookie }),
  create:  (cookie: string, body: { name: string; slug: string }) =>
    vmFetch('/api/orgs', { method: 'POST', cookie, body: JSON.stringify(body) }),
  members: (cookie: string, orgId: string) => vmFetch(`/api/orgs/${orgId}/members`, { cookie }),
};

// ─────────────────────────────────────────────────────
// Divisions
// ─────────────────────────────────────────────────────
export const vmDivisions = {
  list:    (cookie: string) => vmFetch('/api/divisions', { cookie }),
  create:  (cookie: string, body: object) =>
    vmFetch('/api/divisions', { method: 'POST', cookie, body: JSON.stringify(body) }),
  update:  (cookie: string, body: object) =>
    vmFetch('/api/divisions', { method: 'PATCH', cookie, body: JSON.stringify(body) }),
  remove:  (cookie: string, id: string) =>
    vmFetch('/api/divisions', { method: 'DELETE', cookie, body: JSON.stringify({ id }) }),
  reorder: (cookie: string, ids: string[]) =>
    vmFetch('/api/divisions/reorder', { method: 'POST', cookie, body: JSON.stringify({ ids }) }),
};

// ─────────────────────────────────────────────────────
// Workspaces
// ─────────────────────────────────────────────────────
export const vmWorkspaces = {
  list:    (cookie: string) => vmFetch('/api/workspaces', { cookie }),
  create:  (cookie: string, body: object) =>
    vmFetch('/api/workspaces', { method: 'POST', cookie, body: JSON.stringify(body) }),
  update:  (cookie: string, body: object) =>
    vmFetch('/api/workspaces', { method: 'PATCH', cookie, body: JSON.stringify(body) }),
  remove:  (cookie: string, id: string) =>
    vmFetch('/api/workspaces', { method: 'DELETE', cookie, body: JSON.stringify({ id }) }),
  reorder: (cookie: string, ids: string[]) =>
    vmFetch('/api/workspaces/reorder', { method: 'POST', cookie, body: JSON.stringify({ ids }) }),
};

// ─────────────────────────────────────────────────────
// Teams
// ─────────────────────────────────────────────────────
export const vmTeams = {
  list:    (cookie: string, workspaceId?: string) =>
    vmFetch(`/api/teams${workspaceId ? `?workspace_id=${workspaceId}` : ''}`, { cookie }),
  create:  (cookie: string, body: object) =>
    vmFetch('/api/teams', { method: 'POST', cookie, body: JSON.stringify(body) }),
  update:  (cookie: string, body: object) =>
    vmFetch('/api/teams', { method: 'PATCH', cookie, body: JSON.stringify(body) }),
  remove:  (cookie: string, id: string) =>
    vmFetch('/api/teams', { method: 'DELETE', cookie, body: JSON.stringify({ id }) }),
};

// ─────────────────────────────────────────────────────
// Agents
// ─────────────────────────────────────────────────────
export const vmAgents = {
  list:    (cookie: string, params?: { workspace_id?: string; team_id?: string }) => {
    const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    return vmFetch(`/api/agents${qs}`, { cookie });
  },
  get:     (cookie: string, id: string) => vmFetch(`/api/agents/${id}`, { cookie }),
  create:  (cookie: string, body: object) =>
    vmFetch('/api/agents', { method: 'POST', cookie, body: JSON.stringify(body) }),
  update:  (cookie: string, body: object) =>
    vmFetch('/api/agents', { method: 'PATCH', cookie, body: JSON.stringify(body) }),
  remove:  (cookie: string, id: string) =>
    vmFetch('/api/agents', { method: 'DELETE', cookie, body: JSON.stringify({ id }) }),
};

// ─────────────────────────────────────────────────────
// Hosts
// ─────────────────────────────────────────────────────
export const vmHosts = {
  list:      (cookie: string) => vmFetch('/api/hosts', { cookie }),
  register:  (cookie: string, name: string) =>
    vmFetch('/api/hosts/register', { method: 'POST', cookie, body: JSON.stringify({ name }) }),
  heartbeat: (cookie: string, hostId: string, status?: string) =>
    vmFetch(`/api/hosts/${hostId}/heartbeat`, { method: 'POST', cookie, body: JSON.stringify({ status }) }),
};

// ─────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────
export const vmTasks = {
  list:   (cookie: string, params?: object) => {
    const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    return vmFetch(`/api/tasks${qs}`, { cookie });
  },
  poll:   (cookie: string, body: { host_id: string; trigger_type?: string }) =>
    vmFetch('/api/tasks/poll', { method: 'POST', cookie, body: JSON.stringify(body) }),
  create: (cookie: string, body: object) =>
    vmFetch('/api/tasks', { method: 'POST', cookie, body: JSON.stringify(body) }),
  update: (cookie: string, body: object) =>
    vmFetch('/api/tasks', { method: 'PATCH', cookie, body: JSON.stringify(body) }),
};

// ─────────────────────────────────────────────────────
// Vaults
// ─────────────────────────────────────────────────────
export const vmVaults = {
  list:      (cookie: string) => vmFetch('/api/vaults', { cookie }),
  create:    (cookie: string, body: object) =>
    vmFetch('/api/vaults', { method: 'POST', cookie, body: JSON.stringify(body) }),
  secrets:   (cookie: string, vaultId: string) => vmFetch(`/api/vaults/${vaultId}/secrets`, { cookie }),
  addSecret: (cookie: string, vaultId: string, body: { key_name: string; value: string }) =>
    vmFetch(`/api/vaults/${vaultId}/secrets`, { method: 'POST', cookie, body: JSON.stringify(body) }),
  lease:     (cookie: string, vaultId: string, body: { task_id: string; key_names: string[] }) =>
    vmFetch(`/api/vaults/${vaultId}/lease`, { method: 'POST', cookie, body: JSON.stringify(body) }),
};
