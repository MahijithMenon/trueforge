/**
 * Retention policy.
 *
 * This module is pure and has no database access, which makes the single most
 * consequential decision in the product — what may be destroyed and what must
 * survive — directly unit-testable.
 *
 * The policy is deliberately *data*, not prompt text. The model may describe it,
 * argue about it or be tricked into misquoting it; execution reads this table.
 */

export type Disposition = 'delete' | 'redact' | 'retain';

export interface SystemRule {
  /** Logical system shown to the operator. */
  system: string;
  /** Physical table the rule governs. */
  table: string;
  disposition: Disposition;
  /** Columns overwritten when disposition is `redact`. */
  redactColumns?: readonly string[];
  /** Why the law allows deletion, or compels retention. */
  basis: string;
}

/**
 * `customers` is redacted rather than deleted on purpose: invoices reference it
 * with ON DELETE RESTRICT, so a hard delete would either fail or cascade into
 * records the company is legally required to keep. Redacting to a tombstone row
 * satisfies erasure while preserving referential integrity.
 */
export const RETENTION_POLICY: readonly SystemRule[] = Object.freeze([
  {
    system: 'Customer directory',
    table: 'app_data.customers',
    disposition: 'redact',
    redactColumns: ['full_name', 'email', 'phone', 'address'],
    basis: 'Erased to a tombstone row; retained key preserves invoice referential integrity.',
  },
  {
    system: 'Support desk',
    table: 'app_data.support_tickets',
    disposition: 'delete',
    basis: 'Processed on legitimate interest; no retention obligation once the account closes.',
  },
  {
    system: 'Session log',
    table: 'app_data.sessions',
    disposition: 'delete',
    basis: 'Security telemetry retained only while the account is active.',
  },
  {
    system: 'Marketing events',
    table: 'app_data.marketing_events',
    disposition: 'delete',
    basis: 'Consent withdrawn; no lawful basis to continue processing.',
  },
  {
    system: 'Uploaded files',
    table: 'app_data.attachments',
    disposition: 'delete',
    basis: 'Customer-supplied content deleted together with its object-store blobs.',
  },
  {
    system: 'Invoices',
    table: 'app_data.invoices',
    disposition: 'redact',
    redactColumns: ['bill_to_name', 'bill_to_email', 'bill_to_address'],
    basis:
      'Statutory accounting retention (UK Companies Act s.388 / HMRC 6 years). ' +
      'Financial fields are preserved; only personal-data columns are redacted.',
  },
]);

export const POLICY_BY_TABLE: ReadonlyMap<string, SystemRule> = new Map(
  RETENTION_POLICY.map((rule) => [rule.table, rule]),
);

/** Tables a plan is ever permitted to touch. Anything else is rejected. */
export const ALLOWED_TABLES: ReadonlySet<string> = new Set(RETENTION_POLICY.map((r) => r.table));

/** Value written into a redacted column. */
export function redactedValue(table: string, column: string, customerId: number): string | null {
  // Unique, non-null placeholder for columns under a UNIQUE constraint.
  if (table === 'app_data.customers' && column === 'email') {
    return `erased+${customerId}@invalid.local`;
  }
  if (column.endsWith('email')) return null;
  if (column === 'full_name' || column === 'bill_to_name') return 'ERASED';
  return null;
}
