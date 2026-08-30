import { describe, expect, it } from 'vitest';
import {
  initialSessionState,
  sessionReducer,
  type SessionState,
  type ToolItem,
} from '../src/session';
import type { HarnessEvent } from '../src/types';

/**
 * The console's reducer decides what the operator sees at the moment of an
 * irreversible action. A bug here does not corrupt data, but it can show the
 * wrong thing to the person deciding whether to destroy it — so the approval
 * transitions are tested directly rather than only through the browser.
 */

const TIERS = {
  find_data_subject: 'read-only',
  prepare_erasure_plan: 'write',
  execute_erasure: 'destructive',
} as const;

function base(): SessionState {
  return sessionReducer(initialSessionState, { type: 'tiers', tiers: { ...TIERS } });
}

function apply(state: SessionState, ...events: HarnessEvent[]): SessionState {
  return events.reduce((acc, event) => sessionReducer(acc, { type: 'event', event }), state);
}

let seq = 0;
const nextId = () => `evt_${++seq}`;

function modelMessage(
  toolName: string,
  toolCallId: string,
  args: string,
  text = '',
): HarnessEvent {
  return {
    type: 'model.message',
    id: nextId(),
    created_at: new Date().toISOString(),
    thread_id: 'main',
    content: text,
    tool_calls: [
      {
        id: toolCallId,
        function: { name: toolName, arguments: args },
        tool_info: { type: 'mcp', server_id: 's1', server_name: 'tombstone-erasure', name: toolName },
      },
    ],
  } as HarnessEvent;
}

const toolsOf = (state: SessionState) => state.items.filter((i): i is ToolItem => i.kind === 'tool');

describe('tool tiers', () => {
  it('badges each tool with the tier the harness reported', () => {
    const state = apply(
      base(),
      modelMessage('find_data_subject', 'c1', '{}'),
      modelMessage('execute_erasure', 'c2', '{}'),
    );
    const tools = toolsOf(state);
    expect(tools[0]!.tier).toBe('read-only');
    expect(tools[1]!.tier).toBe('destructive');
  });

  it('treats an unknown tool as write rather than assuming it is safe', () => {
    const state = apply(base(), modelMessage('some_new_tool', 'c1', '{}'));
    expect(toolsOf(state)[0]!.tier).toBe('write');
  });

  it('labels harness system tools distinctly from connector tools', () => {
    const event = {
      type: 'model.message',
      id: nextId(),
      created_at: new Date().toISOString(),
      thread_id: 'main',
      content: '',
      tool_calls: [
        { id: 'c9', function: { name: 'run_code', arguments: '{}' }, tool_info: { type: 'truefoundry-system', name: 'run_code' } },
      ],
    } as HarnessEvent;
    expect(toolsOf(apply(base(), event))[0]!.tier).toBe('system');
  });
});

describe('approval gate', () => {
  const planArgs = '{"plan_id":"plan_abc"}';

  function pausedAtApproval(): SessionState {
    return apply(
      base(),
      modelMessage('execute_erasure', 'call_1', planArgs),
      {
        type: 'tool.approval_required',
        id: nextId(),
        created_at: new Date().toISOString(),
        thread_id: 'main',
        tool_calls: [{ id: 'call_1', source_event_id: 'evt_1' }],
      } as HarnessEvent,
    );
  }

  it('moves the session into awaiting_approval and captures the pending call', () => {
    const state = pausedAtApproval();
    expect(state.status).toBe('awaiting_approval');
    expect(state.pendingApproval).toEqual({
      threadId: 'main',
      toolCallId: 'call_1',
      toolName: 'execute_erasure',
      args: planArgs,
    });
  });

  it('carries the arguments through, so the gate can resolve the plan', () => {
    expect(pausedAtApproval().pendingApproval?.args).toBe(planArgs);
  });

  it('marks the tool itself as awaiting approval', () => {
    expect(toolsOf(pausedAtApproval())[0]!.status).toBe('awaiting_approval');
  });

  it('records a denial and clears the pending state', () => {
    const denied = sessionReducer(pausedAtApproval(), { type: 'denied', toolCallId: 'call_1' });
    expect(denied.pendingApproval).toBeNull();
    expect(toolsOf(denied)[0]!.status).toBe('denied');
  });

  it('clears the pending approval once the turn completes', () => {
    const done = apply(pausedAtApproval(), {
      type: 'turn.done',
      id: nextId(),
      created_at: new Date().toISOString(),
      thread_id: null,
      state: { status: 'done' },
    } as HarnessEvent);
    expect(done.pendingApproval).toBeNull();
    expect(done.status).toBe('done');
  });

  it('ignores an approval event naming no tool calls', () => {
    const state = apply(base(), {
      type: 'tool.approval_required',
      id: nextId(),
      created_at: new Date().toISOString(),
      thread_id: 'main',
      tool_calls: [],
    } as HarnessEvent);
    expect(state.status).not.toBe('awaiting_approval');
    expect(state.pendingApproval).toBeNull();
  });

  it('still pauses when the originating call was never seen, naming the tool as unknown', () => {
    // Defensive: a reconnect could deliver the approval before the message.
    const state = apply(base(), {
      type: 'tool.approval_required',
      id: nextId(),
      created_at: new Date().toISOString(),
      thread_id: 'main',
      tool_calls: [{ id: 'orphan', source_event_id: 'x' }],
    } as HarnessEvent);
    expect(state.status).toBe('awaiting_approval');
    expect(state.pendingApproval?.toolName).toBe('unknown tool');
  });
});

describe('tool responses', () => {
  it('folds a response into the originating call rather than adding a row', () => {
    const state = apply(
      base(),
      modelMessage('find_data_subject', 'c1', '{}'),
      {
        type: 'tool.response',
        id: nextId(),
        created_at: new Date().toISOString(),
        thread_id: 'main',
        tool_call_id: 'c1',
        content: '{"found":true}',
      } as HarnessEvent,
    );
    expect(toolsOf(state)).toHaveLength(1);
    expect(toolsOf(state)[0]!.status).toBe('done');
  });

  it('marks a refusal payload as an error so it is visibly not a success', () => {
    const state = apply(
      base(),
      modelMessage('prepare_erasure_plan', 'c1', '{}'),
      {
        type: 'tool.response',
        id: nextId(),
        created_at: new Date().toISOString(),
        thread_id: 'main',
        tool_call_id: 'c1',
        content: '{"error":"legal_hold_active","message":"refused"}',
      } as HarnessEvent,
    );
    expect(toolsOf(state)[0]!.status).toBe('error');
  });

  it('does not mistake ordinary output containing the word error for a failure', () => {
    const state = apply(
      base(),
      modelMessage('find_data_subject', 'c1', '{}'),
      {
        type: 'tool.response',
        id: nextId(),
        created_at: new Date().toISOString(),
        thread_id: 'main',
        tool_call_id: 'c1',
        content: '{"found":true,"note":"no error occurred"}',
      } as HarnessEvent,
    );
    expect(toolsOf(state)[0]!.status).toBe('done');
  });
});

describe('failures are always explained', () => {
  it('reports a turn error the harness described', () => {
    const state = apply(base(), {
      type: 'turn.done',
      id: nextId(),
      created_at: new Date().toISOString(),
      thread_id: null,
      state: { status: 'error', error: 'model provider rejected the request' },
    } as HarnessEvent);
    expect(state.status).toBe('error');
    expect(state.error).toBe('model provider rejected the request');
    expect(state.items.some((i) => i.kind === 'notice')).toBe(true);
  });

  it('still says something when the harness attaches no reason', () => {
    // Regression: this previously left a red header over an empty timeline.
    const state = apply(base(), {
      type: 'turn.done',
      id: nextId(),
      created_at: new Date().toISOString(),
      thread_id: null,
      state: { status: 'error' },
    } as HarnessEvent);
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/reported no reason/i);
    expect(state.items.some((i) => i.kind === 'notice')).toBe(true);
  });

  it('surfaces a transport failure as a notice', () => {
    const state = sessionReducer(base(), { type: 'stream_error', message: 'connection lost' });
    expect(state.status).toBe('error');
    expect(state.items.some((i) => i.kind === 'notice' && i.text === 'connection lost')).toBe(true);
  });
});

describe('sandbox and subagents', () => {
  it('shows the sandbox being provisioned', () => {
    const state = apply(base(), {
      type: 'sandbox.created',
      id: nextId(),
      created_at: new Date().toISOString(),
      thread_id: null,
      sandbox_id: 'sbx_1',
    } as HarnessEvent);
    expect(state.items.some((i) => i.kind === 'sandbox')).toBe(true);
  });

  it('tracks a subagent from creation to completion', () => {
    const created = apply(base(), {
      type: 'thread.created',
      id: nextId(),
      created_at: new Date().toISOString(),
      thread_id: 'sub_1',
      title: 'Scan object storage',
      parent: { thread_id: 'main', tool_call_id: 'c1' },
    } as HarnessEvent);
    const sub = created.items.find((i) => i.kind === 'subagent');
    expect(sub).toBeDefined();

    const finished = apply(created, {
      type: 'thread.done',
      id: nextId(),
      created_at: new Date().toISOString(),
      thread_id: 'sub_1',
      state: { status: 'done' },
    } as HarnessEvent);
    const done = finished.items.find((i) => i.kind === 'subagent');
    expect(done && done.kind === 'subagent' && done.status).toBe('done');
  });
});

describe('reset', () => {
  it('clears the case but keeps the tool tiers, which are session-independent', () => {
    const dirty = apply(base(), modelMessage('execute_erasure', 'c1', '{}'));
    const reset = sessionReducer(dirty, { type: 'reset' });
    expect(reset.items).toHaveLength(0);
    expect(reset.pendingApproval).toBeNull();
    expect(reset.tierByTool.execute_erasure).toBe('destructive');
  });
});

describe('unknown events', () => {
  it('ignores an event type it does not model instead of throwing', () => {
    const before = base();
    const after = apply(before, {
      type: 'some.future.event',
      id: nextId(),
      created_at: new Date().toISOString(),
    } as HarnessEvent);
    expect(after.items).toEqual(before.items);
  });
});
