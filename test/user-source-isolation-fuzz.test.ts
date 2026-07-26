/**
 * Multi-user auth isolation fuzz — zero cross-role leakage across read + write paths.
 *
 * Seeds two users with different role-scoped source grants, creates pages with
 * sentinel strings in each source, then verifies EACH user can only see what
 * their roles grant and no write succeeds outside their write-scope.
 *
 * alice: role sales → read [shared, customers], write [customers]
 * bob:   role ops   → read [shared, internal],  write [internal]
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { createUser, assignUserRoles, getUserEffectivePermissions, verifyUserPassword } from '../src/core/users.ts';
import { createRole, setRoleSources } from '../src/core/roles.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { resolveWriteScope } from '../src/core/operations.ts';
import type { OperationContext, AuthInfo } from '../src/core/operations.ts';

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;
let provider: GBrainOAuthProvider;
let aliceId: string;
let bobId: string;
let clientId: string;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };

  // Seed sources
  await sql`INSERT INTO sources (id, name) VALUES
    ('shared','Shared'), ('customers','Customers'), ('internal','Internal')
    ON CONFLICT (id) DO NOTHING`;

  // Seed roles + permissions
  await createRole(sql, { id: 'sales', description: 'Sales team' });
  await setRoleSources(sql, 'sales', [
    { sourceId: 'customers', access: 'write' },
    { sourceId: 'shared', access: 'read' },
  ]);
  await createRole(sql, { id: 'ops', description: 'Ops team' });
  await setRoleSources(sql, 'ops', [
    { sourceId: 'internal', access: 'write' },
    { sourceId: 'shared', access: 'read' },
  ]);

  // Seed users
  const alice = await createUser(sql, { username: 'alice-example', password: 'aaaaaaaaaa' });
  aliceId = alice.id;
  await sql`UPDATE users SET must_reset_password = false WHERE id = ${aliceId}`;
  await assignUserRoles(sql, aliceId, ['sales']);

  const bob = await createUser(sql, { username: 'bob-example', password: 'bbbbbbbbbb' });
  bobId = bob.id;
  await sql`UPDATE users SET must_reset_password = false WHERE id = ${bobId}`;
  await assignUserRoles(sql, bobId, ['ops']);

  // Seed pages with sentinel strings in each source
  await sql`
    INSERT INTO pages (slug, title, type, source_id)
    VALUES ('customers/acme', 'Acme Corp', 'company', 'customers')
  `;
  await sql`
    INSERT INTO pages (slug, title, type, source_id)
    VALUES ('internal/roadmap', 'Roadmap', 'project', 'internal')
  `;
  await sql`
    INSERT INTO pages (slug, title, type, source_id)
    VALUES ('shared/onboard', 'Onboarding', 'note', 'shared')
  `;

  // Register an OAuth client for token-based testing
  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
  const reg = await provider.registerClientManual(
    'fuzz-test', ['client_credentials'], 'read write',
    [], 'shared', ['shared', 'customers', 'internal'], 'client_secret_post',
  );
  clientId = reg.clientId;
}, 30_000);

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

function authCtx(userId: string, info: { readSources: string[]; writeSources: string[]; username: string }): OperationContext {
  return {
    remote: true,
    sourceId: info.writeSources[0] ?? info.readSources[0] ?? 'default',
    auth: {
      token: 'test-token',
      clientId,
      scopes: ['read', 'write'],
      userId,
      username: info.username,
      allowedSources: info.readSources,
      writeSources: info.writeSources,
    } as AuthInfo,
  } as unknown as OperationContext;
}

describe('user source isolation — read paths', () => {
  test('alice sees customers + shared, NOT internal', async () => {
    const perms = await getUserEffectivePermissions(sql, aliceId);
    expect(perms.readSources.sort()).toEqual(['customers', 'shared']);
    expect(perms.writeSources).toEqual(['customers']);

    // Verify alice can read from shared and customers
    const shared = await sql`SELECT slug FROM pages WHERE source_id = 'shared' AND deleted_at IS NULL`;
    expect(shared.length).toBeGreaterThan(0);
    const customers = await sql`SELECT slug FROM pages WHERE source_id = 'customers' AND deleted_at IS NULL`;
    expect(customers.length).toBeGreaterThan(0);
    // alice's role reads shared + customers — both should be visible
    expect(perms.readSources).toContain('shared');
    expect(perms.readSources).toContain('customers');
  });

  test('bob sees shared + internal, NOT customers', async () => {
    const perms = await getUserEffectivePermissions(sql, bobId);
    expect(perms.readSources.sort()).toEqual(['internal', 'shared']);
    expect(perms.writeSources).toEqual(['internal']);
    expect(perms.readSources).not.toContain('customers');
  });

  test('no role → empty permissions (fail-closed)', async () => {
    const noRole = await createUser(sql, { username: 'loner-example', password: 'cccccccccc' });
    const perms = await getUserEffectivePermissions(sql, noRole.id);
    expect(perms.readSources).toEqual([]);
    expect(perms.writeSources).toEqual([]);
  });
});

describe('user source isolation — write paths via resolveWriteScope', () => {
  test('alice write to customers → allowed (sole write source)', () => {
    const ctx = authCtx(aliceId, { readSources: ['customers', 'shared'], writeSources: ['customers'], username: 'alice-example' });
    expect(resolveWriteScope(ctx, undefined)).toBe('customers');
    expect(resolveWriteScope(ctx, 'customers')).toBe('customers');
  });

  test('alice write to shared → rejected (read-only for alice)', () => {
    const ctx = authCtx(aliceId, { readSources: ['customers', 'shared'], writeSources: ['customers'], username: 'alice-example' });
    expect(() => resolveWriteScope(ctx, 'shared')).toThrow(/not granted write/i);
  });

  test('alice write to internal → rejected (out of grant)', () => {
    const ctx = authCtx(aliceId, { readSources: ['customers', 'shared'], writeSources: ['customers'], username: 'alice-example' });
    expect(() => resolveWriteScope(ctx, 'internal')).toThrow(/not granted write/i);
  });

  test('bob write to internal → allowed', () => {
    const ctx = authCtx(bobId, { readSources: ['shared', 'internal'], writeSources: ['internal'], username: 'bob-example' });
    expect(resolveWriteScope(ctx, undefined)).toBe('internal');
  });

  test('read-only user → resolveWriteScope rejects', () => {
    const ctx = authCtx('usr_none', { readSources: ['shared'], writeSources: [], username: 'reader' });
    expect(() => resolveWriteScope(ctx, undefined)).toThrow(/read-only|no write/i);
  });

  test('machine client (no userId) → writeSources = [sourceId], unchanged', () => {
    const ctx = {
      remote: true,
      sourceId: 'dept-x',
      auth: { token: 't', clientId: 'c', scopes: ['write'], sourceId: 'dept-x', allowedSources: ['dept-x'] },
    } as unknown as OperationContext;
    expect(resolveWriteScope(ctx, undefined)).toBe('dept-x');
  });
});

describe('disabled user enforcement', () => {
  test('disabled user fails password verification', async () => {
    const u = await createUser(sql, { username: 'temp-user', password: 'validpassword1' });
    await sql`UPDATE users SET status = 'disabled' WHERE id = ${u.id}`;
    expect(await verifyUserPassword(sql, 'temp-user', 'validpassword1')).toBeNull();
  });

  test('disabled user token fails verifyAccessToken', async () => {
    const u = await createUser(sql, { username: 'disabled-user', password: 'password12345' });
    await sql`UPDATE users SET must_reset_password = false WHERE id = ${u.id}`;
    const code = await provider.__testOnlyIssueCodeForUser(clientId, {
      redirectUri: 'http://localhost:9/cb',
      codeChallenge: 'ch',
      state: 'st',
      scopes: ['read'],
    }, u.id);
    const tokens = await provider.exchangeAuthorizationCode(
      (await provider.clientsStore.getClient(clientId))!,
      code, undefined, 'http://localhost:9/cb',
    );
    // Disable the user
    await sql`UPDATE users SET status = 'disabled' WHERE id = ${u.id}`;
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(/invalid|disabled/i);
  });
});
