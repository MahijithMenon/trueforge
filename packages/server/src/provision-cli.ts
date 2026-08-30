import { loadServerConfig } from './config.ts';
import { provision } from './provision.ts';

async function main(): Promise<void> {
  const config = loadServerConfig();
  process.stdout.write('Provisioning TrueForge for Tombstone...\n');

  const result = await provision({
    trueForgeBaseUrl: config.TRUEFORGE_BASE_URL,
    openaiApiKey: config.OPENAI_API_KEY,
    anthropicApiKey: config.ANTHROPIC_API_KEY,
    modelProvider: config.TOMBSTONE_MODEL_PROVIDER,
    modelName: config.TOMBSTONE_MODEL_NAME,
    erasureMcpUrl: config.ERASURE_MCP_PUBLIC_URL,
    erasureMcpToken: config.ERASURE_MCP_TOKEN,
    log: (message) => process.stdout.write(`${message}\n`),
  });

  process.stdout.write(
    `\nReady. Agent "${result.agentName}" is bound to ${result.model} ` +
      `with connector "${result.mcpServer}".\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`\nProvisioning failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
