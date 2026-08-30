import { z } from 'zod';

/**
 * All configuration is environment-driven so the same build runs locally,
 * in CI and in a container. Parsing happens once, at startup, and fails loudly:
 * a misconfigured service that deletes data is far worse than one that refuses
 * to boot.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  OBJECT_STORE_ROOT: z.string().min(1).default('./data/objects'),
  ERASURE_MCP_PORT: z.coerce.number().int().positive().default(8811),
  /** Shared bearer token. The MCP server binds to localhost, but an
   *  unauthenticated tool that deletes data is not something to ship. */
  ERASURE_MCP_TOKEN: z.string().min(8),
  /** Hard ceiling on rows a single plan may destroy. Defence against a
   *  runaway or manipulated plan; exceeding it aborts execution. */
  ERASURE_MAX_ROWS: z.coerce.number().int().positive().default(10_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid erasure-mcp configuration:\n${issues}`);
  }
  return parsed.data;
}
