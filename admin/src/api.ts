const BASE = '';

// v0.26.3 trust model (D11 + D12): the admin UI does NOT cache the
// bootstrap token in browser JS state. On 401, redirect to login —
// no auto-reauth via saved token, no localStorage/sessionStorage read.
// The HttpOnly cookie set by /admin/login is the only session credential.
async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (res.status === 401) {
    // No token cache to retry from. Redirect to login.
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// v0.36.1.0 (T15 / E6) — SVG fetch (text/plain payload, NOT JSON).
async function apiFetchText(path: string) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin' });
  if (res.status === 401) {
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const api = {
  login: (token: string, username?: string, password?: string) => {
    const body: Record<string, string> = { token };
    if (username && password) { body.username = username; body.password = password; }
    return apiFetch('/admin/login', { method: 'POST', body: JSON.stringify(body) });
  },
  stats: () => apiFetch('/admin/api/stats'),
  health: () => apiFetch('/admin/api/health-indicators'),
  agents: () => apiFetch('/admin/api/agents'),
  requests: (page = 1, qs = '') => apiFetch(`/admin/api/requests?page=${page}${qs}`),
  apiKeys: () => apiFetch('/admin/api/api-keys'),
  createApiKey: (name: string) => apiFetch('/admin/api/api-keys', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeApiKey: (name: string) => apiFetch('/admin/api/api-keys/revoke', { method: 'POST', body: JSON.stringify({ name }) }),
  updateClientTtl: (clientId: string, tokenTtl: number | null) => apiFetch('/admin/api/update-client-ttl', { method: 'POST', body: JSON.stringify({ clientId, tokenTtl }) }),
  revokeClient: (clientId: string) => apiFetch('/admin/api/revoke-client', { method: 'POST', body: JSON.stringify({ clientId }) }),
  // v0.36.1.0 (T15 / E6) — calibration endpoints.
  calibrationProfile: (holder?: string) =>
    apiFetch(`/admin/api/calibration/profile${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  calibrationChart: (type: string, holder?: string) =>
    apiFetchText(`/admin/api/calibration/charts/${encodeURIComponent(type)}${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  // v0.41 D2 — live minion-jobs dashboard snapshot.
  jobsWatch: () => apiFetch('/admin/api/jobs/watch'),
  // Multi-user auth — users & roles management
  listUsers: () => apiFetch('/admin/api/users'),
  createUser: (username: string, password: string, displayName?: string, email?: string, isAdmin?: boolean) =>
    apiFetch('/admin/api/users', { method: 'POST', body: JSON.stringify({ username, password, display_name: displayName, email, is_admin: isAdmin }) }),
  resetUserPassword: (userId: string, password: string) =>
    apiFetch(`/admin/api/users/${encodeURIComponent(userId)}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  setUserStatus: (userId: string, status: 'active' | 'disabled') =>
    apiFetch(`/admin/api/users/${encodeURIComponent(userId)}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  setUserRoles: (userId: string, roles: string[]) =>
    apiFetch(`/admin/api/users/${encodeURIComponent(userId)}/roles`, { method: 'POST', body: JSON.stringify({ roles }) }),
  listRoles: () => apiFetch('/admin/api/roles'),
  createRole: (id: string, description?: string) =>
    apiFetch('/admin/api/roles', { method: 'POST', body: JSON.stringify({ role_id: id, description }) }),
  setRoleSources: (roleId: string, grants: Array<{ sourceId: string; access: 'read' | 'write' }>) =>
    apiFetch(`/admin/api/roles/${encodeURIComponent(roleId)}/sources`, { method: 'POST', body: JSON.stringify({ grants }) }),
  deleteRole: (roleId: string) =>
    apiFetch(`/admin/api/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' }),
};
