/**
 * Multi-user auth schema (migration v125) — fresh-install contract.
 *
 * Boots a real PGLiteEngine through initSchema (blob + forward-reference
 * bootstrap + numbered migrations) and asserts the multi-user tables,
 * the user_id columns on oauth_tokens/oauth_codes, the mcp_request_log
 * username column, the idx_oauth_tokens_user index, and the
 * role_source_permissions access CHECK constraint all exist.
 *
 * Old-brain replay coverage lives in schema-bootstrap-coverage.test.ts
 * (REQUIRED_BOOTSTRAP_COVERAGE carries the three new columns).
 */

import { test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

// Tier 3 opt-out: we want the real bootstrap path, not a snapshot load.
delete process.env.GBRAIN_PGLITE_SNAPSHOT;

test('multi-user schema: tables, columns, index, CHECK constraint exist after initSchema', async () => {
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    const db = (engine as any).db;

    // 1. New tables
    const { rows: tables } = await db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('users','roles','role_source_permissions','user_roles','oauth_pending_logins')`,
    );
    expect(new Set(tables.map((r: any) => r.table_name))).toEqual(
      new Set(['users', 'roles', 'role_source_permissions', 'user_roles', 'oauth_pending_logins']),
    );

    // 2. New columns on existing tables
    const { rows: cols } = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'oauth_tokens' AND column_name = 'user_id')
           OR (table_name = 'oauth_codes' AND column_name = 'user_id')
           OR (table_name = 'mcp_request_log' AND column_name = 'username'))`,
    );
    expect(cols.length).toBe(3);

    // 3. users table shape (username unique, status default, is_admin default)
    const { rows: userCols } = await db.query(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'
         AND column_name IN ('username','password_hash','status','is_admin','must_reset_password')`,
    );
    const byName = new Map<string, { is_nullable: string; column_default: string | null }>(
      userCols.map((r: any) => [r.column_name as string, r as { is_nullable: string; column_default: string | null }]),
    );
    expect(byName.get('username')?.is_nullable).toBe('NO');
    expect(byName.get('password_hash')?.is_nullable).toBe('NO');
    expect(byName.get('status')?.column_default).toContain('active');
    expect(byName.get('is_admin')?.column_default).toBe('false');
    expect(byName.get('must_reset_password')?.column_default).toBe('false');

    // 4. idx_oauth_tokens_user index
    const { rows: idx } = await db.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_oauth_tokens_user'`,
    );
    expect(idx.length).toBe(1);

    // 5. role_source_permissions access CHECK constraint
    const { rows: chk } = await db.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'role_source_permissions'::regclass AND contype = 'c'`,
    );
    expect(chk.length).toBeGreaterThan(0);
  } finally {
    await engine.disconnect();
  }
}, 30000);
