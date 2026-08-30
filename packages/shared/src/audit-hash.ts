import { createHash } from 'node:crypto';

/**
 * The audit hash chain, as pure functions.
 *
 * This lives in a shared module because two independent components must agree
 * on it exactly: the MCP tool server that writes entries, and the control plane
 * that re-verifies them for the operator. If these two ever disagreed, the
 * verification panel would be worthless — so there is one implementation.
 */

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Canonical JSON: object keys sorted at every level, so that logically
 * identical payloads always hash identically regardless of key order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface AuditEntryCore {
  caseId: string | null;
  actor: string;
  action: string;
  detail: unknown;
}

/** The hash of a single entry, given its predecessor's hash. */
export function computeEntryHash(prevHash: string, entry: AuditEntryCore): string {
  return sha256(
    canonicalize({
      prev: prevHash,
      case_id: entry.caseId,
      actor: entry.actor,
      action: entry.action,
      detail: entry.detail ?? {},
    }),
  );
}

export interface ChainLink extends AuditEntryCore {
  seq: number;
  prevHash: string;
  entryHash: string;
}

export interface ChainVerification {
  valid: boolean;
  entries: number;
  brokenAtSeq: number | null;
  headHash: string;
}

/**
 * Recomputes a chain from genesis and reports the first entry that does not
 * match. Works on any ordered list of links, so both the tool server (reading
 * inside a transaction) and the control plane (reading over HTTP) can use it.
 */
export function verifyChain(links: readonly ChainLink[]): ChainVerification {
  let prevHash = GENESIS_HASH;
  for (const link of links) {
    const expected = computeEntryHash(prevHash, link);
    if (link.prevHash !== prevHash || link.entryHash !== expected) {
      return { valid: false, entries: links.length, brokenAtSeq: link.seq, headHash: prevHash };
    }
    prevHash = link.entryHash;
  }
  return { valid: true, entries: links.length, brokenAtSeq: null, headHash: prevHash };
}
