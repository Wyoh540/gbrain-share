/**
 * OAuth provider user_id threading + live role-union resolution.
 *
 * Mirrors test/oauth.test.ts PGLite setup. Verifies that:
 *   - authorization_code → token carries user_id
 *   - refresh preserves user_id
 *   - verifyAccessToken resolves role unions for user tokens
 *   - machine tokens (client_credentials) are untouched
 *   - disabled user → token immediately invalid
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
  disableUser,
} from '../src/core/users.ts';

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;
let provider: GBrainOAuthProvider;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };
  await sql`INSERT INTO sources (id, name) VALUES ('default','Default'), ('shared','Shared'), ('customers','Customers'), ('internal','Internal')
            ON CONFLICT (id) DO NOTHING`;
  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
}, 30_000);

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

describe('user-bound OAuth tokens', () => {
  test('code → token → refresh preserves user_id; verifyAccessToken resolves role union', async () => {
    // Seed roles and permissions
    await sql`INSERT INTO roles (id, description) VALUES ('sales','Sales team')`;
    await sql`DELETE FROM role_source_permissions WHERE role_id = 'sales'`;
    await sql`INSERT INTO role_source_permissions (role_id, source_id, access) VALUES
              ('sales','customers','write'), ('sales','shared','read')`;

    const alice = await createUser(sql, { username: 'alice-example', password: 'correct horse battery' });
    await assignUserRoles(sql, alice.id, ['sales']);

    const { clientId } = await provider.registerClientManual(
      'claude-code', ['authorization_code'], 'read write',
      ['http://localhost:5555/cb'], 'default', ['default'], 'none',
    );

    const lookedUp = await provider.clientsStore.getClient(clientId);
    expect(lookedUp).not.toBeUndefined();

    const code = await provider.__testOnlyIssueCodeForUser(clientId, {
      redirectUri: 'http://localhost:5555/cb', codeChallenge: 'abc', state: 's', scopes: ['read', 'write'],
    }, alice.id);

    const tokens = await provider.exchangeAuthorizationCode(
      (await provider.clientsStore.getClient(clientId))!, code, undefined, 'http://localhost:5555/cb');

    const info = await provider.verifyAccessToken(tokens.access_token) as any;
    expect(info.userId).toBe(alice.id);
    expect(info.username).toBe('alice-example');
    expect(info.allowedSources.sort()).toEqual(['customers', 'shared']);
    expect(info.writeSources).toEqual(['customers']);
    expect(info.sourceId).toBe('customers'); // sole write source

    const refreshed = await provider.exchangeRefreshToken(
      (await provider.clientsStore.getClient(clientId))!, tokens.refresh_token!);
    const info2 = await provider.verifyAccessToken(refreshed.access_token) as any;
    expect(info2.userId).toBe(alice.id);

    // disabled user → token dies immediately
    await disableUser(sql, alice.id);
    await expect(provider.verifyAccessToken(refreshed.access_token)).rejects.toThrow(/invalid|disabled/i);
  });

  test('machine token (client_credentials) has no user fields, machine branch unchanged', async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(
      'cron', ['client_credentials'], 'read write', [], 'internal', ['internal', 'shared'],
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!);
    const info = await provider.verifyAccessToken(tokens.access_token) as any;
    expect(info.userId).toBeUndefined();
    expect(info.sourceId).toBe('internal');
    expect(info.allowedSources).toEqual(['internal', 'shared']);
    expect(info.writeSources).toEqual(['internal']);
  });
});
