import { serve } from '@hono/node-server';
import { createPool } from '../../shared/src/postgres.ts';
import { createApp } from './app.ts';
import { allowedOrigins, loadServerConfig } from './config.ts';
import { TrueForgeClient } from './trueforge.ts';

async function main(): Promise<void> {
  const config = loadServerConfig();

  const pool = createPool({ connectionString: config.DATABASE_URL });
  await pool.query('SELECT 1');

  const trueForge = new TrueForgeClient({ baseUrl: config.TRUEFORGE_BASE_URL });
  const app = createApp({ pool, trueForge, corsOrigins: allowedOrigins(config) });

  const server = serve({ fetch: app.fetch, port: config.SERVER_PORT, hostname: '127.0.0.1' }, (info) => {
    process.stdout.write(`tombstone control plane on http://127.0.0.1:${info.port}\n`);
    process.stdout.write(`  harness: ${config.TRUEFORGE_BASE_URL}\n`);
  });

  const shutdown = () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`control plane failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
