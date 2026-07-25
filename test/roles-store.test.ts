/**
 * src/core/roles.ts — role store: CRUD + per-source access matrix.
 *
 * PGLite-backed; setup mirrors test/oauth.test.ts (schema blob + tagged
 * template adapter).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { createRole, setRoleSources, listRoles, deleteRole, getRoleMatrix } from '../src/core/roles.ts';

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

  await sql`INSERT INTO sources (id, name) VALUES ('shared','S'), ('customers','C'), ('internal','I')
            ON CONFLICT (id) DO NOTHING`;
}, 30_000);

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

describe('role CRUD + source matrix', () => {
  test('full lifecycle', async () => {
    await createRole(sql, { id: 'sales', description: 'Sales team' });
    await setRoleSources(sql, 'sales', [
      { sourceId: 'customers', access: 'write' },
      { sourceId: 'shared', access: 'read' },
    ]);

    const matrix = await getRoleMatrix(sql, 'sales');
    expect(matrix).toEqual({ customers: 'write', shared: 'read' });

    const roles = await listRoles(sql);
    expect(roles.length).toBe(1);
    expect(roles[0].id).toBe('sales');
    expect(roles[0].sources).toEqual(matrix);
    expect(roles[0].memberCount).toBe(0);

    await setRoleSources(sql, 'sales', [{ sourceId: 'shared', access: 'read' }]);
    expect(await getRoleMatrix(sql, 'sales')).toEqual({ shared: 'read' });

    await expect(setRoleSources(sql, 'sales', [{ sourceId: 'nope', access: 'read' }]))
      .rejects.toThrow(/source/i);
    await expect(createRole(sql, { id: 'BAD ROLE' }))
      .rejects.toThrow(/id/i);

    await deleteRole(sql, 'sales');
    expect(await listRoles(sql)).toEqual([]);
  });
});
