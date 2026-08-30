// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalGate } from '../src/components/ApprovalGate';
import type { AuditEntry, ErasurePlan } from '../src/types';

/**
 * The approval gate is the last thing a person reads before data is destroyed
 * for good. If it showed the wrong numbers, or resolved the wrong plan, an
 * operator could approve something other than what they believe they are
 * approving — so what it renders is tested, not just that it renders.
 */

afterEach(cleanup);

const PLAN: ErasurePlan = {
  caseId: 'case_1',
  customerId: 1,
  subjectEmail: 'priya.raman@example.com',
  actions: [
    { system: 'Customer directory', table: 'app_data.customers', disposition: 'redact', estimatedRows: 1, redactColumns: ['email'], basis: 'Tombstone row' },
    { system: 'Support desk', table: 'app_data.support_tickets', disposition: 'delete', estimatedRows: 3, redactColumns: [], basis: 'No retention obligation' },
    { system: 'Session log', table: 'app_data.sessions', disposition: 'delete', estimatedRows: 3, redactColumns: [], basis: 'Active accounts only' },
    { system: 'Marketing events', table: 'app_data.marketing_events', disposition: 'delete', estimatedRows: 3, redactColumns: [], basis: 'Consent withdrawn' },
    { system: 'Uploaded files', table: 'app_data.attachments', disposition: 'delete', estimatedRows: 2, redactColumns: [], basis: 'Customer content' },
    { system: 'Invoices', table: 'app_data.invoices', disposition: 'redact', estimatedRows: 2, redactColumns: ['bill_to_email'], basis: 'Statutory accounting retention' },
  ],
  objectKeys: ['priya/passport-scan.txt', 'priya/support-photo.txt'],
  estimatedRowsAffected: 14,
  estimatedObjectsDeleted: 2,
};

function auditWith(planId: string, plan: ErasurePlan): AuditEntry[] {
  return [
    {
      seq: 2, caseId: 'case_1', actor: 'agent:tombstone', action: 'plan.prepared',
      detail: { plan_id: planId, plan }, prevHash: 'a', entryHash: 'b',
      createdAt: new Date().toISOString(),
    },
    {
      seq: 1, caseId: 'case_1', actor: 'agent:tombstone', action: 'case.opened',
      detail: {}, prevHash: '0', entryHash: 'a', createdAt: new Date().toISOString(),
    },
  ];
}

const pending = (args: string) => ({
  threadId: 'main',
  toolCallId: 'call_1',
  toolName: 'execute_erasure',
  args,
});

function renderGate(args = '{"plan_id":"plan_abc"}', entries = auditWith('plan_abc', PLAN)) {
  const onDecide = vi.fn();
  render(<ApprovalGate pending={pending(args)} auditEntries={entries} busy={false} onDecide={onDecide} />);
  return { onDecide };
}

describe('what the operator is told', () => {
  it('names the destructive tool and the subject', () => {
    renderGate();
    expect(screen.getByText('execute_erasure')).toBeDefined();
    expect(screen.getByText(/priya\.raman@example\.com/)).toBeDefined();
  });

  it('is announced as a blocking decision, not a passive notice', () => {
    renderGate();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/human approval required/i)).toBeDefined();
  });

  it('lists every planned action with its disposition', () => {
    renderGate();
    expect(screen.getByText('Support desk')).toBeDefined();
    expect(screen.getByText('Invoices')).toBeDefined();
    // Four systems are deleted, two redacted.
    expect(screen.getAllByText('delete')).toHaveLength(4);
    expect(screen.getAllByText('redact')).toHaveLength(2);
  });

  it('totals deletions and redactions correctly', () => {
    renderGate();
    const approve = screen.getByText(/If you approve/i).closest('div')!;
    // 3 tickets + 3 sessions + 3 marketing + 2 files = 11 deleted.
    expect(within(approve).getByText('11')).toBeDefined();
    // 1 customer row + 2 invoices = 3 redacted.
    expect(within(approve).getByText('3')).toBeDefined();
    expect(within(approve).getByText(/cannot be undone/i)).toBeDefined();
  });

  it('states what denying preserves, so refusing is an informed choice too', () => {
    renderGate();
    const deny = screen.getByText(/If you deny/i).closest('div')!;
    expect(within(deny).getByText(/Nothing is deleted/i)).toBeDefined();
    expect(within(deny).getByText(/audit trail/i)).toBeDefined();
  });

  it('credits the harness, not the console, with enforcing the pause', () => {
    renderGate();
    expect(screen.getByText(/Enforced by TrueForge/i)).toBeDefined();
  });
});

describe('resolving the plan', () => {
  it('picks the plan matching the pending call, not merely the most recent one', () => {
    const otherPlan: ErasurePlan = { ...PLAN, subjectEmail: 'someone.else@example.com', customerId: 9 };
    const entries = [...auditWith('plan_other', otherPlan), ...auditWith('plan_abc', PLAN)];
    render(
      <ApprovalGate
        pending={pending('{"plan_id":"plan_abc"}')}
        auditEntries={entries}
        busy={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText(/priya\.raman@example\.com/)).toBeDefined();
    expect(screen.queryByText(/someone\.else@example\.com/)).toBeNull();
  });

  it('warns and advises denial when the plan cannot be resolved', () => {
    renderGate('{"plan_id":"plan_missing"}');
    expect(screen.getByText(/could not resolve its stored plan/i)).toBeDefined();
    expect(screen.getByText(/Deny unless you can confirm the scope/i)).toBeDefined();
  });

  it('does not crash on malformed tool arguments', () => {
    expect(() => renderGate('not json at all')).not.toThrow();
    expect(screen.getByText(/could not resolve its stored plan/i)).toBeDefined();
  });
});

describe('the decision', () => {
  it('reports approval', () => {
    const { onDecide } = renderGate();
    fireEvent.click(screen.getByRole('button', { name: /approve erasure/i }));
    expect(onDecide).toHaveBeenCalledWith('allow');
  });

  it('reports denial with a reason for the audit trail', () => {
    const { onDecide } = renderGate();
    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    const [decision, reason] = onDecide.mock.calls[0]!;
    expect(decision).toBe('deny');
    expect(String(reason)).toMatch(/denied/i);
  });

  it('disables both choices while a decision is in flight, preventing a double submit', () => {
    render(
      <ApprovalGate
        pending={pending('{"plan_id":"plan_abc"}')}
        auditEntries={auditWith('plan_abc', PLAN)}
        busy
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /submitting/i }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /^deny$/i }).hasAttribute('disabled')).toBe(true);
  });

  it('offers no default action, so approval requires a deliberate click', () => {
    renderGate();
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('autofocus')).toBeNull();
      expect(button.getAttribute('type')).not.toBe('submit');
    }
  });
});
