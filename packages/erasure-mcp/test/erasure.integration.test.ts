import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, verifyAuditChain } from '../src/audit.ts';
import { withTransaction, type Pool } from '../src/db.ts';
import { ErasureRefused, executeErasure } from '../src/execute.ts';
import { ObjectStore } from '../src/objectstore.ts';
import { buildPlan, hashPlan, newPlanId } from '../src/plan.ts';
import { getSubjectById, scanFootprint } from '../src/scan.ts';
import { DANIEL_ID, PRIYA_ID, createTestPool, resetTestDatabase } from './helpers.ts';

/**
 * End-to-end erasure against a real Postgres.
 *
 * These tests deliberately go through the same code the MCP tools call, so the
 * transaction boundaries, constraints and locking behaviour are the real ones.
 */

let pool: Pool;
let objects: ObjectStore;

beforeAll(async () => {
  pool = await createTestPool();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
  const root = await mkdtemp(path.join(tmpdir(), 'tombstone-int-'));
  objects = new ObjectStore(root);
  await objects.init();
  await objects.put('priya/passport-scan.txt', 'passport');
  await objects.put('priya/support-photo.txt', 'photo');
  await objects.put('daniel/contract-draft.txt', 'contract');
});

afterAll(async () => {
  await pool.end();
});

/** Opens a case and stores a plan, mirroring what the write tools do. */
async function preparePlan(customerId: number): Promise<{ caseId: string; planId: string }> {
  const subject = await getSubjectById(pool, customerId);
  if (!subject) throw new Error('missing subject');
  const footprint = await scanFootprint(pool, subject);
  const caseId = `case_test_${customerId}_${Date.now()}`;
  const plan = buildPlan(caseId, footprint);
  const planId = newPlanId();

  await withTransaction(pool, async (client) => {
    await client.query(
      'INSERT INTO erasure.cases (id, customer_id, requested_by, reason) VALUES ($1, $2, $3, $4)',
      [caseId, customerId, 'test@company.example', 'integration test'],
    );
    await appendAudit(client, {
      caseId,
      actor: 'test',
      action: 'case.opened',
      detail: { subject_id: customerId, subject_email: subject.email, subject_name: subject.fullName },
    });
    await client.query(
      'INSERT INTO erasure.plans (id, case_id, customer_id, plan, plan_hash) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [planId, caseId, customerId, JSON.stringify(plan), hashPlan(plan)],
    );
  });
  return { caseId, planId };
}

const run = (planId: string, maxRows = 10_000) =>
  executeErasure({ pool, objects, planId, maxRows, actor: 'test' });

describe('successful erasure', () => {
  it('destroys erasable records and reports what it did', async () => {
    const { planId } = await preparePlan(PRIYA_ID);
    const receipt = await run(planId);

    expect(receipt.idempotentReplay).toBe(false);
    expect(receipt.rowsAffected).toBeGreaterThan(0);
    expect(receipt.objectsDeleted).toBe(2);

    const tickets = await pool.query('SELECT 1 FROM app_data.support_tickets WHERE customer_id = $1', [PRIYA_ID]);
    const sessions = await pool.query('SELECT 1 FROM app_data.sessions WHERE customer_id = $1', [PRIYA_ID]);
    expect(tickets.rowCount).toBe(0);
    expect(sessions.rowCount).toBe(0);
  });

  it('redacts invoices instead of deleting them, preserving the financial record', async () => {
    const { planId } = await preparePlan(PRIYA_ID);
    await run(planId);

    const { rows } = await pool.query<{
      invoice_number: string; amount_cents: string; bill_to_name: string | null;
      bill_to_email: string | null; redacted_at: Date | null;
    }>('SELECT * FROM app_data.invoices WHERE customer_id = $1 ORDER BY invoice_number', [PRIYA_ID]);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.redacted_at).not.toBeNull();
      expect(row.bill_to_email).toBeNull();
      expect(row.bill_to_name).toBe('ERASED');
      // The amount is the whole point of retaining the record.
      expect(Number(row.amount_cents)).toBeGreaterThan(0);
    }
  });

  it('tombstones the customer row rather than breaking invoice references', async () => {
    const { planId } = await preparePlan(PRIYA_ID);
    await run(planId);

    const { rows } = await pool.query<{ email: string; full_name: string; erased_at: Date | null }>(
      'SELECT email, full_name, erased_at FROM app_data.customers WHERE id = $1',
      [PRIYA_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe(`erased+${PRIYA_ID}@invalid.local`);
    expect(rows[0]!.full_name).toBe('ERASED');
    expect(rows[0]!.erased_at).not.toBeNull();
  });

  it('does not touch any other data subject', async () => {
    const { planId } = await preparePlan(PRIYA_ID);
    await run(planId);

    const daniel = await pool.query<{ email: string }>(
      'SELECT email FROM app_data.customers WHERE id = $1',
      [DANIEL_ID],
    );
    expect(daniel.rows[0]!.email).toBe('daniel.okafor@example.com');
    const danielTickets = await pool.query('SELECT 1 FROM app_data.support_tickets WHERE customer_id = $1', [
      DANIEL_ID,
    ]);
    expect(danielTickets.rowCount).toBe(1);
    expect(await objects.exists('daniel/contract-draft.txt')).toBe(true);
  });

  it('leaves the audit chain intact and verifiable', async () => {
    const { planId } = await preparePlan(PRIYA_ID);
    await run(planId);
    const chain = await withTransaction(pool, (c) => verifyAuditChain(c));
    expect(chain.valid).toBe(true);
  });
});

describe('idempotency', () => {
  it('returns the original receipt on replay instead of deleting twice', async () => {
    const { planId } = await preparePlan(PRIYA_ID);
    const first = await run(planId);
    const second = await run(planId);

    expect(second.idempotentReplay).toBe(true);
    expect(second.receiptId).toBe(first.receiptId);
    expect(second.rowsAffected).toBe(first.rowsAffected);

    const receipts = await pool.query('SELECT 1 FROM erasure.receipts WHERE plan_id = $1', [planId]);
    expect(receipts.rowCount).toBe(1);
  });
});

describe('refusals that do not depend on the model', () => {
  /**
   * The important case: the hold is placed AFTER the plan was prepared and
   * approved. Only a server-side re-check at execution time catches this.
   */
  it('refuses when a legal hold appears between planning and execution', async () => {
    const { planId } = await preparePlan(PRIYA_ID);
    await pool.query(
      'INSERT INTO erasure.legal_holds (customer_id, reason, matter_ref) VALUES ($1, $2, $3)',
      [PRIYA_ID, 'Litigation opened after the plan was approved', 'MATTER-LATE-1'],
    );

    await expect(run(planId)).rejects.toThrowError(
      expect.objectContaining({ code: 'legal_hold_active' }),
    );

    // Nothing was destroyed.
    const tickets = await pool.query('SELECT 1 FROM app_data.support_tickets WHERE customer_id = $1', [PRIYA_ID]);
    expect(tickets.rowCount).toBe(3);
    expect(await objects.exists('priya/passport-scan.txt')).toBe(true);
  });

  it('records the refusal in the audit trail', async () => {
    const { planId, caseId } = await preparePlan(PRIYA_ID);
    await pool.query('INSERT INTO erasure.legal_holds (customer_id, reason, matter_ref) VALUES ($1,$2,$3)', [
      PRIYA_ID,
      'hold',
      'M-1',
    ]);
    await expect(run(planId)).rejects.toThrow(ErasureRefused);

    const { rows } = await pool.query<{ action: string }>(
      'SELECT action FROM erasure.audit_log WHERE case_id = $1 ORDER BY seq',
      [caseId],
    );
    // The refusal is written in its own transaction, so it survives the
    // rollback of the erasure attempt that produced it.
    expect(rows.map((r) => r.action)).toContain('erasure.refused.legal_hold_active');

    const chain = await withTransaction(pool, (c) => verifyAuditChain(c));
    expect(chain.valid).toBe(true);
  });

  it('refuses an unknown plan id', async () => {
    await expect(run('plan_does_not_exist')).rejects.toThrowError(
      expect.objectContaining({ code: 'plan_not_found' }),
    );
  });

  it('refuses a plan whose stored contents were tampered with', async () => {
    const { planId } = await preparePlan(PRIYA_ID);
    // Simulate someone editing the stored plan to widen its scope without
    // updating the hash.
    await pool.query(
      `UPDATE erasure.plans
       SET plan = jsonb_set(plan, '{estimatedRowsAffected}', '9999'::jsonb)
       WHERE id = $1`,
      [planId],
    );
    await expect(run(planId)).rejects.toThrowError(
      expect.objectContaining({ code: 'plan_hash_mismatch' }),
    );
  });

  it('refuses a plan that exceeds the blast-radius ceiling', async () => {
    const { planId } = await preparePlan(PRIYA_ID);
    await expect(run(planId, 2)).rejects.toThrowError(
      expect.objectContaining({ code: 'blast_radius_exceeded' }),
    );
    const tickets = await pool.query('SELECT 1 FROM app_data.support_tickets WHERE customer_id = $1', [PRIYA_ID]);
    expect(tickets.rowCount).toBe(3);
  });

  it('rolls back completely when execution is refused mid-transaction', async () => {
    const { planId } = await preparePlan(PRIYA_ID);
    await pool.query('INSERT INTO erasure.legal_holds (customer_id, reason, matter_ref) VALUES ($1,$2,$3)', [
      PRIYA_ID,
      'hold',
      'M-2',
    ]);
    await expect(run(planId)).rejects.toThrow();

    const customer = await pool.query<{ erased_at: Date | null }>(
      'SELECT erased_at FROM app_data.customers WHERE id = $1',
      [PRIYA_ID],
    );
    expect(customer.rows[0]!.erased_at).toBeNull();
    const receipts = await pool.query('SELECT 1 FROM erasure.receipts WHERE plan_id = $1', [planId]);
    expect(receipts.rowCount).toBe(0);
  });
});
