import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { ObjectStore } from './objectstore.ts';
import { startErasureMcpServer } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = createPool({ connectionString: config.DATABASE_URL });
  // Fail fast: a tool server that cannot reach its database should not report ready.
  await pool.query('SELECT 1');

  const objects = new ObjectStore(config.OBJECT_STORE_ROOT);
  await objects.init();

  const server = await startErasureMcpServer({
    ctx: { pool, objects, maxRows: config.ERASURE_MAX_ROWS },
    port: config.ERASURE_MCP_PORT,
    token: config.ERASURE_MCP_TOKEN,
  });

  process.stdout.write(`erasure-mcp listening on http://127.0.0.1:${server.port}/mcp\n`);

  const shutdown = (signal: string) => {
    process.stdout.write(`\nreceived ${signal}, shutting down\n`);
    void (async () => {
      await server.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(`erasure-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
