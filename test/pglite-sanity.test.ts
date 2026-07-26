import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
}, 15_000);
afterAll(async () => { if (db) await db.close(); });

test('pglite works', () => { expect(db).toBeDefined(); });
