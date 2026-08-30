import type { AuditEntry, ErasurePlan } from '../types';
import type { PendingApproval } from '../session';

/**
 * The human approval gate.
 *
 * This component is the reason the product exists, so it does more than ask
 * "allow or deny". An operator cannot make a real decision from a tool name and
 * an opaque id, and an approval prompt that cannot be evaluated is just a
 * speed bump that trains people to click yes.
 *
 * So the gate resolves the plan id back into the actual plan and states, in
 * concrete numbers, what approving destroys and what denying preserves. The
 * plan is read from the audit trail rather than from the agent's own message,
 * so what the operator approves is what was durably recorded.
 */

interface Props {
  pending: PendingApproval;
  auditEntries: AuditEntry[];
  busy: boolean;
  onDecide: (decision: 'allow' | 'deny', reason?: string) => void;
}

function extractPlanId(args: string): string | null {
  try {
    const parsed = JSON.parse(args) as { plan_id?: unknown };
    return typeof parsed.plan_id === 'string' ? parsed.plan_id : null;
  } catch {
    return null;
  }
}

/** Finds the stored plan the pending call refers to. */
function findPlan(auditEntries: AuditEntry[], planId: string | null): ErasurePlan | null {
  if (!planId) return null;
  for (const entry of auditEntries) {
    if (entry.action !== 'plan.prepared') continue;
    const detail = entry.detail as { plan_id?: string; plan?: ErasurePlan };
    if (detail.plan_id === planId && detail.plan) return detail.plan;
  }
  return null;
}

export function ApprovalGate({ pending, auditEntries, busy, onDecide }: Props) {
  const planId = extractPlanId(pending.args);
  const plan = findPlan(auditEntries, planId);

  const deleted = plan?.actions.filter((a) => a.disposition === 'delete') ?? [];
  const redacted = plan?.actions.filter((a) => a.disposition === 'redact') ?? [];
  const deletedRows = deleted.reduce((sum, a) => sum + a.estimatedRows, 0);
  const redactedRows = redacted.reduce((sum, a) => sum + a.estimatedRows, 0);

  return (
    <div className="gate" role="alertdialog" aria-labelledby="gate-title">
      <div className="gate-head">
        <span className="badge destructive">destructive</span>
        <strong id="gate-title">Human approval required</strong>
        <span className="who">the harness has paused this turn</span>
      </div>

      <div className="gate-body">
        <div className="gate-tool">
          <code>{pending.toolName}</code>
          {plan && <span className="tool-server">subject: {plan.subjectEmail}</span>}
        </div>

        {plan ? (
          <>
            <table className="plan-table">
              <thead>
                <tr>
                  <th>System</th>
                  <th>Action</th>
                  <th style={{ textAlign: 'right' }}>Records</th>
                  <th>Basis</th>
                </tr>
              </thead>
              <tbody>
                {plan.actions.map((action) => (
                  <tr key={action.table}>
                    <td>{action.system}</td>
                    <td>
                      <span className={`disp ${action.disposition}`}>{action.disposition}</span>
                    </td>
                    <td className="num">{action.estimatedRows}</td>
                    <td style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>{action.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="effects">
              <div className="effect approve">
                <h6>If you approve</h6>
                <ul>
                  <li>
                    <strong>{deletedRows}</strong> records permanently deleted across {deleted.length} systems
                  </li>
                  <li>
                    <strong>{redactedRows}</strong> records redacted in place (kept for legal retention)
                  </li>
                  <li>
                    <strong>{plan.estimatedObjectsDeleted}</strong> stored files destroyed
                  </li>
                  <li>This cannot be undone</li>
                </ul>
              </div>
              <div className="effect deny">
                <h6>If you deny</h6>
                <ul>
                  <li>Nothing is deleted or changed</li>
                  <li>The refusal is written to the audit trail</li>
                  <li>The agent is told why and stops</li>
                </ul>
              </div>
            </div>
          </>
        ) : (
          <div className="banner info">
            The harness paused a destructive call, but the console could not resolve its stored plan
            {planId ? ` (${planId})` : ''}. Deny unless you can confirm the scope independently.
          </div>
        )}

        <div className="gate-actions">
          <button
            className="btn approve"
            disabled={busy}
            onClick={() => onDecide('allow')}
          >
            {busy ? 'Submitting...' : 'Approve erasure'}
          </button>
          <button
            className="btn deny"
            disabled={busy}
            onClick={() => onDecide('deny', 'Operator denied the erasure from the Tombstone console.')}
          >
            Deny
          </button>
          <span className="gate-note">
            Enforced by TrueForge, not by this console.
            <br />
            The tool cannot run without a decision.
          </span>
        </div>
      </div>
    </div>
  );
}
