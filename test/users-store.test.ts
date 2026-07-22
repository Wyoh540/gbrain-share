/**
 * src/core/users.ts — human user store: argon2id passwords, status gate,
 * role assignment, effective-permission unions.
 *
 * PGLite-backed; setup mirrors test/oauth.test.ts (schema blob + tagged
 * template adapter). Timing-equalization and fail-closed semantics are
 * the contract points under test.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import {
  createUser,
  verifyUserPassword,
  setUserPassword,
  disableUser,
  enableUser,
  getUserByUsername,
  listUsers,
  assignUserRoles,
  getUserEffectivePermissions,
  MIN_PASSWORD_LENGTH,
} from '../src/core/users.ts';

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };

  await sql`INSERT INTO sources (id, name) VALUES ('shared','Shared'), ('internal','Internal'), ('customers','Customers')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO roles (id, description) VALUES ('sales','Sales team'), ('ops','Ops team')`;
  await sql`INSERT INTO role_source_permissions (role_id, source_id, access) VALUES
            ('sales','customers','write'), ('sales','shared','read'), ('ops','internal','read'), ('ops','shared','read')`;
}, 30_000);

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

describe('createUser', () => {
  test('creates with usr_ id, argon2id hash, must_reset_password=true', async () => {
    const u = await createUser(sql, { username: 'alice-example', password: 'correct horse battery', displayName: 'Alice' });
    expect(u.id).toStartWith('usr_');
    expect(u.username).toBe('alice-example');
    expect(u.displayName).toBe('Alice');
    expect(u.status).toBe('active');
    expect(u.isAdmin).toBe(false);
    expect(u.mustResetPassword).toBe(true);

    const rows = await sql`SELECT password_hash FROM users WHERE id = ${u.id}`;
    expect(rows[0].password_hash).toStartWith('$argon2id$');
    expect(rows[0].password_hash).not.toContain('correct horse');
  });

  test('rejects duplicate username, bad username, short password', async () => {
    await expect(createUser(sql, { username: 'alice-example', password: 'another password 1' }))
      .rejects.toThrow(/exists|unique/i);
    await expect(createUser(sql, { username: 'BAD NAME!', password: 'valid password 1' }))
      .rejects.toThrow(/username/i);
    await expect(createUser(sql, { username: 'ok-name', password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) }))
      .rejects.toThrow(/password/i);
  });
});

describe('verifyUserPassword', () => {
  test('right password returns the row, wrong returns null', async () => {
    expect(await verifyUserPassword(sql, 'alice-example', 'not the password')).toBeNull();
    const verified = await verifyUserPassword(sql, 'alice-example', 'correct horse battery');
    expect(verified?.username).toBe('alice-example');
  });

  test('unknown username returns null (and costs a verify)', async () => {
    const start = performance.now();
    expect(await verifyUserPassword(sql, 'no-such-user', 'whatever password')).toBeNull();
    // Timing equalization: unknown user still pays an argon2id verify (~ms, not ~0).
    // Generous bound — just prove the dummy-verify path ran at all.
    expect(performance.now() - start).toBeGreaterThan(1);
  });
});

describe('setUserPassword', () => {
  test('rotates hash and clears must_reset_password', async () => {
    await setUserPassword(sql, (await getUserByUsername(sql, 'alice-example'))!.id, 'new password 123');
    expect(await verifyUserPassword(sql, 'alice-example', 'correct horse battery')).toBeNull();
    const v = await verifyUserPassword(sql, 'alice-example', 'new password 123');
    expect(v).not.toBeNull();
    expect(v!.mustResetPassword).toBe(false);
  });
});

describe('roles + effective permissions', () => {
  test('union across roles: read = read∪write grants, write = write grants', async () => {
    const u = (await getUserByUsername(sql, 'alice-example'))!;
    await assignUserRoles(sql, u.id, ['sales', 'ops']);
    const perms = await getUserEffectivePermissions(sql, u.id);
    expect(perms.readSources.sort()).toEqual(['customers', 'internal', 'shared']);
    expect(perms.writeSources).toEqual(['customers']);
  });

  test('no roles → empty unions (fail-closed)', async () => {
    const u = await createUser(sql, { username: 'carol-example', password: 'valid password 2' });
    const perms = await getUserEffectivePermissions(sql, u.id);
    expect(perms.readSources).toEqual([]);
    expect(perms.writeSources).toEqual([]);
  });

  test('assignUserRoles rejects unknown roles and replaces the set', async () => {
    const u = (await getUserByUsername(sql, 'alice-example'))!;
    await expect(assignUserRoles(sql, u.id, ['sales', 'no-such-role'])).rejects.toThrow(/role/i);
    await assignUserRoles(sql, u.id, ['ops']);
    const perms = await getUserEffectivePermissions(sql, u.id);
    expect(perms.readSources.sort()).toEqual(['internal', 'shared']);
    expect(perms.writeSources).toEqual([]);
  });

  test('listUsers carries role arrays', async () => {
    const users = await listUsers(sql);
    const alice = users.find((u) => u.username === 'alice-example')!;
    expect(alice.roles).toEqual(['ops']);
    const carol = users.find((u) => u.username === 'carol-example')!;
    expect(carol.roles).toEqual([]);
  });
});

describe('disable/enable', () => {
  test('disabled user fails verification, enable restores', async () => {
    const u = (await getUserByUsername(sql, 'alice-example'))!;
    await disableUser(sql, u.id);
    expect((await getUserByUsername(sql, 'alice-example'))!.status).toBe('disabled');
    expect(await verifyUserPassword(sql, 'alice-example', 'new password 123')).toBeNull();
    await enableUser(sql, u.id);
    expect(await verifyUserPassword(sql, 'alice-example', 'new password 123')).not.toBeNull();
  });
});
