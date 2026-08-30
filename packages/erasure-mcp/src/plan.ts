import { randomUUID } from 'node:crypto';
import { canonicalize, sha256 } from './audit.ts';
import { ALLOWED_TABLES, POLICY_BY_TABLE, type Disposition } from './policy.ts';
import type { Footprint } from './scan.ts';

export interface PlanAction {
  system: string;
  table: string;
  disposition: Disposition;
  estimatedRows: number;
  redactColumns: string[];
  basis: string;
}

export interface ErasurePlan {
  caseId: string;
  customerId: number;
  subjectEmail: string;
  actions: PlanAction[];
  objectKeys: string[];
  estimatedRowsAffected: number;
  estimatedObjectsDeleted: number;
}

/**
 * Builds the plan from the footprint and the retention policy.
 *
 * The model never authors the plan. It asks for one, and this function derives
 * it deterministically, which means the destructive scope cannot be widened by
 * anything the model says or reads.
 */
export function buildPlan(caseId: string, footprint: Footprint): ErasurePlan {
  const actions = footprint.systems
    .filter((s) => s.matchedRows > 0)
    .map<PlanAction>((s) => ({
      system: s.system,
      table: s.table,
      disposition: s.disposition,
      estimatedRows: s.matchedRows,
      redactColumns: s.redactColumns,
      basis: s.basis,
    }));

  return {
    caseId,
    customerId: footprint.subject.id,
    subjectEmail: footprint.subject.email,
    actions,
    objectKeys: [...footprint.objectKeys],
    estimatedRowsAffected: actions.reduce((sum, a) => sum + a.estimatedRows, 0),
    estimatedObjectsDeleted: footprint.objectKeys.length,
  };
}

/** Content address of a plan. Any change to scope changes the hash. */
export function hashPlan(plan: ErasurePlan): string {
  return sha256(canonicalize(plan));
}

export function newPlanId(): string {
  return `plan_${randomUUID()}`;
}

export class PlanValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlanValidationError';
    this.code = code;
  }
}

/**
 * Structural validation applied immediately before execution.
 *
 * These checks are cheap and independent of the model's reasoning. They exist
 * so that a plan which was persisted correctly but has since been tampered
 * with — or which names a table outside policy — cannot execute.
 */
export function assertPlanExecutable(
  plan: ErasurePlan,
  storedHash: string,
  expectedCustomerId: number,
  maxRows: number,
): void {
  if (hashPlan(plan) !== storedHash) {
    throw new PlanValidationError('plan_hash_mismatch', 'Plan contents do not match their stored hash.');
  }
  if (plan.customerId !== expectedCustomerId) {
    throw new PlanValidationError(
      'plan_subject_mismatch',
      `Plan targets customer ${plan.customerId} but the case belongs to ${expectedCustomerId}.`,
    );
  }
  for (const action of plan.actions) {
    if (!ALLOWED_TABLES.has(action.table)) {
      throw new PlanValidationError('table_not_allowed', `Plan names a table outside policy: ${action.table}`);
    }
    const rule = POLICY_BY_TABLE.get(action.table);
    if (!rule) {
      throw new PlanValidationError('table_not_allowed', `No policy rule for ${action.table}`);
    }
    if (rule.disposition !== action.disposition) {
      throw new PlanValidationError(
        'disposition_mismatch',
        `Plan wants to ${action.disposition} ${action.table}, policy says ${rule.disposition}.`,
      );
    }
  }
  if (plan.estimatedRowsAffected > maxRows) {
    throw new PlanValidationError(
      'blast_radius_exceeded',
      `Plan affects ${plan.estimatedRowsAffected} rows, above the configured ceiling of ${maxRows}.`,
    );
  }
}
