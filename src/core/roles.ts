import type { SqlQuery } from './sql-query.ts';

const ROLE_ID_RE = /^[a-z0-9-]{1,32}$/;

export async function createRole(
  sql: SqlQuery,
  opts: { id: string; description?: string },
): Promise<void> {
  if (!ROLE_ID_RE.test(opts.id)) {
    throw new Error('Invalid role id: must be 1-32 lowercase alphanumeric or hyphens');
  }
  await sql`
    INSERT INTO roles (id, description)
    VALUES (${opts.id}, ${opts.description ?? null})
  `;
}

export async function deleteRole(sql: SqlQuery, roleId: string): Promise<void> {
  await sql`DELETE FROM roles WHERE id = ${roleId}`;
}

export async function setRoleSources(
  sql: SqlQuery,
  roleId: string,
  grants: { sourceId: string; access: 'read' | 'write' }[],
): Promise<void> {
  // Validate role exists
  const roleRows = await sql`SELECT id FROM roles WHERE id = ${roleId}`;
  if (roleRows.length === 0) {
    throw new Error(`Role not found: ${roleId}`);
  }

  // Validate every sourceId exists
  const sourceRows = await sql`SELECT id FROM sources`;
  const validSources = new Set(sourceRows.map((r) => r.id as string));
  const invalid = grants.filter((g) => !validSources.has(g.sourceId));
  if (invalid.length > 0) {
    throw new Error(`Invalid sources: ${invalid.map((g) => g.sourceId).join(', ')}`);
  }

  // Validate access values
  for (const grant of grants) {
    if (grant.access !== 'read' && grant.access !== 'write') {
      throw new Error(`Invalid access "${grant.access}" for source ${grant.sourceId}`);
    }
  }

  // Full replacement: delete existing, insert new set
  await sql`DELETE FROM role_source_permissions WHERE role_id = ${roleId}`;
  for (const grant of grants) {
    await sql`
      INSERT INTO role_source_permissions (role_id, source_id, access)
      VALUES (${roleId}, ${grant.sourceId}, ${grant.access})
    `;
  }
}

export async function getRoleMatrix(
  sql: SqlQuery,
  roleId: string,
): Promise<Record<string, 'read' | 'write'>> {
  const rows = await sql`
    SELECT source_id, access FROM role_source_permissions WHERE role_id = ${roleId}
  `;
  const matrix: Record<string, 'read' | 'write'> = {};
  for (const row of rows) {
    matrix[row.source_id as string] = row.access as 'read' | 'write';
  }
  return matrix;
}

export async function listRoles(
  sql: SqlQuery,
): Promise<{ id: string; description?: string; sources: Record<string, 'read' | 'write'>; memberCount: number }[]> {
  const rows = await sql`
    SELECT
      r.id,
      r.description,
      COALESCE(
        (SELECT jsonb_object_agg(rsp.source_id, rsp.access)
         FROM role_source_permissions rsp
         WHERE rsp.role_id = r.id),
        '{}'
      ) AS sources,
      (SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS member_count
    FROM roles r
    ORDER BY r.created_at DESC
  `;
  return rows.map((row) => {
    const sourcesRaw = row.sources;
    const sources =
      typeof sourcesRaw === 'object' && sourcesRaw !== null
        ? (sourcesRaw as Record<string, 'read' | 'write'>)
        : {};
    return {
      id: row.id as string,
      description: (row.description as string | null) ?? undefined,
      sources,
      memberCount: (row.member_count as number) ?? 0,
    };
  });
}
