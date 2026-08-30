import { AGENT_NAME, MCP_SERVER_NAME, buildAgentSpec } from './agent-spec.ts';
import { TrueForgeClient, TrueForgeError } from './trueforge.ts';

/**
 * Provisioning: turns an empty TrueForge instance into one that can run
 * Tombstone.
 *
 * This exists so the project is reproducible from a clone. The alternative is
 * a README that says "now click through six settings screens", which is both
 * tedious and impossible to verify. Every step is idempotent: running it twice
 * updates in place rather than failing or duplicating.
 */

export interface ProvisionOptions {
  trueForgeBaseUrl: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  /** Provider to bind the agent to. Must have a key supplied. */
  modelProvider: 'openai' | 'anthropic';
  modelName: string;
  erasureMcpUrl: string;
  erasureMcpToken: string;
  log?: (message: string) => void;
}

export interface ProvisionResult {
  providersConfigured: string[];
  mcpServer: string;
  agentName: string;
  model: string;
}

/** Catalog entries, so registered models carry correct context/window metadata. */
interface CatalogProvider {
  type: string;
  models: { model_id: string; name: string; properties: Record<string, unknown> }[];
}

export async function provision(options: ProvisionOptions): Promise<ProvisionResult> {
  const log = options.log ?? (() => undefined);
  const client = new TrueForgeClient({ baseUrl: options.trueForgeBaseUrl });

  const catalogResponse = await fetchCatalog(options.trueForgeBaseUrl);

  const keys: { type: 'openai' | 'anthropic'; apiKey: string | undefined }[] = [
    { type: 'openai', apiKey: options.openaiApiKey },
    { type: 'anthropic', apiKey: options.anthropicApiKey },
  ];

  const existingProviders = new Set(
    (await client.listModelProviders().catch(() => ({ data: [] }))).data.map((p) => p.name),
  );

  const providersConfigured: string[] = [];
  for (const { type, apiKey } of keys) {
    if (!apiKey) {
      log(`  - ${type}: no API key supplied, skipping`);
      continue;
    }
    const catalogEntry = catalogResponse.find((p) => p.type === type);
    if (!catalogEntry) {
      log(`  - ${type}: not present in this TrueForge build's catalog, skipping`);
      continue;
    }
    const manifest = {
      type,
      auth: { api_key: apiKey },
      models: catalogEntry.models.map((m) => ({
        model_id: m.model_id,
        name: m.name,
        properties: m.properties,
      })),
    };
    if (existingProviders.has(type)) {
      await client.updateModelProvider(type, manifest);
      log(`  - ${type}: updated (${catalogEntry.models.length} models)`);
    } else {
      await client.createModelProvider(type, manifest);
      log(`  - ${type}: created (${catalogEntry.models.length} models)`);
    }
    providersConfigured.push(type);
  }

  if (providersConfigured.length === 0) {
    throw new Error(
      'No model provider could be configured. Set OPENAI_API_KEY and/or ANTHROPIC_API_KEY in .env.',
    );
  }
  if (!providersConfigured.includes(options.modelProvider)) {
    throw new Error(
      `TOMBSTONE_MODEL_PROVIDER is "${options.modelProvider}" but no API key was supplied for it. ` +
        `Configured providers: ${providersConfigured.join(', ')}.`,
    );
  }

  // ---- connector -----------------------------------------------------------
  const mcpManifest = {
    type: 'remote' as const,
    name: MCP_SERVER_NAME,
    url: options.erasureMcpUrl,
    description:
      'Erasure tools for GDPR Article 17 requests against the company estate: scan a data subject, ' +
      'derive a policy-driven erasure plan, execute it irreversibly, and verify the outcome.',
    auth: { type: 'header' as const, headers: { Authorization: `Bearer ${options.erasureMcpToken}` } },
  };

  const existingMcp = (await client.listMcpServers().catch(() => ({ data: [] }))).data.map((s) => s.name);
  if (existingMcp.includes(MCP_SERVER_NAME)) {
    await client.updateMcpServer(mcpManifest);
    log(`  - connector "${MCP_SERVER_NAME}": updated -> ${options.erasureMcpUrl}`);
  } else {
    await client.createMcpServer(mcpManifest);
    log(`  - connector "${MCP_SERVER_NAME}": created -> ${options.erasureMcpUrl}`);
  }

  // Confirm the harness can actually reach the tool server and read its
  // annotations. Failing here now beats failing mid-demo.
  const model = `${options.modelProvider}/${options.modelName}`;
  try {
    const tools = (await client.listMcpServerTools(MCP_SERVER_NAME)) as {
      data?: { name: string; annotations?: Record<string, unknown> }[];
    };
    const list = tools.data ?? [];
    const destructive = list.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name);
    log(`  - connector handshake ok: ${list.length} tools discovered`);
    log(`  - approval-gated (@destructive): ${destructive.join(', ') || 'none'}`);
    if (destructive.length === 0) {
      log('  ! WARNING: no destructive tool found; the approval gate will never fire.');
    }
  } catch (error) {
    const message = error instanceof TrueForgeError ? error.message : String(error);
    log(`  ! could not list connector tools: ${message}`);
    log('    Is the erasure MCP server running (npm run dev:mcp)?');
  }

  // ---- agent ---------------------------------------------------------------
  const spec = buildAgentSpec({ model });
  const agents = (await client.listAgents().catch(() => ({ data: [] }))).data;
  const existingAgent = agents.find((a) => a.name === AGENT_NAME);
  if (existingAgent) {
    await client.updateAgent(existingAgent.id, spec);
    log(`  - agent "${AGENT_NAME}": updated (model ${model})`);
  } else {
    await client.createAgent(AGENT_NAME, spec);
    log(`  - agent "${AGENT_NAME}": created (model ${model})`);
  }

  return { providersConfigured, mcpServer: MCP_SERVER_NAME, agentName: AGENT_NAME, model };
}

async function fetchCatalog(baseUrl: string): Promise<CatalogProvider[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/catalogs/model-providers`);
  if (!response.ok) {
    throw new Error(
      `Could not read the TrueForge model catalog (${response.status}). Is the harness running at ${baseUrl}?`,
    );
  }
  const body = (await response.json()) as { data?: CatalogProvider[] } | CatalogProvider[];
  return Array.isArray(body) ? body : (body.data ?? []);
}
