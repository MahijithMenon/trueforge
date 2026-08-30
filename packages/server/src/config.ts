import { z } from 'zod';

const schema = z.object({
  TRUEFORGE_BASE_URL: z.string().url().default('http://localhost:8790'),
  SERVER_PORT: z.coerce.number().int().positive().default(8800),
  DATABASE_URL: z.string().min(1),
  ERASURE_MCP_PUBLIC_URL: z.string().url().default('http://localhost:8811/mcp'),
  ERASURE_MCP_TOKEN: z.string().min(8),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  TOMBSTONE_MODEL_PROVIDER: z.enum(['openai', 'anthropic']).default('anthropic'),
  TOMBSTONE_MODEL_NAME: z.string().min(1).default('claude-sonnet-5'),
  /** Comma-separated origins allowed to call the control plane. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
});

export type ServerConfig = z.infer<typeof schema>;

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid server configuration:\n${issues}`);
  }
  return parsed.data;
}

export function allowedOrigins(config: ServerConfig): string[] {
  return config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}
