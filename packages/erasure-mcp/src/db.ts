import pg from 'pg';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString: string): Pool {
  return new pg.Pool({
    connectionString,
    max: 8,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // A statement that hangs mid-erasure would hold locks on customer data.
    statement_timeout: 15_000,
  });
}

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
export async function withTransaction<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
