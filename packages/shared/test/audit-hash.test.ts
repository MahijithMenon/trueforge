import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  canonicalize,
  computeEntryHash,
  verifyChain,
  type ChainLink,
} from '../src/audit-hash.ts';

/**
 * The audit chain is the project's evidence layer. If these properties do not
 * hold, an erasure receipt proves nothing, so they are tested directly rather
 * than implicitly through the tool server.
 */

describe('canonicalize', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('sorts keys at every level, not just the top', () => {
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('distinguishes values that JSON.stringify would collide on', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }));
  });

  it('omits undefined properties rather than emitting invalid JSON', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('handles null explicitly', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });
});

describe('computeEntryHash', () => {
  const entry = { caseId: 'case_1', actor: 'agent', action: 'erasure.executed', detail: { rows: 14 } };

  it('is deterministic', () => {
    expect(computeEntryHash(GENESIS_HASH, entry)).toBe(computeEntryHash(GENESIS_HASH, entry));
  });

  it('changes when the predecessor changes, which is what links the chain', () => {
    const a = computeEntryHash(GENESIS_HASH, entry);
    const b = computeEntryHash('f'.repeat(64), entry);
    expect(a).not.toBe(b);
  });

  it('changes when any field of the entry changes', () => {
    const base = computeEntryHash(GENESIS_HASH, entry);
    expect(computeEntryHash(GENESIS_HASH, { ...entry, action: 'erasure.refused' })).not.toBe(base);
    expect(computeEntryHash(GENESIS_HASH, { ...entry, detail: { rows: 15 } })).not.toBe(base);
    expect(computeEntryHash(GENESIS_HASH, { ...entry, actor: 'someone-else' })).not.toBe(base);
  });

  it('treats a missing detail as an empty object', () => {
    expect(computeEntryHash(GENESIS_HASH, { ...entry, detail: undefined })).toBe(
      computeEntryHash(GENESIS_HASH, { ...entry, detail: {} }),
    );
  });
});

/** Builds a well-formed chain so tests can then corrupt it deliberately. */
function buildChain(actions: string[]): ChainLink[] {
  let prevHash = GENESIS_HASH;
  return actions.map((action, index) => {
    const core = { caseId: 'case_1', actor: 'agent', action, detail: { i: index } };
    const entryHash = computeEntryHash(prevHash, core);
    const link: ChainLink = { ...core, seq: index + 1, prevHash, entryHash };
    prevHash = entryHash;
    return link;
  });
}

describe('verifyChain', () => {
  it('accepts an empty chain', () => {
    expect(verifyChain([])).toEqual({
      valid: true,
      entries: 0,
      brokenAtSeq: null,
      headHash: GENESIS_HASH,
    });
  });

  it('accepts an intact chain and reports its head', () => {
    const chain = buildChain(['case.opened', 'plan.prepared', 'erasure.executed']);
    const result = verifyChain(chain);
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(3);
    expect(result.headHash).toBe(chain[2]!.entryHash);
  });

  it('detects an edited entry and names where the chain breaks', () => {
    const chain = buildChain(['case.opened', 'plan.prepared', 'erasure.executed']);
    // Someone rewrites history to hide what was deleted.
    chain[1] = { ...chain[1]!, detail: { i: 99 } };
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
  });

  it('detects a removed entry', () => {
    const chain = buildChain(['a', 'b', 'c']);
    const withHole = [chain[0]!, chain[2]!];
    const result = verifyChain(withHole);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(3);
  });

  it('detects a re-pointed prev_hash', () => {
    const chain = buildChain(['a', 'b']);
    chain[1] = { ...chain[1]!, prevHash: GENESIS_HASH };
    expect(verifyChain(chain).valid).toBe(false);
  });

  it('detects reordering', () => {
    const chain = buildChain(['a', 'b', 'c']);
    const swapped = [chain[0]!, chain[2]!, chain[1]!];
    expect(verifyChain(swapped).valid).toBe(false);
  });
});
