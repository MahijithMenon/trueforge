import type { HarnessEvent, ModelMessageEvent, ToolCall, ToolTier } from './types';

/**
 * Reduces the harness event stream into a timeline the operator can read.
 *
 * The console's job is to answer four questions at a glance: what has the agent
 * already done, what is it doing now, what is it waiting for, and what is it
 * about to do. Everything here exists to serve one of those.
 *
 * Events are folded rather than appended verbatim, so a tool call and its
 * response become one item that changes state, instead of two entries the
 * operator has to mentally join up.
 */

export type SessionStatus = 'idle' | 'running' | 'awaiting_approval' | 'done' | 'error' | 'cancelled';

export interface MessageItem {
  kind: 'message';
  id: string;
  text: string;
  threadId: string;
  at: string;
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  server: string | null;
  tier: ToolTier;
  args: string;
  threadId: string;
  at: string;
  status: 'running' | 'awaiting_approval' | 'done' | 'error' | 'denied';
  response?: string;
}

export interface SandboxItem {
  kind: 'sandbox';
  id: string;
  sandboxId: string;
  at: string;
}

export interface SubagentItem {
  kind: 'subagent';
  id: string;
  threadId: string;
  title: string;
  at: string;
  status: 'running' | 'done' | 'error';
}

export interface NoticeItem {
  kind: 'notice';
  id: string;
  level: 'info' | 'error';
  text: string;
  at: string;
}

export type TimelineItem = MessageItem | ToolItem | SandboxItem | SubagentItem | NoticeItem;

export interface PendingApproval {
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: string;
}

export interface SessionState {
  status: SessionStatus;
  items: TimelineItem[];
  pendingApproval: PendingApproval | null;
  error: string | null;
  /** Tool risk tiers, sourced from the harness's own annotations. */
  tierByTool: Record<string, ToolTier>;
  usage: { totalTokens?: number; costUsd?: number } | null;
}

export const initialSessionState: SessionState = {
  status: 'idle',
  items: [],
  pendingApproval: null,
  error: null,
  tierByTool: {},
  usage: null,
};

export type SessionAction =
  | { type: 'reset' }
  | { type: 'tiers'; tiers: Record<string, ToolTier> }
  | { type: 'started' }
  | { type: 'denied'; toolCallId: string }
  | { type: 'event'; event: HarnessEvent }
  | { type: 'stream_error'; message: string };

function textOf(content: ModelMessageEvent['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part.text ?? '')))
      .join('')
      .trim();
  }
  return '';
}

function toolTier(state: SessionState, call: ToolCall): ToolTier {
  if (call.tool_info?.type === 'truefoundry-system') return 'system';
  const name = call.tool_info?.name ?? call.function?.name ?? '';
  return state.tierByTool[name] ?? 'write';
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'reset':
      return { ...initialSessionState, tierByTool: state.tierByTool };

    case 'tiers':
      return { ...state, tierByTool: action.tiers };

    case 'started':
      return { ...state, status: 'running', error: null };

    case 'stream_error':
      return {
        ...state,
        status: 'error',
        error: action.message,
        items: [
          ...state.items,
          {
            kind: 'notice',
            id: `err-${Date.now()}`,
            level: 'error',
            text: action.message,
            at: new Date().toISOString(),
          },
        ],
      };

    case 'denied':
      return markDenied(state, action.toolCallId);

    case 'event':
      return applyEvent(state, action.event);

    default:
      return state;
  }
}

function applyEvent(state: SessionState, event: HarnessEvent): SessionState {
  const at = event.created_at ?? new Date().toISOString();
  const threadId = (event.thread_id as string | null) ?? 'main';

  switch (event.type) {
    case 'model.message': {
      const message = event as ModelMessageEvent;
      const items = [...state.items];
      const text = textOf(message.content);
      if (text.length > 0) {
        items.push({ kind: 'message', id: message.id, text, threadId, at });
      }
      for (const call of message.tool_calls ?? []) {
        const name = call.tool_info?.name ?? call.function?.name ?? 'unknown';
        items.push({
          kind: 'tool',
          id: call.id,
          name,
          server: call.tool_info?.type === 'mcp' ? call.tool_info.server_name : null,
          tier: toolTier(state, call),
          args: call.function?.arguments ?? '',
          threadId,
          at,
          status: 'running',
        });
      }
      return { ...state, items };
    }

    case 'tool.response': {
      const response = event as Extract<HarnessEvent, { type: 'tool.response' }>;
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === 'tool' && item.id === response.tool_call_id
            ? {
                ...item,
                status: isErrorPayload(response.content) ? 'error' : 'done',
                response: response.content,
              }
            : item,
        ),
      };
    }

    /**
     * The moment the whole product exists for. The harness has stopped the
     * agent mid-turn because a destructive tool was called, and will not
     * proceed without an explicit decision.
     */
    case 'tool.approval_required': {
      const approval = event as Extract<HarnessEvent, { type: 'tool.approval_required' }>;
      const first = approval.tool_calls[0];
      if (!first) return state;
      const matching = state.items.find(
        (item): item is ToolItem => item.kind === 'tool' && item.id === first.id,
      );
      return {
        ...state,
        status: 'awaiting_approval',
        pendingApproval: {
          threadId: approval.thread_id,
          toolCallId: first.id,
          toolName: matching?.name ?? 'unknown tool',
          args: matching?.args ?? '',
        },
        items: state.items.map((item) =>
          item.kind === 'tool' && item.id === first.id ? { ...item, status: 'awaiting_approval' } : item,
        ),
      };
    }

    case 'sandbox.created': {
      const sandbox = event as Extract<HarnessEvent, { type: 'sandbox.created' }>;
      return {
        ...state,
        items: [...state.items, { kind: 'sandbox', id: sandbox.id, sandboxId: sandbox.sandbox_id, at }],
      };
    }

    case 'thread.created': {
      const thread = event as Extract<HarnessEvent, { type: 'thread.created' }>;
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: 'subagent',
            id: thread.id,
            threadId: thread.thread_id,
            title: thread.title,
            at,
            status: 'running',
          },
        ],
      };
    }

    case 'thread.done': {
      const thread = event as Extract<HarnessEvent, { type: 'thread.done' }>;
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === 'subagent' && item.threadId === thread.thread_id
            ? { ...item, status: thread.state?.status === 'error' ? 'error' : 'done' }
            : item,
        ),
      };
    }

    case 'turn.done': {
      const turn = event as Extract<HarnessEvent, { type: 'turn.done' }>;
      const status: SessionStatus =
        turn.state?.status === 'error' ? 'error' : turn.state?.status === 'cancelled' ? 'cancelled' : 'done';
      // A turn can end in error with no message attached. Reporting "error" in
      // the header while the timeline stays empty leaves the operator with no
      // idea what happened, so always say something.
      const failureText =
        turn.state?.status === 'error'
          ? (turn.state.error ??
            'The turn failed and the harness reported no reason. Check the TrueForge logs.')
          : null;

      return {
        ...state,
        status,
        pendingApproval: null,
        error: failureText ?? state.error,
        usage: turn.metrics
          ? { totalTokens: turn.metrics.total_tokens, costUsd: turn.metrics.total_cost_in_usd }
          : state.usage,
        items: failureText
          ? [...state.items, { kind: 'notice', id: `${turn.id}-err`, level: 'error', text: failureText, at }]
          : state.items,
      };
    }

    default:
      return state;
  }
}

/** Tool servers return refusals as JSON with an `error` key. */
function isErrorPayload(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { error?: unknown };
    return typeof parsed.error === 'string';
  } catch {
    return false;
  }
}

/** Marks the pending tool as denied once the operator refuses it. */
export function markDenied(state: SessionState, toolCallId: string): SessionState {
  return {
    ...state,
    pendingApproval: null,
    items: state.items.map((item) =>
      item.kind === 'tool' && item.id === toolCallId ? { ...item, status: 'denied' } : item,
    ),
  };
}
