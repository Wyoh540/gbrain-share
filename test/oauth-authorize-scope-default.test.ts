/**
 * Authorize-grant scope default (RFC 6749 §3.3).
 *
 * When a client omits `scope` on /authorize, the granted scope must default to
 * the client's full registered scope — NOT the empty set. Regression guard for
 * the bug where an omitted request granted [], which then propagated into the
 * access + refresh tokens and never self-healed: every op failed
 * `insufficient_scope` even though the client was registered `read write`
 * (some MCP connectors omit `scope` on /authorize). The clamp must still hold —
 * an explicit over-broad request cannot escalate past the client's allowed set.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;
let sql: ReturnType<typeof sqlQueryForEngine>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sql = sqlQueryForEngine(engine);
  provider = new GBrainOAuthProvider({ sql, engine });
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await (engine as any).db.exec('DELETE FROM oauth_tokens');
  await (engine as any).db.exec('DELETE FROM oauth_codes');
  await (engine as any).db.exec('DELETE FROM oauth_clients');
});

// authorize() writes the granted scope into oauth_codes then redirects; we
// assert on the stored grant directly, so the redirect is a no-op.
const noopRes = { status() { return this; }, set() { return this; }, redirect() {}, send(_body: string) {} } as any;

async function authorizeAndReadScopes(
  scope: string,
  requested: string[] | undefined,
): Promise<string[]> {
  const { clientId } = await provider.registerClientManual(
    'authz-test', ['authorization_code'], scope, ['https://example.test/cb'],
  );
  const client = await provider.clientsStore.getClient(clientId);
  expect(client).toBeTruthy();
  // Multi-user auth: authorize() now renders HTML. Scope clamp moved to
  // __testOnlyIssueCodeForUser — call it directly for assert-on-grant tests.
  await provider.__testOnlyIssueCodeForUser(
    client!.client_id!,
    {
      scopes: requested,
      codeChallenge: 'test-challenge',
      redirectUri: 'https://example.test/cb',
      state: 'xyz',
    } as any,
  );
  const rows = (await sql`
    SELECT scopes FROM oauth_codes WHERE client_id = ${clientId}
  `) as Array<{ scopes: string[] }>;
  expect(rows.length).toBe(1);
  return rows[0].scopes ?? [];
}

describe('authorize() scope default — omitted scope inherits client grant', () => {
  test('omitted scope → inherits full registered scope', async () => {
    expect((await authorizeAndReadScopes('read write', undefined)).sort()).toEqual(['read', 'write']);
  });

  test('empty scope array → inherits full registered scope', async () => {
    expect((await authorizeAndReadScopes('read write', [])).sort()).toEqual(['read', 'write']);
  });

  test('explicit subset is honored (not overridden to full)', async () => {
    expect(await authorizeAndReadScopes('read write admin', ['read'])).toEqual(['read']);
  });

  test('clamp preserved: over-broad request cannot escalate', async () => {
    expect(await authorizeAndReadScopes('read', ['read', 'admin'])).toEqual(['read']);
  });

  test('clamp preserved: requesting only a disallowed scope grants nothing (no inheritance)', async () => {
    expect(await authorizeAndReadScopes('read write', ['admin'])).toEqual([]);
  });
});
