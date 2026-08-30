import type { AuditResponse } from '../types';

/**
 * The audit trail, with the hash chain re-verified independently.
 *
 * The verification banner is not decoration: the control plane recomputes every
 * entry hash from genesis using the same shared implementation the tool server
 * writes with. If a row were edited or deleted straight in Postgres, this panel
 * would say so and name the sequence number where the chain breaks.
 */

const DESTRUCTIVE_ACTIONS = new Set(['erasure.executed']);
const REFUSAL_PREFIX = 'erasure.refused';

function shorten(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function summarise(action: string, detail: Record<string, unknown>): string | null {
  if (action === 'erasure.executed') {
    return `${detail.rows_affected ?? '?'} rows, ${detail.objects_deleted ?? '?'} files`;
  }
  if (action === 'case.opened') {
    return typeof detail.subject_email === 'string' ? detail.subject_email : null;
  }
  if (action === 'plan.prepared') {
    return typeof detail.plan_id === 'string' ? detail.plan_id : null;
  }
  if (action.startsWith(REFUSAL_PREFIX)) {
    return typeof detail.code === 'string' ? detail.code : 'refused';
  }
  return null;
}

export function AuditPanel({ audit }: { audit: AuditResponse | null }) {
  if (!audit) return <div className="empty">Loading audit trail...</div>;

  const { entries, verification } = audit;

  return (
    <>
      <div className={`chain-status ${verification.valid ? 'valid' : 'invalid'}`}>
        <span className="dot ok" style={{ background: verification.valid ? undefined : 'var(--destructive)' }} />
        {verification.valid ? (
          <span>
            Hash chain verified · {verification.entries}{' '}
            {verification.entries === 1 ? 'entry' : 'entries'}
          </span>
        ) : (
          <span>Chain broken at entry #{verification.brokenAtSeq}</span>
        )}
      </div>

      {entries.length === 0 && <div className="empty">No audit entries yet.</div>}

      {entries.map((entry) => {
        const detail = (entry.detail ?? {}) as Record<string, unknown>;
        const summary = summarise(entry.action, detail);
        const className = DESTRUCTIVE_ACTIONS.has(entry.action)
          ? 'destructive'
          : entry.action.startsWith(REFUSAL_PREFIX)
            ? 'refused'
            : '';
        return (
          <div className={`audit-entry ${className}`} key={entry.seq}>
            <div className="audit-action">
              #{entry.seq} {entry.action}
            </div>
            {summary && <div className="audit-meta">{summary}</div>}
            <div className="audit-meta">
              {entry.actor} · {new Date(entry.createdAt).toLocaleTimeString()}
            </div>
            <div className="hash" title={entry.entryHash}>
              {shorten(entry.entryHash)}
            </div>
          </div>
        );
      })}
    </>
  );
}
