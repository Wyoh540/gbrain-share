/**
 * Browser login flow on /authorize — password auth with single-use nonces.
 *
 * Tests that:
 *   - authorize() renders an HTML login page with a hidden nonce
 *   - wrong password → generic error (nonce preserved, attempts tracked)
 *   - right password → redirect with user-bound code
 *   - nonce single-use after success
 *   - must_reset_password → password_reset_required error
 *   - completePasswordReset verifies old password, sets new one, issues code
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import {
  createUser,
  getUserByUsername,
  assignUserRoles,
} from '../src/core/users.ts';

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;
let provider: GBrainOAuthProvider;

// Simple mock response for capturing redirects and sent content
function mockRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const self: any = {
    body: '',
    sentContentType: '',
    statusCode: 200,
    headers: {} as Record<string, string>,
    redirectedTo: '',
    status(code: number) { self.statusCode = code; return self; },
    set(headers: Record<string, string>) { Object.assign(self.headers, headers); return self; },
    send(body: string) { self.body = body; self.sentContentType = self.headers['Content-Type'] || ''; return self; },
    redirect(url: string) { self.redirectedTo = url; self.statusCode = 302; return self; },
  };
  return self;
}

function extractNonceFromHtml(html: string): string | null {
  const m = html.match(/name="nonce"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };
  await sql`INSERT INTO sources (id, name) VALUES ('default','Default'), ('shared','Shared')
            ON CONFLICT (id) DO NOTHING`;
  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
}, 30_000);

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

describe('authorize login flow', () => {
  test('authorize renders HTML login page with nonce; wrong password fails, right password redirects', async () => {
    // Seed roles + permissions
    await sql`INSERT INTO roles (id) VALUES ('staff') ON CONFLICT DO NOTHING`;
    await sql`DELETE FROM role_source_permissions WHERE role_id = 'staff'`;
    await sql`INSERT INTO role_source_permissions (role_id, source_id, access) VALUES ('staff','shared','write')`;

    const alice = await createUser(sql, { username: 'alice-example', password: 'correct horse battery' });
    await sql`UPDATE users SET must_reset_password = false WHERE id = ${alice.id}`;
    await assignUserRoles(sql, alice.id, ['staff']);

    const { clientId } = await provider.registerClientManual(
      'cc', ['authorization_code'], 'read write',
      ['http://localhost:9/cb'], 'default', ['default'], 'none',
    );

    // 1. authorize() renders HTML instead of redirecting
    const res = mockRes();
    await provider.authorize(
      (await provider.clientsStore.getClient(clientId))!,
      { redirectUri: 'http://localhost:9/cb', codeChallenge: 'ch', state: 'st', scopes: ['read', 'write'] },
      res,
    );
    expect(res.sentContentType).toMatch(/text\/html/);
    expect(res.body).toContain('<form');
    const nonce = extractNonceFromHtml(res.body);
    expect(nonce).toBeTruthy();

    // 2. wrong password → generic error, nonce preserved
    const res2 = mockRes();
    const nonceStr = nonce!;
    await expect(
      provider.completeLogin(nonceStr, 'alice-example', 'nope', res2),
    ).rejects.toThrow(/invalid credentials/i);

    // nonce is still valid — attempt count incremented but not consumed
    const pending = await sql`SELECT attempts FROM oauth_pending_logins WHERE nonce = ${nonceStr}`;
    expect(pending.length).toBe(1);
    expect(pending[0].attempts).toBe(1);

    // 3. right password → redirect with code bound to user
    const res3 = mockRes();
    await provider.completeLogin(nonceStr, 'alice-example', 'correct horse battery', res3);
    expect(res3.redirectedTo).toBeTruthy();
    const code = new URL(res3.redirectedTo).searchParams.get('code')!;
    expect(code).toBeTruthy();
    expect(new URL(res3.redirectedTo).searchParams.get('state')).toBe('st');

    // Exchange the code to get tokens
    const tokens = await provider.exchangeAuthorizationCode(
      (await provider.clientsStore.getClient(clientId))!, code, undefined, 'http://localhost:9/cb',
    );
    const info = await provider.verifyAccessToken(tokens.access_token) as any;
    expect(info.username).toBe('alice-example');
    expect(info.writeSources).toEqual(['shared']);

    // 4. nonce is single-use — consumed by successful login
    const res4 = mockRes();
    await expect(
      provider.completeLogin(nonceStr, 'alice-example', 'correct horse battery', res4),
    ).rejects.toThrow(/expired/i);
  });

  test('must_reset_password user throws password_reset_required', async () => {
    const resetUser = await createUser(sql, { username: 'reset-me', password: 'initial password' });
    expect(resetUser.mustResetPassword).toBe(true);

    const { clientId } = await provider.registerClientManual(
      'cc2', ['authorization_code'], 'read write',
      ['http://localhost:3/cb'], 'default', ['default'], 'none',
    );

    const res = mockRes();
    await provider.authorize(
      (await provider.clientsStore.getClient(clientId))!,
      { redirectUri: 'http://localhost:3/cb', codeChallenge: 'ch', state: '', scopes: ['read'] },
      res,
    );
    const nonce = extractNonceFromHtml(res.body)!;

    const res2 = mockRes();
    const err: any = await provider.completeLogin(nonce, 'reset-me', 'initial password', res2).catch((e) => e);
    expect(err.code).toBe('password_reset_required');
  });

  test('completePasswordReset verifies old, sets new, issues code', async () => {
    const resetUser = (await getUserByUsername(sql, 'reset-me'))!;

    const { clientId } = await provider.registerClientManual(
      'cc3', ['authorization_code'], 'read write',
      ['http://localhost:4/cb'], 'default', ['default'], 'none',
    );

    const res = mockRes();
    await provider.authorize(
      (await provider.clientsStore.getClient(clientId))!,
      { redirectUri: 'http://localhost:4/cb', codeChallenge: 'ch', state: 'ok', scopes: ['read', 'write'] },
      res,
    );
    const nonce = extractNonceFromHtml(res.body)!;

    const resetRes = mockRes();
    await provider.completePasswordReset(nonce, 'reset-me', 'initial password', 'new password 123', resetRes);
    expect(resetRes.redirectedTo).toBeTruthy();
    const code = new URL(resetRes.redirectedTo).searchParams.get('code')!;
    expect(code).toBeTruthy();

    // must_reset_password cleared
    const updated = await getUserByUsername(sql, 'reset-me');
    expect(updated?.mustResetPassword).toBe(false);

    // Token carries user_id
    const tokens = await provider.exchangeAuthorizationCode(
      (await provider.clientsStore.getClient(clientId))!, code, undefined, 'http://localhost:4/cb',
    );
    const info = await provider.verifyAccessToken(tokens.access_token) as any;
    expect(info.userId).toBe(resetUser.id);
  });
});
