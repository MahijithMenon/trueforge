import pg from 'pg';

/**
 * Postgres pool construction, shared by the tool server and the control plane.
 *
 * The important part is the `error` listener. node-postgres emits `error` on
 * the pool when an *idle* client dies — which is exactly what happens when
 * Postgres restarts, fails over, or an idle connection is reaped by a proxy.
 * With no listener attached, that surfaces as an unhandled `error` event and
 * Node terminates the process.
 *
 * Both services were killed outright by a Postgres restart before this existed.
 * A dropped idle connection is a normal, recoverable event: the pool discards
 * the dead client and opens a new one on the next query. It must never take the
 * service down with it.
 */

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface CreatePoolOptions {
  connectionString: string;
  /** Ceiling on concurrent connections. */
  max?: number;
  /** Aborts a statement that hangs; a stuck query mid-erasure holds locks. */
  statementTimeoutMs?: number;
  /** Called when an idle client dies. Defaults to a warning on stderr. */
  onIdleClientError?: (error: Error) => void;
}

export function createPool(options: CreatePoolOptions): Pool {
  const {
    connectionString,
    max = 8,
    statementTimeoutMs = 15_000,
    onIdleClientError = defaultIdleClientErrorHandler,
  } = options;

  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: statementTimeoutMs,
  });

  pool.on('error', (error: Error) => {
    onIdleClientError(error);
  });

  return pool;
}

function defaultIdleClientErrorHandler(error: Error): void {
  // Deliberately not fatal. The next query opens a fresh connection; callers
  // see a normal query error if the database is still unreachable.
  process.stderr.write(
    `[postgres] idle client error (pool will reconnect on next query): ${error.message}\n`,
  );
}

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
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

/**
 * A human-readable description of an unknown thrown value.
 *
 * Some driver and network errors arrive with an empty `message` (an aborted
 * connection, an AggregateError wrapping socket failures), which produced
 * health output like `database: unreachable: ` - technically true and
 * completely useless. This falls back through the fields that actually carry
 * information.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message) return error.message;

    const code = (error as NodeJS.ErrnoException).code;
    if (code) return code;

    // AggregateError, as thrown when every address of a multi-homed host fails.
    const aggregate = (error as AggregateError).errors;
    if (Array.isArray(aggregate) && aggregate.length > 0) {
      return aggregate.map(describeError).join('; ');
    }
    return error.name || 'Unknown error';
  }
  if (typeof error === 'string' && error.length > 0) return error;
  return 'Unknown error';
}
