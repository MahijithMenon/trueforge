import {
  GENESIS_HASH,
  computeEntryHash,
  verifyChain,
  type ChainVerification,
} from '../../shared/src/audit-hash.ts';
import type { Client } from './db.ts';

/**
 * Tamper-evident audit log.
 *
 * Every entry commits to the hash of the entry before it, so the log is a hash
 * chain. Editing or removing any historical entry breaks every hash after it,
 * which `verifyAuditChain` detects. This is what makes an erasure defensible
 * months later: the receipt is not merely a claim, it is a link in a chain that
 * can be recomputed from scratch.
 *
 * The hashing itself lives in @tombstone/shared so the control plane verifies
 * with exactly the same code that writes.
 */

export { GENESIS_HASH, computeEntryHash, canonicalize, sha256 } from '../../shared/src/audit-hash.ts';
export type { ChainVerification } from '../../shared/src/audit-hash.ts';

export interface AuditEntryInput {
  caseId: string | null;
  actor: string;
  action: string;
  detail?: unknown;
}

export interface AuditEntry extends AuditEntryInput {
  seq: number;
  prevHash: string;
  entryHash: string;
  createdAt: string;
}

/**
 * Appends one entry. Must run inside a transaction. Takes a transaction-scoped
 * advisory lock so concurrent writers cannot interleave and fork the chain.
 */
export async function appendAudit(client: Client, input: AuditEntryInput): Promise<AuditEntry> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['erasure.audit_log']);
  const prev = await client.query<{ entry_hash: string }>(
    'SELECT entry_hash FROM erasure.audit_log ORDER BY seq DESC LIMIT 1',
  );
  const prevHash = prev.rows[0]?.entry_hash ?? GENESIS_HASH;
  const detail = input.detail ?? {};
  const entryHash = computeEntryHash(prevHash, { ...input, detail });

  const inserted = await client.query<{ seq: string; created_at: Date }>(
    `INSERT INTO erasure.audit_log (case_id, actor, action, detail, prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING seq, created_at`,
    [input.caseId, input.actor, input.action, JSON.stringify(detail), prevHash, entryHash],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('audit insert returned no row');

  return {
    ...input,
    detail,
    seq: Number(row.seq),
    prevHash,
    entryHash,
    createdAt: row.created_at.toISOString(),
  };
}

/** Recomputes the whole chain from genesis and reports the first break. */
export async function verifyAuditChain(client: Client): Promise<ChainVerification> {
  const { rows } = await client.query<{
    seq: string; case_id: string | null; actor: string; action: string;
    detail: unknown; prev_hash: string; entry_hash: string;
  }>(
    `SELECT seq, case_id, actor, action, detail, prev_hash, entry_hash
     FROM erasure.audit_log ORDER BY seq ASC`,
  );

  return verifyChain(
    rows.map((row) => ({
      seq: Number(row.seq),
      caseId: row.case_id,
      actor: row.actor,
      action: row.action,
      detail: row.detail ?? {},
      prevHash: row.prev_hash,
      entryHash: row.entry_hash,
    })),
  );
}
