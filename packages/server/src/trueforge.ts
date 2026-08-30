/**
 * A small typed client for the TrueForge HTTP API.
 *
 * The published `@truefoundry/trueforge-sdk` package is currently a placeholder
 * ("Do not use"), so this talks to the documented REST surface directly. Every
 * shape below was taken from the running server's OpenAPI document at
 * `/api/v1/openapi.json` rather than guessed.
 */

export interface TrueForgeClientOptions {
  baseUrl: string;
  /** Per-request timeout. The harness can stream for a long time, so callers
   *  that stream pass their own signal and skip this. */
  timeoutMs?: number;
}

export class TrueForgeError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'TrueForgeError';
    this.status = status;
    this.body = body;
  }
}

/** Tools exposed to the agent. `@all`, `@read-only`, or literal tool names. */
export type ToolSelector = '@all' | '@read-only' | (string & {});
/** Tools that pause for approval. `@all`, `@write`, `@destructive`, or names. */
export type ApprovalSelector = '@all' | '@write' | '@destructive' | (string & {});

export interface AgentMcpServer {
  name: string;
  enable_tools?: ToolSelector[];
  disable_tools?: ToolSelector[];
  require_approval_for_tools?: ApprovalSelector[];
  preload?: boolean;
}

export interface AgentSpec {
  model: { name: string; params?: Record<string, unknown> };
  instructions?: string;
  mcp_servers?: AgentMcpServer[];
  skills?: { name: string }[];
  config?: {
    iteration_limit?: number;
    sandbox?: { enabled: boolean; file_downloads?: boolean };
    dynamic_sub_agents?: { enabled: boolean };
    context_management?: {
      compaction?: { enabled: boolean };
      large_tool_response?: { enabled: boolean };
    };
    generative_ui?: { enabled: boolean };
    ask_user_questions?: { enabled: boolean };
  };
}

export interface ApprovalDecision {
  status: 'allow' | 'deny';
  reason?: string;
}

export class TrueForgeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: TrueForgeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
      const text = await response.text();
      const body: unknown = text.length > 0 ? safeJson(text) : undefined;
      if (!response.ok) {
        throw new TrueForgeError(
          response.status,
          body,
          `TrueForge ${init.method ?? 'GET'} ${path} failed with ${response.status}: ${text.slice(0, 400)}`,
        );
      }
      return body as T;
    } catch (error) {
      if (error instanceof TrueForgeError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new TrueForgeError(408, undefined, `TrueForge ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new TrueForgeError(
        0,
        undefined,
        `Cannot reach TrueForge at ${this.baseUrl}. Is the harness running? (${(error as Error).message})`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------- settings --

  listModelProviders(): Promise<{ data: { name: string; manifest: { type: string } }[] }> {
    return this.request('/settings/model-providers');
  }

  createModelProvider(name: string, manifest: unknown): Promise<unknown> {
    return this.request('/settings/model-providers', {
      method: 'POST',
      body: JSON.stringify({ name, manifest }),
    });
  }

  updateModelProvider(name: string, manifest: unknown): Promise<unknown> {
    return this.request('/settings/model-providers', {
      method: 'PUT',
      body: JSON.stringify({ name, manifest }),
    });
  }

  listMcpServers(): Promise<{ data: { name: string }[] }> {
    return this.request('/settings/mcp-servers');
  }

  createMcpServer(manifest: unknown): Promise<unknown> {
    return this.request('/settings/mcp-servers', { method: 'POST', body: JSON.stringify({ manifest }) });
  }

  updateMcpServer(manifest: unknown): Promise<unknown> {
    return this.request('/settings/mcp-servers', { method: 'PUT', body: JSON.stringify({ manifest }) });
  }

  /** Tools the harness discovered on a connector, including their annotations. */
  listMcpServerTools(name: string): Promise<unknown> {
    return this.request(`/mcp-servers/${encodeURIComponent(name)}/tools`);
  }

  // --------------------------------------------------------------- agents --

  listAgents(): Promise<{ data: { id: string; name: string }[] }> {
    return this.request('/agents');
  }

  createAgent(name: string, manifest: AgentSpec): Promise<{ data: { id: string; name: string } }> {
    return this.request('/agents', { method: 'POST', body: JSON.stringify({ name, manifest }) });
  }

  updateAgent(agentId: string, manifest: AgentSpec): Promise<unknown> {
    return this.request(`/agents/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: JSON.stringify({ manifest }),
    });
  }

  // ------------------------------------------------------------- sessions --

  createSession(agentName: string): Promise<{ data: { id: string } }> {
    return this.request('/sessions', {
      method: 'POST',
      body: JSON.stringify({ agent: { name: agentName } }),
    });
  }

  getSession(sessionId: string): Promise<unknown> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  /** Replays every event recorded on a session. This is what makes a reload or
   *  a reconnect lossless: the console rebuilds its whole timeline from here. */
  listSessionEvents(sessionId: string): Promise<{ data: unknown[] }> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/events`);
  }

  cancelSession(sessionId: string): Promise<unknown> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' });
  }

  /**
   * Starts a turn and returns the raw streaming response so the caller can pipe
   * server-sent events straight through to the browser.
   */
  streamTurn(sessionId: string, input: unknown[], signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ input, stream: true }),
      ...(signal ? { signal } : {}),
    });
  }

  /** Resumes a turn that is paused on `tool.approval_required`. */
  submitApproval(
    sessionId: string,
    threadId: string,
    toolCallId: string,
    approval: ApprovalDecision,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.streamTurn(
      sessionId,
      [{ type: 'user.tool_approval', thread_id: threadId, tool_call_id: toolCallId, approval }],
      signal,
    );
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
