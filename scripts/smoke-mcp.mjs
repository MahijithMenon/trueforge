/**
 * End-to-end smoke test against a running erasure-mcp server.
 *
 * Speaks real MCP over streamable HTTP, exercises the happy path, the legal-hold
 * refusal, and the idempotent replay. Run with: node scripts/smoke-mcp.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = process.env.ERASURE_MCP_PUBLIC_URL ?? 'http://127.0.0.1:8811/mcp';
const TOKEN = process.env.ERASURE_MCP_TOKEN;
if (!TOKEN) throw new Error('ERASURE_MCP_TOKEN is required');

const transport = new StreamableHTTPClientTransport(new URL(URL_), {
  requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
});
const client = new Client({ name: 'tombstone-smoke', version: '0.1.0' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '{}';
  return { isError: Boolean(res.isError), data: JSON.parse(text) };
};

let failures = 0;
const check = (label, cond, extra = '') => {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures += 1;
  console.log(`  [${mark}] ${label}${extra ? ` - ${extra}` : ''}`);
};

console.log('\n== tool annotations (these drive TrueForge approval) ==');
const { tools } = await client.listTools();
for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
  const a = t.annotations ?? {};
  const tag = a.readOnlyHint ? '@read-only' : a.destructiveHint ? '@destructive' : '@write';
  console.log(`  ${t.name.padEnd(24)} ${tag}`);
}
check('exactly one @destructive tool', tools.filter((t) => t.annotations?.destructiveHint).length === 1);
check(
  'execute_erasure is the destructive one',
  tools.find((t) => t.annotations?.destructiveHint)?.name === 'execute_erasure',
);

console.log('\n== happy path: erase Priya ==');
const subject = await call('find_data_subject', { email: 'priya.raman@example.com' });
check('subject found', subject.data.found === true);
const subjectId = subject.data.subject.id;

const footprint = await call('scan_subject_footprint', { subject_id: subjectId });
check('footprint has rows', footprint.data.totalRows > 0, `${footprint.data.totalRows} rows`);
check('no legal hold on Priya', footprint.data.legalHolds.length === 0);

const opened = await call('open_erasure_case', {
  subject_id: subjectId,
  requested_by: 'privacy@company.example',
  reason: 'GDPR Article 17 erasure request',
});
check('case opened', typeof opened.data.case_id === 'string');
const caseId = opened.data.case_id;

const planned = await call('prepare_erasure_plan', { case_id: caseId });
check('plan prepared', typeof planned.data.plan_id === 'string');
const invoiceAction = planned.data.plan.actions.find((a) => a.table === 'app_data.invoices');
check('invoices are redacted, not deleted', invoiceAction?.disposition === 'redact');
const ticketAction = planned.data.plan.actions.find((a) => a.table === 'app_data.support_tickets');
check('support tickets are deleted', ticketAction?.disposition === 'delete');

const receipt = await call('execute_erasure', { plan_id: planned.data.plan_id });
check('erasure executed', !receipt.isError, receipt.isError ? JSON.stringify(receipt.data) : '');
check('rows affected > 0', receipt.data.rowsAffected > 0, `${receipt.data.rowsAffected} rows`);
check('objects deleted', receipt.data.objectsDeleted === 2, `${receipt.data.objectsDeleted} objects`);

const replay = await call('execute_erasure', { plan_id: planned.data.plan_id });
check('replay is idempotent', replay.data.idempotentReplay === true);
check('replay returns same receipt id', replay.data.receiptId === receipt.data.receiptId);

const verified = await call('verify_erasure', { case_id: caseId });
check('no residual personal data', verified.data.residual_clean === true,
  JSON.stringify(verified.data.residual_personal_data));
check('audit chain valid', verified.data.audit_chain.valid === true);

console.log('\n== legal hold: Daniel must be refused ==');
const daniel = await call('find_data_subject', { email: 'daniel.okafor@example.com' });
const danielId = daniel.data.subject.id;
const hold = await call('check_legal_hold', { subject_id: danielId });
check('Daniel is on hold', hold.data.on_hold === true);

const danielCase = await call('open_erasure_case', {
  subject_id: danielId,
  requested_by: 'privacy@company.example',
  reason: 'erasure request',
});
const danielPlan = await call('prepare_erasure_plan', { case_id: danielCase.data.case_id });
check('planning refused under legal hold', danielPlan.isError === true, danielPlan.data.error);
check('refusal names the hold', danielPlan.data.error === 'legal_hold_active');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
