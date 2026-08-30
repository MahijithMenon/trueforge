import type { Estate, EstateCustomer } from '../types';

/**
 * Ground truth, straight from Postgres.
 *
 * This panel intentionally bypasses the agent. It is how the operator confirms
 * that what the agent says happened actually happened — and it is what makes
 * the before/after of an erasure visible rather than asserted.
 */

interface CountChip {
  label: string;
  value: number;
  /** Records kept under a retention obligation, styled differently from
   *  records that simply have not been erased. */
  kept?: boolean;
}

function chipsFor(customer: EstateCustomer): CountChip[] {
  const c = customer.counts;
  return [
    { label: 'tickets', value: c.supportTickets },
    { label: 'sessions', value: c.sessions },
    { label: 'marketing', value: c.marketingEvents },
    { label: 'files', value: c.attachments },
    {
      label: c.invoicesRedacted > 0 ? `invoices (${c.invoicesRedacted} redacted)` : 'invoices',
      value: c.invoices,
      kept: c.invoicesRedacted > 0,
    },
  ];
}

export function EstatePanel({ estate }: { estate: Estate | null }) {
  if (!estate) return <div className="empty">Loading estate...</div>;

  return (
    <>
      {estate.customers.map((customer) => (
        <div
          key={customer.id}
          className={`subject ${customer.erased ? 'erased' : ''} ${customer.onLegalHold ? 'hold' : ''}`}
        >
          <div className="subject-top">
            <span className="subject-name">{customer.fullName}</span>
            {customer.erased && <span className="badge erased">erased</span>}
            {customer.onLegalHold && <span className="badge hold">legal hold</span>}
          </div>
          <div className="subject-email">{customer.email}</div>
          <div className="counts">
            {chipsFor(customer).map((chip) => (
              <span
                key={chip.label}
                className={`count ${chip.value === 0 ? 'zero' : ''} ${chip.kept ? 'kept' : ''}`}
              >
                {chip.value} {chip.label}
              </span>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
