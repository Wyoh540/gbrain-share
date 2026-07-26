/**
 * Admin user auth flow — HTTP-level integration test.
 *
 * Boots `gbrain serve --http` in a tempdir PGLite, then exercises:
 *   1. Bootstrap-first-admin (creates first admin user)
 *   2. Bootstrap endpoint closed after first admin
 *   3. Password login → session cookie
 *   4. Authenticated users/roles API access
 *   5. Unauthenticated rejection
 *   6. Non-admin user rejection at /admin/login
 *   7. Bootstrap-token login still works alongside password login
 *
 * Serial because all tests share a single server process. The server is
 * started once in beforeAll and torn down in afterAll.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Subprocess } from 'bun';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BOOTSTRAP_TOKEN = 'bootstrap-aaaa-bbbb-cccc-dddd-eeee-ffffff';

// ---------------------------------------------------------------------------
// Server lifecycle (shared across all tests — describe.serial)
// ---------------------------------------------------------------------------

function pickPort(): number {
  return 32000 + Math.floor(Math.random() * 4000);
}

interface ServerState {
  port: number;
  home: string;
  proc: Subprocess;
  cookie: string; // set after login
  adminUser: { id: string; username: string };
  nonAdminUser: { id: string; username: string; password: string };
}

/** Cookie from Set-Cookie header. Bun fetch doesn't auto-store cookies like a
 *  browser, so we extract and re-send them manually. */
function extractCookie(setCookie: string | null): string | null {
  return setCookie?.match(/gbrain_admin=([^;]+)/)?.[1] ?? null;
}

async function spawnServer(bootstrapToken: string): Promise<Omit<ServerState, 'cookie' | 'adminUser' | 'nonAdminUser'>> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-admin-auth-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });

  // Pre-initialize the PGLite database BEFORE starting the server. A
  // fresh PGLite database runs 120 schema migrations (v1 → v125) that
  // take ~90s; if we let `serve` run them internally, the stderr pipe
  // would fill and block the process. Pre-init also means the server
  // starts in <5s instead of >90s.
  const initResult = Bun.spawnSync(
    ['bun', 'run', `${REPO}/src/cli.ts`, 'init', '--pglite', '--non-interactive', '--no-embedding'],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        GBRAIN_HOME: home,
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (initResult.exitCode !== 0) {
    const errText = new TextDecoder().decode(initResult.stderr).slice(0, 4000);
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`gbrain init --pglite --no-embedding failed (exit ${initResult.exitCode}): ${errText}`);
  }

  // Overwrite config: init wrote `embedding_disabled: true` (--no-embedding);
  // the server needs `embedding_dimensions` to type-check vector columns.
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: join(home, '.gbrain', 'brain.pglite'),
      embedding_dimensions: 1536,
    }) + '\n',
  );

  const port = pickPort();

  const proc = Bun.spawn(
    ['bun', 'run', `${REPO}/src/cli.ts`, 'serve', '--http', '--port', String(port), '--bind', '127.0.0.1'],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        GBRAIN_HOME: home,
        GBRAIN_ADMIN_BOOTSTRAP_TOKEN: bootstrapToken,
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  // Drain stderr in background so the pipe buffer never fills.
  const stderrChunks: string[] = [];
  (async () => {
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(new TextDecoder().decode(value));
      }
    } catch { /* stream closed */ }
  })();

  // Poll /health until ready. Since the DB is pre-initialized, this
  // should take <5s.
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 250));
  }

  if (!ready) {
    const stderrText = stderrChunks.join('').slice(0, 4000);
    try { proc.kill('SIGKILL'); } catch { /* best effort */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(
      `serve --http never became ready on port ${port} after 30s. stderr: ${stderrText}`,
    );
  }

  return { port, home, proc };
}

async function cleanupServer(s: { proc: Subprocess; home: string }) {
  try { s.proc.kill('SIGTERM'); } catch { /* already exited */ }
  await Promise.race([
    s.proc.exited,
    new Promise(r => setTimeout(r, 2000)),
  ]);
  try { s.proc.kill('SIGKILL'); } catch { /* already gone */ }
  try { rmSync(s.home, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Tests (serial — they depend on shared server state)
// ---------------------------------------------------------------------------

describe.serial('admin user auth flow', () => {
  let s: ServerState;

  beforeAll(async () => {
    s = (await spawnServer(BOOTSTRAP_TOKEN)) as ServerState;
  }, 180_000);

  afterAll(async () => {
    if (s) await cleanupServer(s);
  });

  // --- Bootstrap ---

  test('POST /admin/api/bootstrap-first-admin creates the first admin user', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/admin/api/bootstrap-first-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bootstrapToken: BOOTSTRAP_TOKEN,
        username: 'admin',
        password: 'supersecretpassword',
      }),
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('created');
    expect(typeof body.userId).toBe('string');
    expect(body.userId.startsWith('usr_')).toBe(true);

    s.adminUser = { id: body.userId, username: 'admin' };
  }, 30_000);

  test('POST /admin/api/bootstrap-first-admin is closed after the first admin', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/admin/api/bootstrap-first-admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bootstrapToken: BOOTSTRAP_TOKEN,
        username: 'second-admin',
        password: 'anotherpassword123',
      }),
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(403);
  }, 30_000);

  // --- Login ---

  test('POST /admin/login with username+password returns session cookie', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'supersecretpassword' }),
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('authenticated');

    const setCookie = res.headers.get('set-cookie');
    const cookie = extractCookie(setCookie);
    expect(cookie).toBeTruthy();
    expect(typeof cookie).toBe('string');
    expect(cookie!.length).toBeGreaterThanOrEqual(32);

    s.cookie = cookie!;
  }, 30_000);

  // --- Authenticated API access ---

  test('GET /admin/api/users with cookie returns user list including admin', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/admin/api/users`, {
      headers: { Cookie: `gbrain_admin=${s.cookie}` },
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users.length).toBeGreaterThanOrEqual(1);

    const adminUser = body.users.find((u: any) => u.username === 'admin');
    expect(adminUser).toBeTruthy();
    expect(adminUser.isAdmin).toBe(true);
  }, 30_000);

  test('GET /admin/api/users without cookie returns 401', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/admin/api/users`, {
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(401);
  }, 30_000);

  test('POST /admin/api/users with cookie creates a non-admin user', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/admin/api/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `gbrain_admin=${s.cookie}`,
      },
      body: JSON.stringify({
        username: 'alice.member',
        password: 'alicepassword123',
        display_name: 'Alice Member',
        is_admin: false,
      }),
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBe('alice.member');
    expect(body.isAdmin).toBe(false);
    expect(body.status).toBe('active');

    s.nonAdminUser = { id: body.id, username: 'alice.member', password: 'alicepassword123' };
  }, 30_000);

  test('non-admin user cannot log in to /admin/login', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: s.nonAdminUser.username,
        password: s.nonAdminUser.password,
      }),
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(401);
  }, 30_000);

  // --- Roles API ---

  test('GET /admin/api/roles with cookie returns role list', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/admin/api/roles`, {
      headers: { Cookie: `gbrain_admin=${s.cookie}` },
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.roles)).toBe(true);
  }, 30_000);

  test('POST /admin/api/roles with cookie creates a role', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/admin/api/roles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `gbrain_admin=${s.cookie}`,
      },
      body: JSON.stringify({ role_id: 'analysts', description: 'Read-only analyst role' }),
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('created');
  }, 30_000);

  // --- Bootstrap token login still works ---

  test('POST /admin/login with bootstrap token still works', async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('authenticated');
  }, 30_000);
});
