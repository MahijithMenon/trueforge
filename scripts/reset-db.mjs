/**
 * Resets the demo estate to its seeded state: schema, rows, and object-store
 * fixtures. Run before each rehearsal so the demo is deterministic.
 */
import { readFile, mkdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL ?? 'postgres://tombstone:tombstone@localhost:55432/tombstone';
const objectRoot = path.resolve(root, process.env.OBJECT_STORE_ROOT ?? './data/objects');
const fixtures = path.join(root, 'packages/erasure-mcp/fixtures/objects');

const client = new pg.Client({ connectionString: url });
await client.connect();
for (const file of ['001_schema.sql', '002_seed.sql']) {
  const sql = await readFile(path.join(root, 'packages/erasure-mcp/sql', file), 'utf8');
  await client.query(sql);
  console.log(`applied ${file}`);
}
await client.end();

await rm(objectRoot, { recursive: true, force: true });
await mkdir(objectRoot, { recursive: true });
await cp(fixtures, objectRoot, { recursive: true });
console.log(`restored object fixtures into ${objectRoot}`);
console.log('demo estate reset');
