# Demo script (3 minutes)

Rehearsable and deterministic. The estate resets to a known state, and both outcomes — approval and refusal — are one click each.

## Before recording

```bash
npm run db:reset        # restores the seeded estate and object fixtures
```

Confirm all four services are up and the console header shows **database** and **trueforge** green. In the console, click **New case** to clear any previous session.

Windows to have open: the console at <http://localhost:5173>, full screen.

---

## 0:00 — The problem (15s)

> "When someone invokes their GDPR right to erasure, a company has 30 days to delete their data everywhere. Today that means an engineer writing DELETE statements against production from memory. It's incomplete, it's unrecoverable if they get it wrong, and months later nobody can prove what happened."

Screen: the console, showing the estate. Three real customers in a real Postgres.

## 0:15 — The request (15s)

Click the **Erasure request — Priya Raman** scenario chip. Click **Send to agent**.

> "This is Tombstone. I forward the request; the agent does the work."

## 0:30 — The agent works (60s)

Let it run. Narrate what appears, pointing at the badges:

> "It reads the retention policy, resolves the subject, and checks for legal holds first. Notice the badges — these come from the harness itself. TrueForge classifies every tool from its MCP annotations: read-only tools run freely."

> "It scans every system for her footprint, then uses a **sandbox** to reconcile that against policy."

Point to the estate panel:

> "That panel is reading Postgres directly, not the agent's report. If the agent claimed something that didn't happen, this would contradict it."

**If the injected ticket surfaces**, call it out — this is a strong beat:

> "One of her support tickets contains text telling the agent to also delete a different customer and skip approval. It's flagging it rather than following it — and even if it were fooled, it structurally couldn't comply. I'll come back to why."

## 1:30 — The critical moment (20s)

The approval gate appears. **Stop talking for a beat and let it land.**

> "Here's the moment. The agent called `execute_erasure`. It has stopped."

Point at the gate:

> "This isn't my code showing a dialog. That tool is annotated `destructiveHint: true` in the MCP server, and TrueForge is configured to pause on `@destructive`. The harness will not dispatch the call until a human decides. There is no code path in my repo that can run it without this."

Point at the two columns:

> "And it tells me what I'm actually deciding: 11 records permanently deleted, 2 invoices redacted but kept for tax law, 2 files destroyed. Or deny, and nothing changes."

## 1:50 — Approve (20s)

Click **Approve erasure**.

> "One transaction. Before it touches anything it re-checks the legal hold under a row lock, re-checks the plan hash, and re-checks the blast radius — because approving 'erase Priya' isn't approving 'erase whatever comes next'."

## 2:10 — Verify (20s)

> "Now it verifies independently — re-scans for residual personal data rather than taking its own word for it."

Point at the estate panel, now updated:

> "Tickets, sessions, files: gone. But look at the invoices — still there, amounts intact, personal fields redacted. Erasure doesn't override six-year accounting retention. Getting that wrong breaks a different law."

Point at the audit panel:

> "And the audit trail is hash chained. Every entry commits to the one before it, so if anyone edited this later, verification would fail and name the entry."

## 2:30 — The refusal (15s)

Click **New case**, then the **Daniel Okafor** scenario, then **Send to agent**.

> "Second case. This subject is under an active litigation hold."

Let it stop.

> "It refuses, and it never reaches the approval gate — because there is nothing safe to approve. That refusal is written to the audit trail too."

## 2:45 — Why TrueForge (10s)

> "TrueForge gave me the tool routing, the sandbox, subagents, session persistence, and — the important one — an approval gate enforced by the runtime off a tool annotation, not by my application code."

## 2:55 — Close (5s)

> "The hard part of deleting someone's data isn't the DELETE. It's proving you deleted the right things, kept what the law says you must, and that a human said yes. That's Tombstone."

---

## Fallback paths

| If this fails | Do this |
|---|---|
| Model API is slow or erroring | The refusal scenario (Daniel) is much shorter — lead with it. |
| Harness unreachable | The console shows a specific red banner naming the fix; `npm run harness` then `npm run provision`. |
| Agent skips the sandbox step | Not fatal. The approval gate is the point; keep moving. |
| Anything corrupts the estate mid-take | `npm run db:reset` restores in about a second. |
| Everything model-dependent fails | `node scripts/smoke-mcp.mjs` demonstrates the full erasure lifecycle, annotations, legal-hold refusal and idempotency with no model involved. Not the demo, but proof the system works. |

## Facts worth having exact

- 9 MCP tools: 6 `@read-only`, 2 `@write`, 1 `@destructive`.
- Priya's footprint: 3 tickets, 3 sessions, 3 marketing events, 2 files, 2 invoices, 1 customer row = 14 rows.
- After erasure: 11 rows deleted, 3 redacted (1 customer + 2 invoices), 2 objects destroyed.
- 52 tests; integration tests run against real Postgres.
