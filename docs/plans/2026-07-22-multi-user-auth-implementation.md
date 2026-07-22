# Multi-User Auth + Role-Based Source Permissions — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add first-class human users (username/password login on the OAuth authorization_code flow) with role-based per-source read/write permissions, managed by an admin through the existing `/admin` dashboard.

**Architecture:** Users are first-class DB entities; tokens minted via the browser login flow carry `user_id`; `verifyAccessToken` resolves role-union permissions live per request and populates the existing `AuthInfo.allowedSources` (read path: zero changes) plus a new `writeSources` (write path via one new choke helper `resolveWriteScope`). Machine clients (`client_credentials`, legacy tokens) are untouched. Design doc: `docs/plans/2026-07-22-multi-user-auth-design.md`.

**Tech Stack:** Bun, TypeScript, Express (serve-http), MCP SDK OAuth (`mcpAuthRouter`), React 19 + Vite (`admin/`), PGLite + Postgres dual engines, `Bun.password` (argon2id), bun test.

**Repo discipline (applies to EVERY task):**
- Capture test output: `bun test test/x.test.ts > /tmp/t.txt 2>&1; echo "EXIT=$?"; tail -30 /tmp/t.txt` — NEVER pipe through tail directly (CLAUDE.md iron rule).
- Schema changes land in FOUR places in the same commit: `src/core/migrate.ts` (new MIGRATIONS entry), `src/schema.sql`, `src/core/pglite-schema.ts`, `src/core/schema-embedded.ts`.
- jsonb writes: never `JSON.stringify` into `::jsonb`; use `executeRawJsonb` / `sql.json()` (#2339 class).
- Fail-closed: anything not strictly `ctx.remote === false` is untrusted. New permission helpers default-deny.
- Engine parity: SQL added to one engine's probe/schema path must land in both; `test/e2e/engine-parity.test.ts` pins it.
- Branch: all work on `feat/multi-user-auth`. Conventional-commit subjects (`feat(auth): ...`, `test(auth): ...`). Version bumps + CHANGELOG are NOT part of this plan (that's `/ship`).
- Run `bun run typecheck > /tmp/tc.txt 2>&1; echo "EXIT=$?"` before every commit.

---

### Task 1: Schema migration v119 — users, roles, permissions, pending logins, token user_id

**Files:**
- Modify: `src/core/migrate.ts` — append MIGRATIONS entry after v118
- Modify: `src/schema.sql` — append tables after the `oauth_codes` block (~line 700)
- Modify: `src/core/pglite-schema.ts` — mirror the DDL
- Modify: `src/core/schema-embedded.ts` — mirror the DDL
- Test: `test/multi-user-schema.test.ts` (new)

**Step 1: Write the failing test**

```typescript
// test/multi-user-schema.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

// Boots a fresh PGLite with the embedded schema, asserts the multi-user
// tables/columns exist with the right constraints.
test('multi-user schema: tables and columns exist', async () => {
  const db = new PGlite();
  const ddl = readFileSync('src/core/pglite-schema.ts', 'utf8');
  // pglite-schema.ts exports the schema as SQL; apply it the same way the
  // engine bootstrap does (reuse the existing test helper if one exists —
  // check test/schema-bootstrap-coverage.test.ts for the canonical pattern).
  // Then:
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_name IN ('users','roles','role_source_permissions','user_roles','oauth_pending_logins')`,
  );
  expect(new Set(tables.rows.map(r => r.table_name))).toEqual(
    new Set(['users','roles','role_source_permissions','user_roles','oauth_pending_logins']),
  );
  const cols = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'oauth_tokens' AND column_name = 'user_id'`,
  );
  expect(cols.rows.length).toBe(1);
  await db.close();
});
```

(If `test/schema-bootstrap-coverage.test.ts` already exposes a bootstrap helper, use it instead of hand-applying DDL — read that file first.)

**Step 2: Run test to verify it fails**

Run: `bun test test/multi-user-schema.test.ts > /tmp/t1.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t1.txt`
Expected: FAIL — tables do not exist.

**Step 3: Implement the migration**

Append to `MIGRATIONS` in `src/core/migrate.ts` (after v118):

```typescript
  {
    version: 119,
    name: 'multi_user_auth_tables',
    // Multi-user auth: first-class human users + role-based per-source
    // permissions. users.is_admin gates user/role MANAGEMENT only (orthogonal
    // to source access; admins read content via roles like everyone else).
    // oauth_pending_logins backs the browser login page on /authorize
    // (10-min TTL, swept by sweepExpiredTokens). oauth_codes.user_id /
    // oauth_tokens.user_id bind the authorization-code flow to a user;
    // NULL = machine client (client_credentials / legacy), behavior unchanged.
    // Keep in sync with src/schema.sql, src/core/pglite-schema.ts,
    // src/core/schema-embedded.ts.
    idempotent: true,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        display_name  TEXT,
        email         TEXT,
        password_hash TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'active',
        is_admin      BOOLEAN NOT NULL DEFAULT false,
        must_reset_password BOOLEAN NOT NULL DEFAULT false,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS roles (
        id          TEXT PRIMARY KEY,
        description TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS role_source_permissions (
        role_id   TEXT NOT NULL REFERENCES roles(id)   ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        access    TEXT NOT NULL CHECK (access IN ('read','write')),
        PRIMARY KEY (role_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, role_id)
      );
      CREATE TABLE IF NOT EXISTS oauth_pending_logins (
        nonce      TEXT PRIMARY KEY,
        client_id  TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        params     JSONB NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE oauth_codes  ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
      ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS username TEXT;
    `,
  },
```

Apply the identical DDL to `src/schema.sql` (fresh-install path, near the oauth tables), `src/core/pglite-schema.ts`, and `src/core/schema-embedded.ts`. If `mcp_request_log` is created in those files, add the `username` column inline there too; the migration keeps the `ALTER … IF NOT EXISTS` for upgrades. Check `test/schema-bootstrap-coverage.test.ts` — if it asserts a probe set of tables/columns, add the new tables there (it is designed to fail until you do).

**Step 4: Run test to verify it passes**

Run: `bun test test/multi-user-schema.test.ts test/schema-bootstrap-coverage.test.ts > /tmp/t1.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t1.txt`
Expected: PASS both.

**Step 5: Commit**

```bash
bun run typecheck > /tmp/tc.txt 2>&1; echo "EXIT=$?"
git add src/core/migrate.ts src/schema.sql src/core/pglite-schema.ts src/core/schema-embedded.ts test/multi-user-schema.test.ts test/schema-bootstrap-coverage.test.ts
git commit -m "feat(auth): schema v119 — users, roles, source permissions, pending logins"
```

---

### Task 2: `src/core/users.ts` — user store with argon2id passwords

**Files:**
- Create: `src/core/users.ts`
- Test: `test/users-store.test.ts` (new)

**Step 1: Write the failing test**

```typescript
// test/users-store.test.ts — PGLite-backed, mirrors test/oauth.test.ts setup.
import { test, expect } from 'bun:test';
import {
  createUser, verifyUserPassword, setUserPassword, disableUser,
  getUserByUsername, assignUserRoles, getUserEffectivePermissions,
} from '../src/core/users.ts';

test('create + verify + disable + permissions union', async () => {
  const sql = await makeTestSql(); // helper: fresh PGLite with schema; copy the
                                   // pattern from test/oauth.test.ts
  await sql`INSERT INTO sources (id, name) VALUES ('shared','Shared'), ('internal','Internal')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO roles (id) VALUES ('sales'), ('ops')`;
  await sql`INSERT INTO role_source_permissions (role_id, source_id, access) VALUES
            ('sales','shared','write'), ('ops','internal','read')`;

  const u = await createUser(sql, { username: 'alice-example', password: 'correct horse battery', displayName: 'Alice' });
  expect(u.id).toStartWith('usr_');
  expect(u.mustResetPassword).toBe(true);

  expect(await verifyUserPassword(sql, 'alice-example', 'wrong')).toBeNull();
  const verified = await verifyUserPassword(sql, 'alice-example', 'correct horse battery');
  expect(verified?.id).toBe(u.id);

  await assignUserRoles(sql, u.id, ['sales', 'ops']);
  const perms = await getUserEffectivePermissions(sql, u.id);
  expect(perms.readSources.sort()).toEqual(['internal', 'shared']);
  expect(perms.writeSources).toEqual(['shared']);

  await setUserPassword(sql, u.id, 'new password 123');
  expect(await verifyUserPassword(sql, 'alice-example', 'correct horse battery')).toBeNull();
  expect(await verifyUserPassword(sql, 'alice-example', 'new password 123')).not.toBeNull();

  await disableUser(sql, u.id);
  expect(await verifyUserPassword(sql, 'alice-example', 'new password 123')).toBeNull(); // disabled = deny
  expect((await getUserByUsername(sql, 'alice-example'))?.status).toBe('disabled');
});

test('username uniqueness + validation', async () => {
  const sql = await makeTestSql();
  await createUser(sql, { username: 'bob-example', password: 'password12345' });
  await expect(createUser(sql, { username: 'bob-example', password: 'password12345' })).rejects.toThrow(/unique|exists/i);
  await expect(createUser(sql, { username: 'BAD NAME!', password: 'password12345' })).rejects.toThrow(/username/i);
  await expect(createUser(sql, { username: 'ok-name', password: 'short' })).rejects.toThrow(/password/i);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/users-store.test.ts > /tmp/t2.txt 2>&1; echo "EXIT=$?"`
Expected: FAIL — module does not exist.

**Step 3: Implement `src/core/users.ts`**

Contract (full implementation, ~150 LOC):

```typescript
import { generateToken } from './utils.ts';
import type { SqlQuery } from './sql-query.ts';

export interface UserRow {
  id: string; username: string; displayName?: string; email?: string;
  status: 'active' | 'disabled'; isAdmin: boolean; mustResetPassword: boolean;
  createdAt: string; updatedAt: string;
}
export interface EffectivePermissions { readSources: string[]; writeSources: string[]; }

const USERNAME_RE = /^[a-z0-9._-]{2,64}$/;
export const MIN_PASSWORD_LENGTH = 10;

export async function createUser(sql, opts: { username: string; password: string; displayName?: string; email?: string; isAdmin?: boolean }): Promise<UserRow>
// - validate USERNAME_RE + MIN_PASSWORD_LENGTH (throw Error with clear msg)
// - id = generateToken('usr_'); password_hash = await Bun.password.hash(password, { algorithm: 'argon2id' })
// - must_reset_password = true; status 'active'; INSERT; return row
// - unique violation → rethrow as Error(`username already exists: ${username}`)

export async function verifyUserPassword(sql, username: string, password: string): Promise<UserRow | null>
// - SELECT * FROM users WHERE username = $1. If none → run a DUMMY
//   Bun.password.verify against a constant hash (timing equalization) then return null.
// - status != 'active' → null (disabled = deny, same message path as wrong password)
// - Bun.password.verify(password, row.password_hash) → row or null

export async function setUserPassword(sql, userId: string, newPassword: string): Promise<void>
// hash + UPDATE …, must_reset_password = false, updated_at = now()

export async function disableUser(sql, userId: string): Promise<void>   // status='disabled'
export async function enableUser(sql, userId: string): Promise<void>    // status='active'
export async function getUserByUsername(sql, username: string): Promise<UserRow | null>
export async function listUsers(sql): Promise<(UserRow & { roles: string[] })[]>
// LEFT JOIN user_roles + array_agg(role_id)

export async function assignUserRoles(sql, userId: string, roleIds: string[]): Promise<void>
// DELETE FROM user_roles WHERE user_id; bulk INSERT new set (skip when empty).
// Validate every roleId exists in roles first — unknown role → Error listing it (fail-closed).

export async function getUserEffectivePermissions(sql, userId: string): Promise<EffectivePermissions>
// One query:
//   SELECT COALESCE(array_agg(DISTINCT rsp.source_id) FILTER (WHERE rsp.access IN ('read','write')), '{}') AS read_sources,
//          COALESCE(array_agg(DISTINCT rsp.source_id) FILTER (WHERE rsp.access = 'write'), '{}') AS write_sources
//   FROM user_roles ur JOIN role_source_permissions rsp ON rsp.role_id = ur.role_id
//   WHERE ur.user_id = $1
// Zero roles → { readSources: [], writeSources: [] } (fail-closed: user sees nothing).
```

Also add `lastUsedAt` touch is NOT needed here (token rows carry that).

**Step 4: Run test to verify it passes**

Run: `bun test test/users-store.test.ts > /tmp/t2.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t2.txt`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/users.ts test/users-store.test.ts
git commit -m "feat(auth): user store with argon2id passwords + role permission unions"
```

---

### Task 3: `src/core/roles.ts` — role + permission matrix store

**Files:**
- Create: `src/core/roles.ts`
- Test: `test/roles-store.test.ts` (new)

**Step 1: Write the failing test**

```typescript
import { test, expect } from 'bun:test';
import { createRole, setRoleSources, listRoles, deleteRole, getRoleMatrix } from '../src/core/roles.ts';

test('role CRUD + source matrix', async () => {
  const sql = await makeTestSql();
  await sql`INSERT INTO sources (id, name) VALUES ('shared','S'), ('customers','C'), ('internal','I') ON CONFLICT (id) DO NOTHING`;

  await createRole(sql, { id: 'sales', description: 'Sales team' });
  await setRoleSources(sql, 'sales', [
    { sourceId: 'customers', access: 'write' },
    { sourceId: 'shared', access: 'read' },
  ]);
  const matrix = await getRoleMatrix(sql, 'sales');
  expect(matrix).toEqual({ customers: 'write', shared: 'read' });

  const roles = await listRoles(sql);
  expect(roles[0].id).toBe('sales');
  expect(roles[0].sources).toEqual(matrix);
  expect(roles[0].memberCount).toBe(0);

  await setRoleSources(sql, 'sales', [{ sourceId: 'shared', access: 'read' }]); // replace, not merge
  expect(await getRoleMatrix(sql, 'sales')).toEqual({ shared: 'read' });

  await expect(setRoleSources(sql, 'sales', [{ sourceId: 'nope', access: 'read' }])).rejects.toThrow(/source/i);
  await expect(createRole(sql, { id: 'BAD ROLE' })).rejects.toThrow(/id/i);

  await deleteRole(sql, 'sales');
  expect(await listRoles(sql)).toEqual([]);
});
```

**Step 2: Run test to verify it fails** — `bun test test/roles-store.test.ts > /tmp/t3.txt 2>&1; echo "EXIT=$?"` → module missing.

**Step 3: Implement `src/core/roles.ts`**

```typescript
const ROLE_ID_RE = /^[a-z0-9-]{1,32}$/; // same charset as sources.id

export async function createRole(sql, opts: { id: string; description?: string }): Promise<void>
export async function deleteRole(sql, roleId: string): Promise<void>
// refuse to delete a built-in? No built-ins in phase 1. CASCADE cleans
// role_source_permissions + user_roles.
export async function setRoleSources(sql, roleId: string, grants: { sourceId: string; access: 'read' | 'write' }[]): Promise<void>
// Validate roleId exists; every sourceId exists in sources; access in ('read','write').
// Transaction semantics: DELETE existing grants for role, INSERT new set.
// NOT merge — full replacement (the admin UI submits the whole matrix row).
export async function getRoleMatrix(sql, roleId: string): Promise<Record<string, 'read' | 'write'>>
export async function listRoles(sql): Promise<{ id: string; description?: string; sources: Record<string, 'read'|'write'>; memberCount: number }[]>
```

**Step 4: Run tests pass** → **Step 5: Commit** `feat(auth): role store with per-source access matrix`

---

### Task 4: `AuthInfo` extension + `resolveWriteScope` choke helper

**Files:**
- Modify: `src/core/operations.ts:264-308` (AuthInfo), add `resolveWriteScope` near `resolveRequestedScope` (~line 519)
- Test: `test/resolve-write-scope.test.ts` (new)

**Step 1: Write the failing test**

```typescript
import { test, expect } from 'bun:test';
import { resolveWriteScope } from '../src/core/operations.ts';

const baseCtx = { remote: true } as any;

test('machine client: writeSources = [sourceId], unchanged semantics', () => {
  const ctx = { ...baseCtx, sourceId: 'dept-x', auth: { token: 't', clientId: 'c', scopes: ['write'], sourceId: 'dept-x', allowedSources: ['dept-x'] } };
  expect(resolveWriteScope(ctx, undefined)).toBe('dept-x');
  expect(resolveWriteScope(ctx, 'dept-x')).toBe('dept-x');
  expect(() => resolveWriteScope(ctx, 'other')).toThrow(/not granted write/i);
});

test('user token: union semantics', () => {
  const ctx = { ...baseCtx, sourceId: 'shared',
    auth: { token: 't', clientId: 'c', scopes: ['write'], userId: 'usr_1', username: 'alice-example',
            allowedSources: ['shared','customers'], writeSources: ['customers'] } };
  expect(resolveWriteScope(ctx, undefined)).toBe('customers'); // sole write source
  expect(resolveWriteScope(ctx, 'shared')).toThrow; // shared is read-only for alice
  expect(() => resolveWriteScope(ctx, 'shared')).toThrow(/not granted write/i);
  expect(() => resolveWriteScope(ctx, 'internal')).toThrow(/not granted write/i);
});

test('multi-write user must specify; read-only user refused', () => {
  const twoWrites = { ...baseCtx, sourceId: 'a', auth: { token: 't', clientId: 'c', scopes: ['write'], userId: 'usr_2', allowedSources: ['a','b'], writeSources: ['a','b'] } };
  expect(() => resolveWriteScope(twoWrites, undefined)).toThrow(/specify/i);
  expect(resolveWriteScope(twoWrites, 'b')).toBe('b');
  const readOnly = { ...baseCtx, sourceId: 'a', auth: { token: 't', clientId: 'c', scopes: ['read'], userId: 'usr_3', allowedSources: ['a'], writeSources: [] } };
  expect(() => resolveWriteScope(readOnly, undefined)).toThrow(/read-only|no write/i);
});
```

**Step 2: Run test to verify it fails** — export missing.

**Step 3: Implement**

In `AuthInfo` (operations.ts:264) append:

```typescript
  /** Human user id (multi-user auth). Absent = machine client / legacy token. */
  userId?: string;
  /** Login name of the human user, for audit + request-log attribution. */
  username?: string;
  /**
   * Union of source ids the user may WRITE (from roles). For machine clients
   * this is `[sourceId]`. Empty array = read-only subject. Fail-closed:
   * undefined is treated as `[sourceId ?? 'default']` by resolveWriteScope
   * for pre-multi-user rows.
   */
  writeSources?: string[];
```

Add next to `resolveRequestedScope`:

```typescript
/**
 * Resolve the source a WRITE op targets. Fail-closed choke point for all
 * write-side ops (put_page, capture, …). Precedence + rules:
 *   requested ∈ writeSources → requested
 *   no requested + exactly 1 writeSource → it
 *   no requested + 0 writeSources → throw (read-only subject)
 *   no requested + >1 writeSources → throw (must specify explicitly)
 *   requested ∉ writeSources → throw, error lists the granted set
 * Machine clients get writeSources=[sourceId] → behavior identical to the
 * pre-multi-user scalar model.
 */
export function resolveWriteScope(ctx: OperationContext, requested: string | undefined): string {
  const auth = ctx.auth;
  const writeSources = auth?.writeSources ?? (auth?.sourceId ? [auth.sourceId] : [ctx.sourceId]);
  if (requested !== undefined) {
    if (!writeSources.includes(requested)) {
      throw new Error(`Source "${requested}" not granted write. Writable: [${writeSources.join(', ') || '(none)'}]`);
    }
    return requested;
  }
  if (writeSources.length === 1) return writeSources[0];
  if (writeSources.length === 0) throw new Error('Read-only subject: no write sources granted');
  throw new Error(`Multiple write sources granted [${writeSources.join(', ')}]; specify --source explicitly`);
}
```

Do NOT rewire every write op in this task. Wire only `put_page` (the canonical write op): find where it resolves its target source and route it through `resolveWriteScope(ctx, requestedSourceParam)`. Other write ops migrate in Task 10 after the pattern is proven. Local CLI (`remote === false`) bypasses: keep existing behavior — gate the helper on `ctx.remote !== false && ctx.auth` so local single-user installs are untouched.

**Step 4: Run tests pass** — also run `bun test test/operations-fuzzy-source-scope.test.ts test/source-scope-resolver.test.ts > /tmp/t4.txt 2>&1; echo "EXIT=$?"` to prove no read-path regression.

**Step 5: Commit** `feat(auth): AuthInfo user fields + resolveWriteScope fail-closed write resolver`

---

### Task 5: oauth-provider — `user_id` threading + verifyAccessToken user branch

**Files:**
- Modify: `src/core/oauth-provider.ts` (`authorize`, `exchangeAuthorizationCode`, `exchangeRefreshToken`, `issueTokens`, `verifyAccessToken`, `sweepExpiredTokens`)
- Test: `test/oauth-user-tokens.test.ts` (new)

**Step 1: Write the failing test**

```typescript
import { test, expect } from 'bun:test';
// Mirror test/oauth.test.ts setup (PGLite + GBrainOAuthProvider + manual client).

test('code → token → refresh preserves user_id; verifyAccessToken resolves role union', async () => {
  const { provider, sql } = await makeProvider();
  // seed sources/roles/user: alice-example with role sales → write customers, read shared
  // …(reuse Task 2/3 stores)…
  const client = await provider.registerClientManual('claude-code', ['authorization_code'], 'read write', ['http://localhost:5555/cb'], 'default', ['default'], 'none');

  const code = await provider.__testOnlyIssueCodeForUser(client.client_id, {
    redirectUri: 'http://localhost:5555/cb', codeChallenge: 'abc', state: 's',
  }, aliceId); // NEW internal method — authorize() itself renders HTML (Task 6),
               // so the code-issuance core must be callable without a Response.

  const tokens = await provider.exchangeAuthorizationCode(
    (await provider.clientsStore.getClient(client.client_id))!, code, undefined, 'http://localhost:5555/cb');
  const info = await provider.verifyAccessToken(tokens.access_token) as any;
  expect(info.userId).toBe(aliceId);
  expect(info.username).toBe('alice-example');
  expect(info.allowedSources.sort()).toEqual(['customers', 'shared']);
  expect(info.writeSources).toEqual(['customers']);
  expect(info.sourceId).toBe('customers'); // default write source = sole write

  const refreshed = await provider.exchangeRefreshToken(
    (await provider.clientsStore.getClient(client.client_id))!, tokens.refresh_token!);
  const info2 = await provider.verifyAccessToken(refreshed.access_token) as any;
  expect(info2.userId).toBe(aliceId);

  // disabled user → token dies immediately
  await disableUser(sql, aliceId);
  await expect(provider.verifyAccessToken(info2.token ?? refreshed.access_token)).rejects.toThrow(/invalid|disabled/i);
});

test('machine token (client_credentials) has no user fields, machine branch unchanged', async () => {
  const { provider } = await makeProvider();
  const { clientId, clientSecret } = await provider.registerClientManual('cron', ['client_credentials'], 'read write', [], 'internal', ['internal','shared']);
  const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!);
  const info = await provider.verifyAccessToken(tokens.access_token) as any;
  expect(info.userId).toBeUndefined();
  expect(info.sourceId).toBe('internal');
  expect(info.allowedSources).toEqual(['internal','shared']);
  expect(info.writeSources).toEqual(['internal']); // derived from sourceId
});
```

**Step 2: Run test to verify it fails.**

**Step 3: Implement** — surgical changes to `src/core/oauth-provider.ts`:

1. `issueTokens(clientId, scopes, resource, includeRefresh, ttlOverride?, userId?: string)` — add trailing optional param; both INSERTs carry `user_id` (NULL when absent). Refactor signature to an options object if the positional list gets unwieldy — keep call sites readable.
2. `exchangeAuthorizationCode`: both `DELETE … RETURNING` forms add `user_id` to RETURNING; pass `codeRow.user_id` into `issueTokens`.
3. `exchangeRefreshToken`: add `user_id` to RETURNING; pass through.
4. New internal method `__testOnlyIssueCodeForUser(clientId, params, userId)` — the code-issuance core extracted from `authorize()` (Task 6 makes `authorize()` call it after login; tests call it directly).
5. `verifyAccessToken`: change the OAuth query to also select `t.user_id` and, when non-NULL, run the effective-permissions resolution in the SAME round trip:

```sql
SELECT t.client_id, t.scopes, t.expires_at, t.resource, t.user_id,
       c.client_name, c.source_id, c.federated_read,
       u.status AS user_status, u.username AS username,
       COALESCE((SELECT array_agg(DISTINCT rsp.source_id)
                 FROM user_roles ur JOIN role_source_permissions rsp ON rsp.role_id = ur.role_id
                 WHERE ur.user_id = t.user_id), '{}') AS read_sources,
       COALESCE((SELECT array_agg(DISTINCT rsp.source_id)
                 FROM user_roles ur JOIN role_source_permissions rsp ON rsp.role_id = ur.role_id
                 WHERE ur.user_id = t.user_id AND rsp.access = 'write'), '{}') AS write_sources
FROM oauth_tokens t
LEFT JOIN oauth_clients c ON c.client_id = t.client_id
LEFT JOIN users u ON u.id = t.user_id
WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
```

   - `user_id` NULL → existing branch verbatim, plus `writeSources: sourceId ? [sourceId] : undefined`.
   - `user_id` non-NULL → `user_status != 'active'` → `throw new InvalidTokenError('User disabled')`; else return AuthInfo with `userId`, `username`, `allowedSources: read_sources`, `writeSources: write_sources`, `sourceId: write_sources.length === 1 ? write_sources[0] : (write_sources[0] ?? read_sources[0])` (scalar backfill for legacy consumers; the real gate is resolveWriteScope).
   - Pre-v119 brains: `isUndefinedColumnError(err, 'user_id')` → fall through to the existing legacy projections (add the new probe to the existing chain; do not break partial-upgrade handling).
6. `sweepExpiredTokens`: also `DELETE FROM oauth_pending_logins WHERE expires_at < now RETURNING 1` (table may not exist pre-v119 — guard with `isUndefinedColumnError`).

**Step 4: Run tests pass** — also `bun test test/oauth.test.ts test/oauth-authorize-scope-default.test.ts test/oauth-confidential-client.test.ts > /tmp/t5.txt 2>&1; echo "EXIT=$?"` (no regressions on existing OAuth behavior).

**Step 5: Commit** `feat(auth): user-bound OAuth tokens with live role-union resolution`

---

### Task 6: Browser login on `/authorize` (password auth)

**Files:**
- Modify: `src/core/oauth-provider.ts` (`authorize` rewrite), maybe new `src/core/login-page.ts` for HTML
- Modify: `src/commands/serve-http.ts` — `POST /authorize/login` route + login rate limiter (~line 627 area)
- Test: `test/oauth-login-flow.test.ts` (new)

**Step 1: Write the failing test** (provider-level, no HTTP):

```typescript
test('authorize renders login page with pending nonce; login completes and issues user-bound code', async () => {
  const { provider, sql } = await makeProvider();
  await createUser(sql, { username: 'alice-example', password: 'correct horse battery' });
  const alice = (await getUserByUsername(sql, 'alice-example'))!;
  await sql`INSERT INTO sources (id,name) VALUES ('shared','S') ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO roles (id) VALUES ('staff')`;
  await sql`INSERT INTO role_source_permissions VALUES ('staff','shared','write')`;
  await assignUserRoles(sql, alice.id, ['staff']);
  const client = await provider.registerClientManual('cc', ['authorization_code'], 'read write', ['http://localhost:9/cb'], 'default', ['default'], 'none');

  // 1. authorize() renders HTML instead of redirecting
  const res = mockResponse(); // { status(), set(), send(), redirect() } test double
  await provider.authorize((await provider.clientsStore.getClient(client.client_id))!, {
    redirectUri: 'http://localhost:9/cb', codeChallenge: 'ch', state: 'st', scopes: ['read','write'],
  }, res as any);
  expect(res.sentContentType).toMatch(/text\/html/);
  const nonce = extractNonceFromHtml(res.body); // hidden input
  expect(nonce).toBeTruthy();

  // 2. wrong password → generic error, no code
  await expect(provider.completeLogin(nonce, 'alice-example', 'nope', res2 as any)).rejects.toThrow(/invalid credentials/i);

  // 3. right password → redirect with code; code bound to user
  await provider.completeLogin(nonce, 'alice-example', 'correct horse battery', res3 as any);
  const code = new URL(res3.redirectedTo).searchParams.get('code')!;
  expect(new URL(res3.redirectedTo).searchParams.get('state')).toBe('st');
  const tokens = await provider.exchangeAuthorizationCode((await provider.clientsStore.getClient(client.client_id))!, code, undefined, 'http://localhost:9/cb');
  const info = await provider.verifyAccessToken(tokens.access_token) as any;
  expect(info.username).toBe('alice-example');
  expect(info.writeSources).toEqual(['shared']);

  // 4. nonce is single-use
  await expect(provider.completeLogin(nonce, 'alice-example', 'correct horse battery', res4 as any)).rejects.toThrow(/expired|invalid/i);

  // 5. must_reset_password user → redirected to reset screen, no code yet
  await expect(provider.completeLogin(nonce2, 'reset-me', 'initial password', res5 as any)).rejects.toThrow(/password_reset_required/i);
});
```

**Step 2: Run test to verify it fails.**

**Step 3: Implement**

`src/core/login-page.ts` (new, ~80 LOC): pure functions returning HTML strings — `renderLoginPage({ clientName, scopes, nonce, error? })`, `renderResetPasswordPage({ nonce, error? })`. Inline minimal CSS, no external assets, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, autocomplete attributes, generic error slot. Escape every interpolated value (clientName comes from DB).

`src/core/oauth-provider.ts`:
- `authorize(client, params, res)`: validate client redirect_uri against `params.redirectUri` (already handled by SDK before provider — verify), INSERT into `oauth_pending_logins` (`nonce = generateToken('gbrain_pl_')`, `params` as jsonb via the repo's jsonb-safe path — params are a small object: redirectUri, codeChallenge, state, scopes, resource; use `executeRawJsonb`/`sql.json()` pattern), `expires_at = now + 600`. Respond `res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': … }).send(renderLoginPage(...))`.
- `completeLogin(nonce, username, password, res)`: `DELETE FROM oauth_pending_logins WHERE nonce = $ AND expires_at > now RETURNING client_id, params` (single-use + TTL atomic). Missing → `Error('Login session expired — restart the sign-in from your app')`. Then `verifyUserPassword`; failure → `Error('Invalid credentials')` (generic, matches the page's error slot). `must_reset_password` → `Error('password_reset_required')` with a code property the route maps to the reset page. Success → `__testOnlyIssueCodeForUser(client_id, params, user.id, res)` (issues code + redirect — the Task 5 extraction).
- `completePasswordReset(nonce, username, oldPassword, newPassword, res)`: verify + `setUserPassword` (which clears must_reset) + issue code.
- Keep the scope-clamp logic from the old `authorize()` inside `__testOnlyIssueCodeForUser` verbatim (RFC 6749 §3.3 clamp — do not regress it; `test/oauth-authorize-scope-default.test.ts` pins this).

`src/commands/serve-http.ts`:
- `POST /authorize/login` + `POST /authorize/reset-password`: `express.urlencoded`, dedicated `loginRateLimiter` (token-bucket, e.g. 10/min/IP — reuse `src/mcp/rate-limit.ts` factory), plus a per-username bucket keyed from the body. On `Invalid credentials` re-render login page with error + fresh nonce? NO — nonce is burned on attempt (single-use). Re-render with a NEW pending-login nonce: call the same "create pending login" helper with the params from the burned row… wait: params were deleted. So: on password failure, DON'T delete; instead mark attempt? Simpler and still safe: `completeLogin` deletes only on success/reset; on password failure it keeps the row but decrements an attempts counter (add `attempts INTEGER NOT NULL DEFAULT 0`; refuse after 5). Update the test accordingly. Keep TTL 10 min.
- Register routes BEFORE `app.use(authRouter)` (line ~904) so they take precedence.

**Step 4: Run tests pass** + `bun test test/oauth-authorize-scope-default.test.ts > /tmp/t6.txt 2>&1; echo "EXIT=$?"` (clamp intact).

**Step 5: Commit** `feat(auth): browser password login on /authorize with single-use pending logins`

---

### Task 7: `users_admin` management ops (contract-first → CLI parity)

**Files:**
- Modify: `src/core/operations.ts` — register 8 ops
- Test: `test/users-admin-ops.test.ts` (new)

**Ops (all `scope: 'users_admin'`):** `users_list`, `user_create`, `user_set_password`, `user_disable`, `user_enable`, `user_assign_roles`, `roles_list`, `role_create`, `role_set_sources`, `role_delete`.

**Step 1: Failing test** — for each op, dispatch through the same path `dispatchToolCall` uses and assert: (a) a token WITHOUT `users_admin` scope gets `missing_scope`; (b) a token WITH it succeeds; (c) handlers call the Task 2/3 stores. Model the harness on `test/sources-mcp.test.ts` (which tests `sources_admin` ops — read it first and copy the pattern).

```typescript
test('user_create requires users_admin scope', async () => {
  const denied = dispatchWithScopes(['read', 'write'], 'user_create', { username: 'x', password: 'long enough pw' });
  await expect(denied).rejects.toThrow(/missing_scope|insufficient/i);
  const ok = dispatchWithScopes(['users_admin'], 'user_create', { username: 'x', password: 'long enough pw' });
  await expect(ok).resolves.toMatchObject({ username: 'x' });
});
```

**Step 2: Run test to verify it fails** — ops not registered.

**Step 3: Implement** — register ops following the existing op-definition shape in operations.ts (match the surrounding `sources_add` etc. for `scope`, params zod/schema, handler, renderer). Handlers are thin: validate params → call `src/core/users.ts` / `src/core/roles.ts` → return JSON-safe result. `user_create` prints the username + initial password note (never log the password; the caller supplied it). `user_set_password` sets `must_reset_password=true`. All handlers are engine-backed via `ctx.engine` BUT the stores take `SqlQuery` — check how `sources-ops.ts` obtains raw SQL from the engine (it does this already; reuse that accessor).

**Step 4: Tests pass** + verify CLI parity manually: `bun run src/cli.ts users_list --json` works locally (local CLI bypasses scope — confirm the op's `localOnly` is false and local path works).

**Step 5: Commit** `feat(auth): users_admin management ops with CLI parity`

---

### Task 8: Admin dashboard auth — username/password login + first-admin bootstrap

**Files:**
- Read first: `src/commands/serve-http.ts:921-1080` (existing `/admin/login`, magic-link, `requireAdmin`, cookie session)
- Modify: `src/commands/serve-http.ts` — extend login, add bootstrap + users/roles API
- Test: `test/admin-user-auth.test.ts` (new)

**Step 1: Failing test** (HTTP-level, boot serve-http on an ephemeral port like existing admin tests — find one via `ls test/ | grep admin`):

```typescript
test('first-admin bootstrap → password login → session cookie; bootstrap closed afterwards', async () => {
  const { baseUrl, sql } = await bootTestServer(); // pattern from existing admin test
  // users table empty → bootstrap endpoint open with bootstrap token
  const r1 = await fetch(`${baseUrl}/admin/api/bootstrap-first-admin`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: process.env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN, username: 'root', password: 'long password 1' }) });
  expect(r1.status).toBe(200);
  // closed now
  const r2 = await fetch(`${baseUrl}/admin/api/bootstrap-first-admin`, { /* same */ });
  expect(r2.status).toBe(403);
  // password login sets admin session cookie
  const r3 = await fetch(`${baseUrl}/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'long password 1' }) });
  expect(r3.status).toBe(200);
  const cookie = r3.headers.get('set-cookie')!;
  // users API requires admin session
  expect((await fetch(`${baseUrl}/admin/api/users`)).status).toBe(401);
  const r4 = await fetch(`${baseUrl}/admin/api/users`, { headers: { cookie } });
  expect(r4.status).toBe(200);
  // non-admin user cannot log into /admin
  // …create non-admin user, expect 403 on /admin/login with their creds…
});
```

**Step 2: Run test to verify it fails.**

**Step 3: Implement**
- `POST /admin/api/bootstrap-first-admin`: open ONLY when `SELECT count(*) FROM users = 0` AND presented bootstrap token matches env. Creates user with `is_admin=true, must_reset_password=false` (they just set the password). Else 403.
- `/admin/login`: accept `{ username, password }` in addition to the existing bootstrap-token flow. `verifyUserPassword` + `is_admin=true` required → mint the SAME session cookie the magic-link path issues (read `requireAdmin` + the `/admin/auth/:token` handler and reuse its session-issuing helper — do not invent a second session mechanism). Keep bootstrap-token login working (break-glass).
- Users API (all behind `requireAdmin`): `GET /admin/api/users`, `POST /admin/api/users` (create), `POST /admin/api/users/:id/password` (reset), `POST /admin/api/users/:id/status` (enable/disable), `POST /admin/api/users/:id/roles` (assign). Roles API: `GET /admin/api/roles`, `POST /admin/api/roles`, `POST /admin/api/roles/:id/sources`, `DELETE /admin/api/roles/:id`. Bodies validated; errors → 400 with message. These endpoints call the Task 2/3 stores directly (they're same-process admin UI plumbing, not MCP ops — the ops from Task 7 are for remote agents).
- Request log attribution: where `mcp_request_log` rows are written in the `/mcp` handler (~line 1604-1650), add `username` from `authInfo.username` (migration v119 added the column).

**Step 4: Tests pass.**

**Step 5: Commit** `feat(auth): admin password login, first-admin bootstrap, users/roles admin API`

---

### Task 9: Admin SPA — Users + Roles pages

**Files:**
- Read first: `admin/src/App.tsx`, `admin/src/api.ts`, `admin/src/pages/` (one existing page for style)
- Create: `admin/src/pages/Users.tsx`, `admin/src/pages/Roles.tsx`
- Modify: `admin/src/App.tsx` (routes/nav), `admin/src/api.ts` (bindings)

**Steps (frontend, verify-by-build):**
1. `api.ts`: add `listUsers/createUser/resetUserPassword/setUserStatus/setUserRoles/listRoles/createRole/setRoleSources/deleteRole` wrappers around the Task 8 endpoints, typed.
2. `Users.tsx`: table (username, display name, roles, status, created) + create dialog (username, initial password ≥10, display name, is_admin checkbox) + per-row actions (reset password → shows "must reset at next login", disable/enable, edit roles multi-select). Follow the existing page component patterns (no new deps; plain fetch via api.ts; match existing styling conventions in `admin/DESIGN.md` if it exists — read it).
3. `Roles.tsx`: role list left, selected role's source matrix right — rows = sources (fetch from existing sources endpoint), tri-state selector (none / read / write) per row, save button submits full replacement set.
4. Build: `cd admin && bun install && bun run build > /tmp/t9.txt 2>&1; echo "EXIT=$?"` → EXIT=0. The served bundle is `admin/dist` (express.static at serve-http.ts:1547) — the build output IS the deliverable; do not commit dist if it's gitignored (check .gitignore; follow repo convention).
5. Commit `feat(admin): users + roles management pages`.

---

### Task 10: Wire remaining write ops through `resolveWriteScope` + zero-leak fuzz for user tokens

**Files:**
- Modify: write-side ops in `src/core/operations.ts` (capture, put_page already done in Task 4, delete/restore page, takes writes, `file_upload` where source-targeted) — grep for `ctx.sourceId` in write handlers to enumerate
- Test: `test/user-source-isolation-fuzz.test.ts` (new)

**Step 1: Failing fuzz test** — model on `test/operations-fuzzy-source-scope.test.ts` (read it first; reuse its corpus/generators):

```typescript
test('user tokens: zero cross-role leakage across all read paths', async () => {
  // alice-example: role sales → read [customers, shared], write [customers]
  // bob-example:   role ops   → read [internal, shared],  write [internal]
  // corpus: pages in all three sources with distinctive sentinel strings
  // For EVERY read op (query/search, list_pages, get_page, takes_list,
  // whoknows, graph queries, multi-source reads):
  //   - as alice: assert no result row carries source_id='internal' and no
  //     sentinel string from internal pages appears in serialized output
  //   - as bob:   assert no source_id='customers' / no customer sentinels
  //   - explicit out-of-grant params (--source internal as alice) → rejected
  // Write paths: put_page as alice targeting internal → rejected;
  //              put_page as alice targeting shared (read-only) → rejected;
  //              valid write lands in the right source.
});
```

**Step 2: Run test to verify it fails** (at least one op should leak or misroute until Step 3 lands — if it passes immediately, the fuzz is too weak; add the op that Task 4 didn't wire).

**Step 3: Wire every write op through `resolveWriteScope`** per the grep enumeration; fix any read path that bypasses `sourceScopeOpts(ctx)` for user tokens.

**Step 4: Full verification**

```bash
bun test test/user-source-isolation-fuzz.test.ts > /tmp/t10.txt 2>&1; echo "EXIT=$?"
bun test test/operations-fuzzy-source-scope.test.ts test/get-page-federated-scope.test.ts test/legacy-token-federated-scope.test.ts > /tmp/t10b.txt 2>&1; echo "EXIT=$?"
bun run typecheck > /tmp/tc.txt 2>&1; echo "EXIT=$?"
```
All EXIT=0.

**Step 5: Commit** `feat(auth): write ops through resolveWriteScope + user-token isolation fuzz`

---

### Task 11: Docs + final gate

**Files:**
- Modify: `docs/tutorials/company-brain.md` — replace Part 5 (per-teammate OAuth clients) with the user+role flow (keep the client flow as "machine clients / crons")
- Modify: `SECURITY.md` — add the login-page threat-model notes (rate limits, single-use nonce, argon2id, generic errors, disabled-user immediacy)
- Modify: `docs/architecture/KEY_FILES.md` — entries for `src/core/users.ts`, `src/core/roles.ts`, `src/core/login-page.ts`; update `src/core/oauth-provider.ts` + `src/commands/serve-http.ts` entries (current-state only, no version narration)

**Steps:**
1. Make the edits (placeholders only per the Privacy rule — `alice-example`, `acme-example`).
2. `bun run build:llms` (CLAUDE.md/reference-doc edits require it; `bun test test/build-llms.test.ts` gates CI).
3. Full local gate: `bun test > /tmp/all.txt 2>&1; echo "EXIT=$?"; tail -30 /tmp/all.txt`. Then, if Docker is available and time permits: `bun run ci:local:diff` for the engine-parity/e2e slice.
4. Commit `docs: multi-user auth — company-brain tutorial, security notes, key-files index`.

**Out of scope (do NOT do in this plan):** version bumps, CHANGELOG, PR creation, `/ship` (that's a separate flow once the branch is reviewed); SSO/OIDC; per-user permission overrides; email/self-service reset.

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-07-22-multi-user-auth-implementation.md`. Two execution options:**

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Parallel Session (separate)** — Open a new session with superpowers:executing-plans, batch execution with checkpoints.

**Which approach?**
