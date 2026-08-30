/** Blocks until Postgres accepts connections, so `npm run db:up` is safe to chain. */
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://tombstone:tombstone@localhost:55432/tombstone';
const deadline = Date.now() + 60_000;

while (Date.now() < deadline) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    console.log('postgres is ready');
    process.exit(0);
  } catch {
    await client.end().catch(() => {});
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
console.error('postgres did not become ready within 60s');
process.exit(1);
