import { generateToken } from './utils.ts';
import type { SqlQuery } from './sql-query.ts';

export const MIN_PASSWORD_LENGTH = 10;
const USERNAME_RE = /^[a-z0-9._-]{2,64}$/;

export interface UserRow {
  id: string;
  username: string;
  displayName?: string;
  email?: string;
  status: 'active' | 'disabled';
  isAdmin: boolean;
  mustResetPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EffectivePermissions {
  readSources: string[];
  writeSources: string[];
}

let dummyHashPromise: Promise<string> | undefined;

async function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = Bun.password.hash('dummy_password_for_timing_equalization', {
      algorithm: 'argon2id',
    });
  }
  return dummyHashPromise;
}

function mapUserRow(row: Record<string, unknown>): UserRow {
  return {
    id: row.id as string,
    username: row.username as string,
    displayName: (row.display_name as string | null) ?? undefined,
    email: (row.email as string | null) ?? undefined,
    status: row.status as 'active' | 'disabled',
    isAdmin: row.is_admin as boolean,
    mustResetPassword: row.must_reset_password as boolean,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createUser(
  sql: SqlQuery,
  opts: { username: string; password: string; displayName?: string; email?: string; isAdmin?: boolean },
): Promise<UserRow> {
  if (!USERNAME_RE.test(opts.username)) {
    throw new Error('Invalid username: must be 2-64 lowercase alphanumeric, dots, hyphens, underscores');
  }
  if (opts.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const id = generateToken('usr_');
  const hash = await Bun.password.hash(opts.password, { algorithm: 'argon2id' });

  try {
    const rows = await sql`
      INSERT INTO users (id, username, display_name, email, password_hash, status, is_admin, must_reset_password)
      VALUES (
        ${id},
        ${opts.username},
        ${opts.displayName ?? null},
        ${opts.email ?? null},
        ${hash},
        ${'active'},
        ${opts.isAdmin ?? false},
        ${true}
      )
      RETURNING *
    `;
    return mapUserRow(rows[0]);
  } catch (err: any) {
    const msg = String(err?.message ?? '').toLowerCase();
    if (msg.includes('unique') || msg.includes('duplicate')) {
      throw new Error(`username already exists: ${opts.username}`);
    }
    throw err;
  }
}

export async function verifyUserPassword(
  sql: SqlQuery,
  username: string,
  password: string,
): Promise<UserRow | null> {
  const rows = await sql`SELECT * FROM users WHERE username = ${username}`;
  if (rows.length === 0) {
    const dummy = await getDummyHash();
    await Bun.password.verify(password, dummy);
    return null;
  }

  const row = rows[0];
  if (row.status !== 'active') {
    return null;
  }

  const valid = await Bun.password.verify(password, row.password_hash as string);
  if (!valid) return null;
  return mapUserRow(row);
}

export async function setUserPassword(
  sql: SqlQuery,
  userId: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const hash = await Bun.password.hash(newPassword, { algorithm: 'argon2id' });
  await sql`
    UPDATE users
    SET password_hash = ${hash}, must_reset_password = ${false}, updated_at = now()
    WHERE id = ${userId}
  `;
}

export async function disableUser(sql: SqlQuery, userId: string): Promise<void> {
  await sql`UPDATE users SET status = ${'disabled'}, updated_at = now() WHERE id = ${userId}`;
}

export async function enableUser(sql: SqlQuery, userId: string): Promise<void> {
  await sql`UPDATE users SET status = ${'active'}, updated_at = now() WHERE id = ${userId}`;
}

export async function getUserByUsername(sql: SqlQuery, username: string): Promise<UserRow | null> {
  const rows = await sql`SELECT * FROM users WHERE username = ${username}`;
  if (rows.length === 0) return null;
  return mapUserRow(rows[0]);
}

export async function listUsers(sql: SqlQuery): Promise<(UserRow & { roles: string[] })[]> {
  const rows = await sql`
    SELECT
      u.*,
      COALESCE(array_agg(ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL), '{}') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `;
  return rows.map((row) => ({
    ...mapUserRow(row),
    roles: Array.isArray(row.roles) ? (row.roles as string[]) : [],
  }));
}

export async function assignUserRoles(
  sql: SqlQuery,
  userId: string,
  roleIds: string[],
): Promise<void> {
  const allRoles = await sql`SELECT id FROM roles`;
  const existingIds = new Set(allRoles.map((r) => r.id as string));
  const unknown = roleIds.filter((id) => !existingIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown roles: ${unknown.join(', ')}`);
  }

  await sql`DELETE FROM user_roles WHERE user_id = ${userId}`;
  for (const roleId of roleIds) {
    await sql`INSERT INTO user_roles (user_id, role_id) VALUES (${userId}, ${roleId})`;
  }
}

export async function getUserEffectivePermissions(
  sql: SqlQuery,
  userId: string,
): Promise<EffectivePermissions> {
  const rows = await sql`
    SELECT
      COALESCE(array_agg(DISTINCT rsp.source_id) FILTER (WHERE rsp.access IN ('read','write')), '{}') AS read_sources,
      COALESCE(array_agg(DISTINCT rsp.source_id) FILTER (WHERE rsp.access = 'write'), '{}') AS write_sources
    FROM user_roles ur
    JOIN role_source_permissions rsp ON rsp.role_id = ur.role_id
    WHERE ur.user_id = ${userId}
  `;
  const row = rows[0];
  return {
    readSources: Array.isArray(row.read_sources) ? (row.read_sources as string[]) : [],
    writeSources: Array.isArray(row.write_sources) ? (row.write_sources as string[]) : [],
  };
}
