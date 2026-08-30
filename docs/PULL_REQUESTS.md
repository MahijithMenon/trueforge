# Pull requests to open (for Qodo review)

The branches are stacked, so **merge them in order**. After each merge, the next PR's diff narrows to just its own changes.

Open each link, paste the title and body, create the PR, wait for Qodo's review, address findings, then merge.

---

## PR 1 — Erasure tool server

**Link:** <https://github.com/MahijithMenon/trueforge/compare/main...feat/erasure-tool-server?expand=1>

**Title:** `feat(erasure): policy-driven erasure tool server exposed over MCP`

**Body:**

```markdown
Adds the MCP tool server an agent uses to handle GDPR Article 17 erasure
requests against a real Postgres estate and object store.

### The design point

Tool annotations are the security boundary. TrueForge maps MCP annotations onto
its approval selectors:

| Annotation | Selector | Behaviour |
|---|---|---|
| `readOnlyHint: true` | `@read-only` | runs freely |
| `readOnlyHint: false`, `destructiveHint: false` | `@write` | runs freely |
| `destructiveHint: true` | `@destructive` | pauses for a human |

Exactly one tool — `execute_erasure` — is annotated `destructiveHint: true`.
Marking it so is what makes the harness pause; the gate is not application code.

### Safety does not rely on the model behaving

- The erasure plan is derived from a frozen retention policy, never authored by
  the agent, and is content-addressed by hash.
- `execute_erasure` accepts only a stored plan id, so a wider scope cannot be
  smuggled into the destructive call — it has no parameter that could express one.
- Legal holds are re-checked server-side under a row lock at execution time.
- Plan hash, policy dispositions and a blast-radius ceiling are re-validated
  immediately before anything is destroyed.
- Execution is idempotent: replay returns the original receipt.

Invoices are redacted rather than deleted, since statutory accounting retention
outlives an erasure request. Customers are tombstoned rather than deleted
because invoices reference them with `ON DELETE RESTRICT`.

The audit log is a hash chain, so a tampered or removed entry is detectable.

### Review focus

SQL construction in `scan.ts` and `execute.ts` (table names come only from the
frozen policy constant; the subject id is always parameterised), and the path
confinement in `objectstore.ts`.
```

---

## PR 2 — Control plane

**Link:** <https://github.com/MahijithMenon/trueforge/compare/feat/erasure-tool-server...feat/control-plane?expand=1>
*(after PR 1 merges, retarget the base to `main`)*

**Title:** `feat(server): control plane, typed TrueForge client and provisioning`

**Body:**

```markdown
The service the console talks to. It owns deliberately little: the agent loop,
tool routing, sandboxing and the approval gate all stay in TrueForge.

- **Typed TrueForge client.** The published `@truefoundry/trueforge-sdk` is a
  placeholder whose description says not to use it, so this is written against
  the running harness's OpenAPI document at `/api/v1/openapi.json`. No API was
  guessed.
- **Idempotent provisioning.** Registers model providers from the harness
  catalog, registers the erasure connector with bearer auth, and creates the
  agent. It asserts that a destructive tool was actually discovered, so a
  misconfigured approval gate fails at setup rather than mid-demo.
- **Estate and audit endpoints** read Postgres directly. The operator sees
  ground truth, not the agent's account of it — if the agent claimed an erasure
  that did not happen, the console would contradict it.
- **Approval relay.** There is no code path here that executes a tool. It
  forwards the human decision to the harness, so a compromised control plane
  could withhold an approval but not manufacture one.

### Review focus

The SSE passthrough in `app.ts`, and whether the approval endpoint can be
coerced into acting rather than relaying.
```

---

## PR 3 — Operator console

**Link:** <https://github.com/MahijithMenon/trueforge/compare/feat/control-plane...feat/console?expand=1>
*(retarget base to `main` after PR 2 merges)*

**Title:** `feat(console): operator console for supervising an irreversible agent`

**Body:**

```markdown
A three-column instrument panel rather than a chat window, built to answer four
questions at a glance: what the agent has done, what it is doing, what it is
waiting for, and what it is about to do.

- The estate panel reads Postgres directly, bypassing the agent.
- The timeline folds each tool call and its response into one item and badges it
  with the risk tier the harness itself reports via `GET /api/tools`, so labels
  cannot drift from the annotations that actually drive approval.
- **The approval gate** resolves the pending plan id back to the stored plan
  from the audit trail and states, in record counts, what approving destroys and
  what denying preserves. An approval prompt an operator cannot evaluate is a
  speed bump that trains people to click yes.
- Sessions are restored from the harness on reload, so closing the tab
  mid-erasure does not lose the case.

Also aligns vite on 5.4.21 across the workspace; vitest pinned vite 5 at the
root while the console pulled vite 6, producing two copies and a type conflict.

### Review focus

The SSE frame parser in `api.ts` (it must tolerate a malformed frame without
tearing down a live erasure) and the reducer's approval state transitions.
```

---

## PR 4 — Tests, build fixes and docs

**Link:** <https://github.com/MahijithMenon/trueforge/compare/feat/console...test/suite-and-refusal-audit-fix?expand=1>
*(retarget base to `main` after PR 3 merges)*

**Title:** `test: cover the erasure guards, fix refusals lost on rollback, and survive a DB restart`

**Body:**

```markdown
91 tests across the hash chain, retention policy, plan validation, object-store
path safety, the console reducer and the approval gate component, plus a
real-Postgres integration suite that runs in its own database so the demo
estate is never touched.

### A real defect the suite found

Refusal audit entries were written **inside the same transaction the refusal
then aborted**, so every refusal rolled back with it and left no record —
precisely the case the audit trail exists to prove. Refusals are now recorded in
a separate transaction that survives the rollback, best-effort so an audit
failure cannot mask the refusal itself.

### Cases covered

- a legal hold placed *after* a plan was approved is still caught, which only
  the server-side re-check under row lock can do;
- a stored plan edited to widen its scope is rejected on hash mismatch;
- a plan escalating invoices from `redact` to `delete` is rejected;
- object keys traversing outside the store root cannot delete anything, and a
  sibling directory sharing the root prefix does not slip through;
- replaying an approved execution returns the original receipt.

### A second defect, found by taking dependencies down

Stopping Postgres under the running services **killed both of them**.
node-postgres emits `error` on the pool when an idle client dies — what a
database restart or a proxy reaping a connection causes — and with no listener
Node terminates the process. Pool construction moved to `packages/shared` with
an idle-client error listener; verified by stopping and restarting Postgres
against the live system, after which both services degrade and then recover
with no intervention.

Health output also read `database: unreachable: ` because the driver error had
an empty message; `describeError` now falls back through errno code,
AggregateError members and error name.

### Build fixes

`erasure-mcp` could not be typechecked at all: inferring through the MCP SDK's
zod-v3/v4 compatibility generics nine times in one function exhausted the
checker's instantiation budget (TS2589, and an out-of-memory crash before that).
A narrowed `defineTool` wrapper makes the SDK call through one documented cast
while keeping our own arguments inferred by zod directly — typecheck goes from a
50s OOM crash to passing in ~1s, with identical runtime behaviour.

Plus an ESLint flat config, the README, design rationale, the demo script, and
two fixes from the first live agent run (an unsupported `temperature` param on
reasoning models, and a failed turn that showed an error status with no
explanation).

### Review focus

Whether the `defineTool` cast loses any real type safety, the best-effort error
handling in `recordRefusal`, and whether `describeError` can ever return an
empty string (there is a test asserting it cannot).
```
