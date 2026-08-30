import { describe, expect, it } from 'vitest';
import { PlanValidationError, assertPlanExecutable, buildPlan, hashPlan, type ErasurePlan } from '../src/plan.ts';
import { RETENTION_POLICY } from '../src/policy.ts';
import type { Footprint } from '../src/scan.ts';

/**
 * Plan validation is the last thing that runs before data is destroyed, and it
 * runs after a human has already approved. Every branch here is a specific way
 * an approved-but-wrong plan could still cause damage, so each is tested.
 */

const subject = { id: 1, email: 'priya.raman@example.com', fullName: 'Priya Raman', erasedAt: null };

function footprint(overrides: Partial<Footprint> = {}): Footprint {
  return {
    subject,
    systems: RETENTION_POLICY.map((rule) => ({
      system: rule.system,
      table: rule.table,
      disposition: rule.disposition,
      matchedRows: rule.table === 'app_data.customers' ? 1 : 3,
      redactColumns: [...(rule.redactColumns ?? [])],
      basis: rule.basis,
    })),
    objectKeys: ['priya/passport-scan.txt', 'priya/support-photo.txt'],
    totalRows: 16,
    legalHolds: [],
    scannedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildPlan', () => {
  it('derives dispositions from policy rather than from the caller', () => {
    const plan = buildPlan('case_1', footprint());
    const invoices = plan.actions.find((a) => a.table === 'app_data.invoices');
    const tickets = plan.actions.find((a) => a.table === 'app_data.support_tickets');
    expect(invoices?.disposition).toBe('redact');
    expect(tickets?.disposition).toBe('delete');
  });

  it('omits systems the subject has no records in', () => {
    const empty = footprint({
      systems: RETENTION_POLICY.map((rule) => ({
        system: rule.system,
        table: rule.table,
        disposition: rule.disposition,
        matchedRows: rule.table === 'app_data.sessions' ? 0 : 2,
        redactColumns: [...(rule.redactColumns ?? [])],
        basis: rule.basis,
      })),
    });
    const plan = buildPlan('case_1', empty);
    expect(plan.actions.some((a) => a.table === 'app_data.sessions')).toBe(false);
  });

  it('carries the subject identity so scope can be re-checked later', () => {
    const plan = buildPlan('case_1', footprint());
    expect(plan.customerId).toBe(1);
    expect(plan.subjectEmail).toBe('priya.raman@example.com');
  });
});

describe('hashPlan', () => {
  it('is stable for identical plans', () => {
    expect(hashPlan(buildPlan('case_1', footprint()))).toBe(hashPlan(buildPlan('case_1', footprint())));
  });

  it('changes if the scope changes', () => {
    const plan = buildPlan('case_1', footprint());
    const widened: ErasurePlan = {
      ...plan,
      actions: plan.actions.map((a) => ({ ...a, estimatedRows: a.estimatedRows + 1 })),
    };
    expect(hashPlan(widened)).not.toBe(hashPlan(plan));
  });
});

describe('assertPlanExecutable', () => {
  const plan = buildPlan('case_1', footprint());
  const hash = hashPlan(plan);

  it('accepts an untampered plan', () => {
    expect(() => assertPlanExecutable(plan, hash, 1, 10_000)).not.toThrow();
  });

  it('rejects a plan whose contents no longer match its stored hash', () => {
    const tampered: ErasurePlan = { ...plan, customerId: 1, objectKeys: [...plan.objectKeys, 'x/y.txt'] };
    expect(() => assertPlanExecutable(tampered, hash, 1, 10_000)).toThrowError(
      expect.objectContaining({ code: 'plan_hash_mismatch' }),
    );
  });

  it('rejects a plan aimed at a different subject than its case', () => {
    const other = { ...plan, customerId: 2 };
    expect(() => assertPlanExecutable(other, hashPlan(other), 1, 10_000)).toThrowError(
      expect.objectContaining({ code: 'plan_subject_mismatch' }),
    );
  });

  it('rejects a table outside the retention policy', () => {
    const rogue: ErasurePlan = {
      ...plan,
      actions: [
        {
          system: 'Rogue',
          table: 'app_data.secrets',
          disposition: 'delete',
          estimatedRows: 1,
          redactColumns: [],
          basis: 'none',
        },
      ],
    };
    expect(() => assertPlanExecutable(rogue, hashPlan(rogue), 1, 10_000)).toThrowError(
      expect.objectContaining({ code: 'table_not_allowed' }),
    );
  });

  it('rejects deleting a table the policy says must be redacted', () => {
    const escalated: ErasurePlan = {
      ...plan,
      actions: plan.actions.map((a) =>
        a.table === 'app_data.invoices' ? { ...a, disposition: 'delete' as const } : a,
      ),
    };
    expect(() => assertPlanExecutable(escalated, hashPlan(escalated), 1, 10_000)).toThrowError(
      expect.objectContaining({ code: 'disposition_mismatch' }),
    );
  });

  it('rejects a plan whose blast radius exceeds the configured ceiling', () => {
    expect(() => assertPlanExecutable(plan, hash, 1, 2)).toThrowError(
      expect.objectContaining({ code: 'blast_radius_exceeded' }),
    );
  });

  it('throws PlanValidationError so callers can distinguish refusal from a bug', () => {
    try {
      assertPlanExecutable(plan, 'not-the-hash', 1, 10_000);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PlanValidationError);
    }
  });
});
