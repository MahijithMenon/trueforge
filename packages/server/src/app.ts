import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Pool } from 'pg';
import { z } from 'zod';
import { verifyChain } from '../../shared/src/audit-hash.ts';
import { AGENT_NAME, MCP_SERVER_NAME } from './agent-spec.ts';
import { getAuditTrail, getEstate } from './estate.ts';
import { TrueForgeError, type TrueForgeClient } from './trueforge.ts';

export interface AppDeps {
  pool: Pool;
  trueForge: TrueForgeClient;
  corsOrigins: string[];
}

const turnInputSchema = z.object({
  message: z.string().min(1).max(8_000),
});

const approvalSchema = z.object({
  threadId: z.string().min(1),
  toolCallId: z.string().min(1),
  decision: z.enum(['allow', 'deny']),
  reason: z.string().max(1_000).optional(),
});

/**
 * The Tombstone control plane.
 *
 * It deliberately owns very little. The agent loop, tool routing, sandboxing
 * and the approval gate all live in TrueForge; this service exists to
 *   1. keep the harness and the database off the public origin,
 *   2. give the console a ground-truth view of the estate and audit log that
 *      does not pass through the agent, and
 *   3. proxy the harness's event stream to the browser on one origin.
 *
 * It does NOT own the approval decision. It forwards it. If this service were
 * compromised it could refuse to relay an approval, but it cannot manufacture
 * one, because the harness is what gates the tool call.
 */
export function createApp(deps: AppDeps): Hono {
  const { pool, trueForge, corsOrigins } = deps;
  const app = new Hono();

  app.use('/api/*', cors({ origin: corsOrigins, allowMethods: ['GET', 'POST', 'OPTIONS'] }));

  app.onError((error, c) => {
    if (error instanceof TrueForgeError) {
      // 0 means the harness was unreachable; surface that as a gateway error
      // so the console can tell the operator what to restart.
      const status = error.status === 0 ? 502 : error.status;
      return c.json({ error: 'trueforge_error', message: error.message }, status as 502);
    }
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return c.json({ error: 'internal_error', message }, 500);
  });

  app.get('/api/health', async (c) => {
    const checks: Record<string, string> = {};
    try {
      await pool.query('SELECT 1');
      checks.database = 'ok';
    } catch (error) {
      checks.database = `unreachable: ${(error as Error).message}`;
    }
    try {
      await trueForge.listAgents();
      checks.trueforge = 'ok';
    } catch (error) {
      checks.trueforge = `unreachable: ${(error as Error).message}`;
    }
    const healthy = Object.values(checks).every((v) => v === 'ok');
    return c.json({ status: healthy ? 'ok' : 'degraded', checks }, healthy ? 200 : 503);
  });

  app.get('/api/config', (c) => c.json({ agentName: AGENT_NAME }));

  /**
   * The connector's tools and their risk tier, as the harness itself sees them.
   *
   * The console badges every tool call with this, so what the operator reads on
   * screen is derived from the same annotations that decide whether the harness
   * pauses — not from a hardcoded list that could drift out of step.
   */
  app.get('/api/tools', async (c) => {
    const response = (await trueForge.listMcpServerTools(MCP_SERVER_NAME)) as {
      data?: { name: string; description?: string; annotations?: Record<string, unknown> }[];
    };
    const tools = (response.data ?? []).map((tool) => {
      const annotations = tool.annotations ?? {};
      const tier =
        annotations.destructiveHint === true
          ? 'destructive'
          : annotations.readOnlyHint === true
            ? 'read-only'
            : 'write';
      return { name: tool.name, description: tool.description ?? '', tier, annotations };
    });
    return c.json({ server: MCP_SERVER_NAME, tools });
  });

  /** Ground truth from Postgres, not from the agent. */
  app.get('/api/estate', async (c) => c.json(await getEstate(pool)));

  /** Audit entries plus an independent recomputation of the hash chain. */
  app.get('/api/audit', async (c) => {
    const rows = await getAuditTrail(pool, 200);
    const ascending = [...rows].reverse();
    const verification = verifyChain(
      ascending.map((r) => ({
        seq: r.seq,
        caseId: r.caseId,
        actor: r.actor,
        action: r.action,
        detail: r.detail ?? {},
        prevHash: r.prevHash,
        entryHash: r.entryHash,
      })),
    );
    return c.json({ entries: rows, verification });
  });

  // ------------------------------------------------------------- sessions --

  app.post('/api/sessions', async (c) => {
    const created = await trueForge.createSession(AGENT_NAME);
    return c.json(created);
  });

  /** Replays a session's full event history so a reload loses nothing. */
  app.get('/api/sessions/:id/events', async (c) =>
    c.json(await trueForge.listSessionEvents(c.req.param('id'))),
  );

  app.post('/api/sessions/:id/cancel', async (c) =>
    c.json(await trueForge.cancelSession(c.req.param('id'))),
  );

  /** Starts a turn and streams the harness's SSE straight through. */
  app.post('/api/sessions/:id/turns', async (c) => {
    const body = turnInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: 'invalid_request', message: 'A non-empty "message" is required.' }, 400);
    }
    const upstream = await trueForge.streamTurn(c.req.param('id'), [
      { type: 'user.message', content: [{ type: 'text', text: body.data.message }] },
    ]);
    return passthrough(upstream);
  });

  /**
   * Relays an approval decision for a paused tool call.
   *
   * Note what is absent: there is no branch here that executes anything itself.
   * Allowing is not "the control plane runs the tool"; it is "the control plane
   * tells the harness the human said yes". Denying is the same in reverse.
   */
  app.post('/api/sessions/:id/approvals', async (c) => {
    const body = approvalSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json(
        { error: 'invalid_request', message: body.error.issues.map((i) => i.message).join('; ') },
        400,
      );
    }
    const { threadId, toolCallId, decision, reason } = body.data;
    const upstream = await trueForge.submitApproval(c.req.param('id'), threadId, toolCallId, {
      status: decision,
      ...(reason ? { reason } : {}),
    });
    return passthrough(upstream);
  });

  return app;
}

/** Forwards an upstream streaming response without buffering it. */
function passthrough(upstream: Response): Response {
  const headers = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('cache-control', 'no-cache, no-transform');
  headers.set('x-accel-buffering', 'no');
  return new Response(upstream.body, { status: upstream.status, headers });
}
