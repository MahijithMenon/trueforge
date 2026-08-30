/**
 * Event shapes streamed by the TrueForge harness.
 *
 * Transcribed from the harness's own OpenAPI document
 * (`/api/v1/openapi.json`, schema `TurnStreamingEvent`) so the console reacts
 * to what the harness actually emits. Only the fields the console renders are
 * modelled; unknown events are kept and shown as raw, never dropped silently.
 */

export interface McpToolInfo {
  type: 'mcp';
  server_id: string;
  server_name: string;
  name: string;
}

export interface SystemToolInfo {
  type: 'truefoundry-system';
  name: string;
}

export type ToolInfo = McpToolInfo | SystemToolInfo;

export interface ToolCall {
  id: string;
  type?: string;
  function?: { name: string; arguments: string };
  tool_info: ToolInfo;
}

interface BaseEvent {
  id: string;
  created_at: string;
  thread_id?: string | null;
}

export interface ModelMessageEvent extends BaseEvent {
  type: 'model.message';
  content: string | { type: string; text?: string }[] | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  finish_reason?: string | null;
}

export interface ModelMessageDeltaEvent extends BaseEvent {
  type: 'model.message.delta';
  content?: string | null;
  reasoning_content?: string;
}

export interface ToolResponseEvent extends BaseEvent {
  type: 'tool.response';
  tool_call_id: string;
  content: string;
}

export interface ToolApprovalRequiredEvent extends BaseEvent {
  type: 'tool.approval_required';
  thread_id: string;
  tool_calls: { id: string; source_event_id: string }[];
}

export interface ThreadCreatedEvent extends BaseEvent {
  type: 'thread.created';
  thread_id: string;
  title: string;
  parent: { thread_id: string; tool_call_id: string };
}

export interface ThreadDoneEvent extends BaseEvent {
  type: 'thread.done';
  thread_id: string;
  state?: { status: string; error?: string };
}

export interface SandboxCreatedEvent extends BaseEvent {
  type: 'sandbox.created';
  sandbox_id: string;
}

export interface TurnCreatedEvent extends BaseEvent {
  type: 'turn.created';
  turn_id?: string;
}

export interface TurnDoneEvent extends BaseEvent {
  type: 'turn.done';
  state: { status: 'done' | 'cancelled' | 'error'; error?: string };
  metrics?: {
    total_tokens?: number;
    total_cost_in_usd?: number;
  };
}

export interface McpInitializeEvent extends BaseEvent {
  type: 'mcp.initialize';
  server_name?: string;
}

export interface UnknownEvent extends BaseEvent {
  type: string;
  [key: string]: unknown;
}

export type HarnessEvent =
  | ModelMessageEvent
  | ModelMessageDeltaEvent
  | ToolResponseEvent
  | ToolApprovalRequiredEvent
  | ThreadCreatedEvent
  | ThreadDoneEvent
  | SandboxCreatedEvent
  | TurnCreatedEvent
  | TurnDoneEvent
  | McpInitializeEvent
  | UnknownEvent;

// ------------------------------------------------------------ control plane --

export interface EstateCustomer {
  id: number;
  email: string;
  fullName: string;
  phone: string | null;
  address: string | null;
  erased: boolean;
  onLegalHold: boolean;
  counts: {
    supportTickets: number;
    sessions: number;
    marketingEvents: number;
    attachments: number;
    invoices: number;
    invoicesRedacted: number;
  };
}

export interface Estate {
  customers: EstateCustomer[];
  capturedAt: string;
}

export interface AuditEntry {
  seq: number;
  caseId: string | null;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
  createdAt: string;
}

export interface ChainVerification {
  valid: boolean;
  entries: number;
  brokenAtSeq: number | null;
  headHash: string;
}

export interface AuditResponse {
  entries: AuditEntry[];
  verification: ChainVerification;
}

/** Risk tier a tool falls into, mirroring TrueForge's approval selectors. */
export type ToolTier = 'read-only' | 'write' | 'destructive' | 'system';

/** An erasure plan as stored in the audit trail's `plan.prepared` entry. */
export interface ErasurePlanAction {
  system: string;
  table: string;
  disposition: 'delete' | 'redact' | 'retain';
  estimatedRows: number;
  redactColumns: string[];
  basis: string;
}

export interface ErasurePlan {
  caseId: string;
  customerId: number;
  subjectEmail: string;
  actions: ErasurePlanAction[];
  objectKeys: string[];
  estimatedRowsAffected: number;
  estimatedObjectsDeleted: number;
}
