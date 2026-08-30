import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerErasureTools, type ToolContext } from './tools.ts';

const MAX_BODY_BYTES = 1_000_000;

/** Constant-time bearer comparison so the token cannot be recovered by timing. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAuthorized(req: http.IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return tokenMatches(header.slice('Bearer '.length).trim(), expected);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Builds a fresh McpServer for a single request.
 *
 * The transport runs in stateless mode (`sessionIdGenerator: undefined`), which
 * keeps this service horizontally scalable and means a crashed request cannot
 * leave a half-initialised session behind. All durable state lives in Postgres.
 */
function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'tombstone-erasure', version: '0.1.0' },
    {
      instructions:
        'Tools for handling GDPR Article 17 erasure requests against this company estate. ' +
        'Read-only tools investigate; execute_erasure is irreversible and requires human approval.',
    },
  );
  registerErasureTools(server, ctx);
  return server;
}

export interface ErasureMcpServer {
  close(): Promise<void>;
  port: number;
}

export async function startErasureMcpServer(opts: {
  ctx: ToolContext;
  port: number;
  token: string;
  host?: string;
}): Promise<ErasureMcpServer> {
  const { ctx, port, token, host = '127.0.0.1' } = opts;

  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = error instanceof Error ? error.message : 'Internal error';
      sendJson(res, 400, { error: 'bad_request', message });
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Unauthenticated liveness probe; exposes no data.
    if (url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (!isAuthorized(req, token)) {
      res.setHeader('www-authenticate', 'Bearer');
      sendJson(res, 401, { error: 'unauthorized', message: 'Missing or invalid bearer token.' });
      return;
    }

    if (req.method !== 'POST') {
      // Stateless mode has no server-initiated stream to attach to.
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    const body = await readBody(req);
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
