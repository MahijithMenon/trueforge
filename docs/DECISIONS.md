# Design decisions

Written so a stranger — or the person presenting this — can explain *why* the system is shaped this way, not just what it does.

## 1. Why this problem

Candidates were scored on impact, originality, how genuinely they depend on an agent harness, demo clarity, and whether they could be finished reliably in the time available.

Rejected, and why:

| Idea | Why not |
|---|---|
| Dependency/CVE remediation agent | Strong, but "AI writes a patch and opens a PR" is the most crowded category in any agent hackathon. Hard to look original. |
| Cloud cost reaper | Good approval story, but needs live cloud credentials — an external dependency that can fail on stage. |
| Incident responder from Sentry | Good, but the irreversible action is vague ("restart a service"), so the approval gate feels bolted on. |
| DB migration guardian | Close second. Lost because "migrate a schema" is a developer-only pain, and the retention/legal nuance below has no equivalent. |
| Generic analytics / research agents | The harness adds little; a plain LLM with one tool would do. |

**Right-to-erasure won on one property the others lacked: the approval gate is intrinsic.** Deleting a person's data is irreversible *by definition*, legally deadlined, and currently done by hand against production. You do not have to invent a reason for a human to be in the loop — the reason is the task.

It also has a second property that makes it demo well: **the correct answer is not "delete everything."** Invoices must be retained under accounting law; a subject under litigation hold must not be erased at all. That turns the agent from a deletion script into something that must exercise judgement, and it gives the demo a memorable beat where the system *refuses*.

## 2. Why the approval gate lives in tool annotations

The alternative would be a check in the control plane: "if the agent asks for `execute_erasure`, show a dialog."

That is worse in a specific way. It puts the gate in code that also has the ability to call the tool, so the gate and the capability sit on the same side of the boundary. Any bug, any refactor, any path that forgets the check, and the gate is gone.

By annotating `execute_erasure` with `destructiveHint: true` and configuring the agent with `require_approval_for_tools: ["@destructive"]`, the gate moves *into the runtime*. TrueForge reads the annotation off the MCP server at connect time and refuses to dispatch the call until it receives a `user.tool_approval` event. Nothing in this repository can dispatch that tool call.

This is the single most important architectural decision in the project, and it is the direct answer to "could you have built this without a harness?"

## 3. Why only `@destructive` is gated

TrueForge's default is `["@write", "@destructive"]`. We narrowed it.

Opening a case file and preparing a plan are reversible and destroy nothing. Gating them would put three approval prompts in front of the operator before the one that matters. That is how approval fatigue is manufactured: an operator who has clicked "approve" twice already is primed to click it a third time without reading.

One prompt, for the one irreversible act, is a deliberate design choice about human attention — not a shortcut.

## 4. Why the agent never authors the plan

The agent calls `prepare_erasure_plan(case_id)`. It does not supply tables, columns, or row counts.

The plan is derived server-side from a frozen policy table and a live scan, then content-addressed by hash. `execute_erasure` accepts only a stored plan id.

This means the destructive tool **has no parameter capable of expressing "delete more."** An attacker who fully controls the model's output still cannot widen the blast radius, because the only thing they can pass is an id of a plan the server itself computed. That is a structural defence, not a prompt-level one.

## 5. Why guards re-run at execution time

A human approving "erase Priya Raman" is approving a specific described action at a specific moment. Between approval and execution, the world can change — most importantly, a legal hold can be filed.

So at execution, under a row lock on the subject, the server re-checks: legal holds, plan hash, policy dispositions, subject binding, and blast radius. There is an integration test for exactly the case where a hold is placed *after* approval, because that case is only caught here.

## 6. Why invoices are redacted and customers are tombstoned

Two different reasons, both about the real world:

- **Invoices** are retained under statutory accounting obligations (UK Companies Act / HMRC, six years). Erasure does not override that, so the financial fields survive and only personal-data columns are overwritten.
- **Customers** are tombstoned rather than deleted because invoices reference them with `ON DELETE RESTRICT`. A hard delete would either fail or cascade into records the company must keep. Overwriting to a tombstone row satisfies erasure while preserving referential integrity.

This is the detail that most distinguishes the project from a deletion script.

## 7. Why the console reads Postgres directly

The estate and audit panels bypass the agent entirely and query the database.

If they rendered the agent's own report, the console would only ever confirm whatever the agent said. Reading ground truth means that if the agent claimed an erasure that did not happen, **the screen would contradict it in front of the operator.** Verification you cannot trust is theatre.

## 8. Why a hash-chained audit log

A receipt that says "we deleted 14 rows" is an assertion. A receipt whose hash commits to every prior entry is evidence: editing or removing any historical entry breaks every hash after it, and `verifyChain` recomputes from genesis and names the sequence number where it breaks.

The hashing lives in `packages/shared` because two independent components must agree on it exactly — the tool server that writes and the control plane that verifies. One implementation, so the verification panel cannot silently disagree with the writer.

## 9. Why a hand-written TrueForge client

`@truefoundry/trueforge-sdk` is published as a placeholder whose description reads "Do not use." So the client in `packages/server/src/trueforge.ts` was written against the harness's own OpenAPI document, read from a running instance at `/api/v1/openapi.json`.

No TrueForge API in this repository was guessed.

## 10. Known trade-offs

- **Blob deletion is not transactional with the database.** Documented in the README's Limitations, with the mitigation (idempotent re-run heals it) and the real fix (two-phase soft delete with a reaper).
- **No auth.** Single trusted operator on localhost, matching TrueForge's standalone mode, which prints the same warning on boot.
- **Verification is heuristic.** It probes known columns for the subject's original identifiers; it cannot find personal data in a column nobody declared.

None of these are hidden in the code. They are in the README because a compliance tool that overstates itself is worse than no tool.
