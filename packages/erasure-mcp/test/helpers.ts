import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPool, type Pool } from '../src/db.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SQL_DIR = path.resolve(here, '../sql');

/**
 * Integration tests run against a real Postgres, in a dedicated database, so
 * they exercise the actual SQL, constraints and transactions rather than a
 * stand-in. The demo database is never touched.
 */
const ADMIN_URL =
  process.env.TEST_ADMIN_URL ?? 'postgres://tombstone:tombstone@localhost:55432/postgres';
export const TEST_DB = process.env.TEST_DB_NAME ?? 'tombstone_test';
export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? `postgres://tombstone:tombstone@localhost:55432/${TEST_DB}`;

export async function ensureTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (rows.length === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
}

/** Reapplies schema and seed, giving each test file a known starting estate. */
export async function resetTestDatabase(pool: Pool): Promise<void> {
  for (const file of ['001_schema.sql', '002_seed.sql']) {
    const sql = await readFile(path.join(SQL_DIR, file), 'utf8');
    await pool.query(sql);
  }
}

export async function createTestPool(): Promise<Pool> {
  await ensureTestDatabase();
  const pool = createPool({ connectionString: TEST_URL });
  await resetTestDatabase(pool);
  return pool;
}

export const PRIYA_ID = 1;
export const DANIEL_ID = 2;
export const MEI_ID = 3;
