/**
 * Database access for the erasure tool server.
 *
 * Pool construction and transaction handling live in @tombstone/shared so the
 * control plane behaves identically - in particular the idle-client error
 * listener, without which a Postgres restart kills the process.
 */
export { createPool, withTransaction } from '../../shared/src/postgres.ts';
export type { Pool, PoolClient as Client } from '../../shared/src/postgres.ts';
