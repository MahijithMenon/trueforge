import type { Pool } from 'pg';

/**
 * Read-only views of the estate and the audit trail.
 *
 * The console reads these directly from Postgres rather than through the agent.
 * That is the point: the operator sees ground truth from the database, not the
 * agent's account of it. If the agent claimed an erasure that did not happen,
 * this panel would contradict it.
 */

export interface EstateCustomer {
  id: number;
  email: string;
  fullName: string;
  phone: string | null;
  address: string | null;
  erased: boolean;
  onLegalHold: boolean;
  counts: {
    supportTickets: number;
    sessions: number;
    marketingEvents: number;
    attachments: number;
    invoices: number;
    invoicesRedacted: number;
  };
}

export async function getEstate(pool: Pool): Promise<{ customers: EstateCustomer[]; capturedAt: string }> {
  const { rows } = await pool.query<{
    id: string; email: string; full_name: string; phone: string | null; address: string | null;
    erased: boolean; on_hold: boolean; tickets: string; sessions: string; marketing: string;
    attachments: string; invoices: string; invoices_redacted: string;
  }>(`
    SELECT c.id, c.email, c.full_name, c.phone, c.address,
           (c.erased_at IS NOT NULL) AS erased,
           EXISTS (SELECT 1 FROM erasure.legal_holds h WHERE h.customer_id = c.id AND h.active) AS on_hold,
           (SELECT count(*) FROM app_data.support_tickets t  WHERE t.customer_id = c.id) AS tickets,
           (SELECT count(*) FROM app_data.sessions s         WHERE s.customer_id = c.id) AS sessions,
           (SELECT count(*) FROM app_data.marketing_events m WHERE m.customer_id = c.id) AS marketing,
           (SELECT count(*) FROM app_data.attachments a      WHERE a.customer_id = c.id) AS attachments,
           (SELECT count(*) FROM app_data.invoices i         WHERE i.customer_id = c.id) AS invoices,
           (SELECT count(*) FROM app_data.invoices i         WHERE i.customer_id = c.id
                                                               AND i.redacted_at IS NOT NULL) AS invoices_redacted
    FROM app_data.customers c
    ORDER BY c.id
  `);

  return {
    capturedAt: new Date().toISOString(),
    customers: rows.map((r) => ({
      id: Number(r.id),
      email: r.email,
      fullName: r.full_name,
      phone: r.phone,
      address: r.address,
      erased: r.erased,
      onLegalHold: r.on_hold,
      counts: {
        supportTickets: Number(r.tickets),
        sessions: Number(r.sessions),
        marketingEvents: Number(r.marketing),
        attachments: Number(r.attachments),
        invoices: Number(r.invoices),
        invoicesRedacted: Number(r.invoices_redacted),
      },
    })),
  };
}

export interface AuditRow {
  seq: number;
  caseId: string | null;
  actor: string;
  action: string;
  detail: unknown;
  prevHash: string;
  entryHash: string;
  createdAt: string;
}

export async function getAuditTrail(pool: Pool, limit = 200): Promise<AuditRow[]> {
  const { rows } = await pool.query<{
    seq: string; case_id: string | null; actor: string; action: string;
    detail: unknown; prev_hash: string; entry_hash: string; created_at: Date;
  }>(
    `SELECT seq, case_id, actor, action, detail, prev_hash, entry_hash, created_at
     FROM erasure.audit_log ORDER BY seq DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    seq: Number(r.seq),
    caseId: r.case_id,
    actor: r.actor,
    action: r.action,
    detail: r.detail,
    prevHash: r.prev_hash,
    entryHash: r.entry_hash,
    createdAt: r.created_at.toISOString(),
  }));
}
