import type { Client, Pool } from './db.ts';
import { RETENTION_POLICY, type Disposition } from './policy.ts';

export interface LegalHold {
  id: number;
  reason: string;
  matterRef: string;
}

export interface SystemFootprint {
  system: string;
  table: string;
  disposition: Disposition;
  matchedRows: number;
  redactColumns: string[];
  basis: string;
}

export interface Subject {
  id: number;
  email: string;
  fullName: string;
  erasedAt: string | null;
}

export interface Footprint {
  subject: Subject;
  systems: SystemFootprint[];
  objectKeys: string[];
  totalRows: number;
  legalHolds: LegalHold[];
  scannedAt: string;
}

/** Resolves an email to a data subject. Returns null when unknown. */
export async function findSubject(db: Pool | Client, email: string): Promise<Subject | null> {
  const { rows } = await db.query<{ id: string; email: string; full_name: string; erased_at: Date | null }>(
    'SELECT id, email, full_name, erased_at FROM app_data.customers WHERE lower(email) = lower($1)',
    [email],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    fullName: row.full_name,
    erasedAt: row.erased_at ? row.erased_at.toISOString() : null,
  };
}

export async function getSubjectById(db: Pool | Client, id: number): Promise<Subject | null> {
  const { rows } = await db.query<{ id: string; email: string; full_name: string; erased_at: Date | null }>(
    'SELECT id, email, full_name, erased_at FROM app_data.customers WHERE id = $1',
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    fullName: row.full_name,
    erasedAt: row.erased_at ? row.erased_at.toISOString() : null,
  };
}

export async function getActiveLegalHolds(db: Pool | Client, customerId: number): Promise<LegalHold[]> {
  const { rows } = await db.query<{ id: string; reason: string; matter_ref: string }>(
    'SELECT id, reason, matter_ref FROM erasure.legal_holds WHERE customer_id = $1 AND active ORDER BY id',
    [customerId],
  );
  return rows.map((r) => ({ id: Number(r.id), reason: r.reason, matterRef: r.matter_ref }));
}

/**
 * Counts the subject's rows in every system named by the retention policy.
 *
 * Table names are interpolated, but they come only from the frozen
 * RETENTION_POLICY constant and never from caller input, so there is no
 * injection surface. The customer id is always parameterised.
 */
export async function scanFootprint(db: Pool | Client, subject: Subject): Promise<Footprint> {
  const systems: SystemFootprint[] = [];

  for (const rule of RETENTION_POLICY) {
    const keyColumn = rule.table === 'app_data.customers' ? 'id' : 'customer_id';
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM ${rule.table} WHERE ${keyColumn} = $1`,
      [subject.id],
    );
    systems.push({
      system: rule.system,
      table: rule.table,
      disposition: rule.disposition,
      matchedRows: Number(rows[0]?.count ?? 0),
      redactColumns: [...(rule.redactColumns ?? [])],
      basis: rule.basis,
    });
  }

  const objects = await db.query<{ object_key: string }>(
    'SELECT object_key FROM app_data.attachments WHERE customer_id = $1 ORDER BY object_key',
    [subject.id],
  );

  const legalHolds = await getActiveLegalHolds(db, subject.id);

  return {
    subject,
    systems,
    objectKeys: objects.rows.map((r) => r.object_key),
    totalRows: systems.reduce((sum, s) => sum + s.matchedRows, 0),
    legalHolds,
    scannedAt: new Date().toISOString(),
  };
}

/**
 * Residual personal data after an erasure. Used to verify the outcome rather
 * than take the agent's word for it.
 */
export async function findResidualPii(
  db: Pool | Client,
  subject: Subject,
  originalEmail: string,
  originalName: string,
): Promise<{ table: string; column: string; matches: number }[]> {
  const probes: { table: string; column: string }[] = [
    { table: 'app_data.customers', column: 'email' },
    { table: 'app_data.customers', column: 'full_name' },
    { table: 'app_data.support_tickets', column: 'body' },
    { table: 'app_data.marketing_events', column: 'email_sent_to' },
    { table: 'app_data.invoices', column: 'bill_to_email' },
    { table: 'app_data.invoices', column: 'bill_to_name' },
  ];
  const findings: { table: string; column: string; matches: number }[] = [];
  for (const probe of probes) {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM ${probe.table}
       WHERE ${probe.column} IS NOT NULL AND (${probe.column} ILIKE $1 OR ${probe.column} ILIKE $2)`,
      [`%${originalEmail}%`, `%${originalName}%`],
    );
    const matches = Number(rows[0]?.count ?? 0);
    if (matches > 0) findings.push({ ...probe, matches });
  }
  return findings;
}
