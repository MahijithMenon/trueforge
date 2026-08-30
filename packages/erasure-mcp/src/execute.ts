import { randomUUID } from 'node:crypto';
import { appendAudit } from './audit.ts';
import type { Client, Pool } from './db.ts';
import { withTransaction } from './db.ts';
import type { ObjectStore } from './objectstore.ts';
import { assertPlanExecutable, PlanValidationError, type ErasurePlan } from './plan.ts';
import { redactedValue } from './policy.ts';

export interface ActionOutcome {
  system: string;
  table: string;
  disposition: string;
  rowsAffected: number;
}

export interface ObjectOutcome {
  objectKey: string;
  removed: boolean;
  sha256: string | null;
}

export interface Receipt {
  receiptId: string;
  caseId: string;
  planId: string;
  customerId: number;
  actions: ActionOutcome[];
  objects: ObjectOutcome[];
  rowsAffected: number;
  objectsDeleted: number;
  auditHead: string;
  executedAt: string;
  idempotentReplay: boolean;
}

export class ErasureRefused extends Error {
  readonly code: string;
  readonly detail: unknown;
  /** Case the refusal belongs to, so it can be audited after rollback. */
  readonly caseId: string | null;
  constructor(code: string, message: string, detail: unknown = {}, caseId: string | null = null) {
    super(message);
    this.name = 'ErasureRefused';
    this.code = code;
    this.detail = detail;
    this.caseId = caseId;
  }
}

interface StoredPlanRow {
  plan: ErasurePlan;
  plan_hash: string;
  customer_id: string;
  case_id: string;
}

/**
 * Executes an approved erasure plan.
 *
 * Everything here is intentionally suspicious of its caller. By the time this
 * runs, a human has approved the action in the harness — but approval says
 * "yes, do the thing you described", not "yes, do whatever you like". So the
 * legal hold, the plan hash, the policy dispositions and the blast radius are
 * all re-checked here, server-side, at the moment of destruction.
 */
export async function executeErasure(args: {
  pool: Pool;
  objects: ObjectStore;
  planId: string;
  maxRows: number;
  actor: string;
}): Promise<Receipt> {
  try {
    return await runErasureTransaction(args);
  } catch (error) {
    if (error instanceof ErasureRefused) {
      // A refusal must outlive the rollback that caused it. Writing the audit
      // entry inside the aborted transaction would discard the very record
      // that proves the system declined to act, so it goes in its own.
      await recordRefusal(args.pool, args.actor, args.planId, error);
    }
    throw error;
  }
}

/**
 * Best-effort audit of a refusal. It must never mask the original refusal, so
 * a failure to write the entry is swallowed after being surfaced on stderr.
 */
async function recordRefusal(
  pool: Pool,
  actor: string,
  planId: string,
  refusal: ErasureRefused,
): Promise<void> {
  try {
    await withTransaction(pool, (client) =>
      appendAudit(client, {
        caseId: refusal.caseId,
        actor,
        action: `erasure.refused.${refusal.code}`,
        detail: { plan_id: planId, code: refusal.code, message: refusal.message, detail: refusal.detail },
      }),
    );
  } catch (error) {
    process.stderr.write(
      `failed to record erasure refusal for ${planId}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function runErasureTransaction(args: {
  pool: Pool;
  objects: ObjectStore;
  planId: string;
  maxRows: number;
  actor: string;
}): Promise<Receipt> {
  const { pool, objects, planId, maxRows, actor } = args;

  return withTransaction(pool, async (client) => {
    const stored = await client.query<StoredPlanRow>(
      'SELECT plan, plan_hash, customer_id, case_id FROM erasure.plans WHERE id = $1',
      [planId],
    );
    const row = stored.rows[0];
    if (!row) throw new ErasureRefused('plan_not_found', `No stored plan with id ${planId}.`);

    // Idempotency: replaying an approved execution returns the original receipt
    // instead of deleting twice or erroring.
    const existing = await client.query<{ receipt: Receipt }>(
      'SELECT receipt FROM erasure.receipts WHERE plan_id = $1',
      [planId],
    );
    const priorReceipt = existing.rows[0]?.receipt;
    if (priorReceipt) return { ...priorReceipt, idempotentReplay: true };

    const customerId = Number(row.customer_id);

    // Lock the subject so a legal hold cannot be added concurrently between the
    // check below and the deletes that follow.
    const locked = await client.query<{ id: string; email: string; full_name: string }>(
      'SELECT id, email, full_name FROM app_data.customers WHERE id = $1 FOR UPDATE',
      [customerId],
    );
    const subjectRow = locked.rows[0];
    if (!subjectRow) throw new ErasureRefused('subject_not_found', `Customer ${customerId} no longer exists.`);

    // --- Guard 1: legal hold, re-checked under lock, server-side. ------------
    const holds = await client.query<{ id: string; reason: string; matter_ref: string }>(
      'SELECT id, reason, matter_ref FROM erasure.legal_holds WHERE customer_id = $1 AND active',
      [customerId],
    );
    if (holds.rows.length > 0) {
      throw new ErasureRefused(
        'legal_hold_active',
        `Erasure refused: customer ${customerId} is under an active legal hold.`,
        { holds: holds.rows.map((h) => ({ matterRef: h.matter_ref, reason: h.reason })) },
        row.case_id,
      );
    }

    // --- Guard 2: plan integrity, scope and blast radius. --------------------
    try {
      assertPlanExecutable(row.plan, row.plan_hash, customerId, maxRows);
    } catch (error) {
      if (error instanceof PlanValidationError) {
        throw new ErasureRefused(error.code, error.message, {}, row.case_id);
      }
      throw error;
    }

    const plan = row.plan;
    const actions = await applyActions(client, plan, customerId);
    const objectOutcomes = await applyObjectDeletions(objects, plan.objectKeys);

    await client.query('UPDATE app_data.customers SET erased_at = now() WHERE id = $1', [customerId]);

    const rowsAffected = actions.reduce((sum, a) => sum + a.rowsAffected, 0);
    const objectsDeleted = objectOutcomes.filter((o) => o.removed).length;
    const receiptId = `rcpt_${randomUUID()}`;

    const audit = await appendAudit(client, {
      caseId: row.case_id,
      actor,
      action: 'erasure.executed',
      detail: {
        plan_id: planId,
        plan_hash: row.plan_hash,
        customer_id: customerId,
        rows_affected: rowsAffected,
        objects_deleted: objectsDeleted,
        actions,
        objects: objectOutcomes,
      },
    });

    const receipt: Receipt = {
      receiptId,
      caseId: row.case_id,
      planId,
      customerId,
      actions,
      objects: objectOutcomes,
      rowsAffected,
      objectsDeleted,
      auditHead: audit.entryHash,
      executedAt: new Date().toISOString(),
      idempotentReplay: false,
    };

    await client.query(
      'INSERT INTO erasure.receipts (id, plan_id, case_id, receipt) VALUES ($1, $2, $3, $4::jsonb)',
      [receiptId, planId, row.case_id, JSON.stringify(receipt)],
    );
    await client.query("UPDATE erasure.cases SET status = 'executed' WHERE id = $1", [row.case_id]);

    return receipt;
  });
}

/**
 * Applies each planned action. Table and column names are re-derived from the
 * policy inside `assertPlanExecutable`, so by this point they are known-good
 * identifiers rather than caller-supplied strings.
 */
async function applyActions(client: Client, plan: ErasurePlan, customerId: number): Promise<ActionOutcome[]> {
  const outcomes: ActionOutcome[] = [];

  for (const action of plan.actions) {
    const keyColumn = action.table === 'app_data.customers' ? 'id' : 'customer_id';
    let rowsAffected = 0;

    if (action.disposition === 'delete') {
      const result = await client.query(`DELETE FROM ${action.table} WHERE ${keyColumn} = $1`, [customerId]);
      rowsAffected = result.rowCount ?? 0;
    } else if (action.disposition === 'redact') {
      const assignments: string[] = [];
      const params: unknown[] = [customerId];
      for (const column of action.redactColumns) {
        params.push(redactedValue(action.table, column, customerId));
        assignments.push(`${column} = $${params.length}`);
      }
      if (action.table === 'app_data.invoices') assignments.push('redacted_at = now()');
      if (assignments.length === 0) continue;
      const result = await client.query(
        `UPDATE ${action.table} SET ${assignments.join(', ')} WHERE ${keyColumn} = $1`,
        params,
      );
      rowsAffected = result.rowCount ?? 0;
    } else {
      // 'retain' — recorded for the audit trail, deliberately no-op.
      rowsAffected = 0;
    }

    outcomes.push({
      system: action.system,
      table: action.table,
      disposition: action.disposition,
      rowsAffected,
    });
  }
  return outcomes;
}

async function applyObjectDeletions(objects: ObjectStore, keys: readonly string[]): Promise<ObjectOutcome[]> {
  const outcomes: ObjectOutcome[] = [];
  for (const key of keys) {
    const { removed, digest } = await objects.remove(key);
    outcomes.push({ objectKey: key, removed, sha256: digest });
  }
  return outcomes;
}
