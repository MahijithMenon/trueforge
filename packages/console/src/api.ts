import type { AuditResponse, Estate, HarnessEvent, ToolTier } from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(response.status, `${path} failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

export const fetchEstate = () => getJson<Estate>('/api/estate');
export const fetchAudit = () => getJson<AuditResponse>('/api/audit');
export const fetchHealth = () =>
  getJson<{ status: string; checks: Record<string, string> }>('/api/health');
export const fetchTools = () =>
  getJson<{ server: string; tools: { name: string; description: string; tier: ToolTier }[] }>('/api/tools');

export async function createSession(): Promise<string> {
  const response = await fetch('/api/sessions', { method: 'POST' });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(response.status, `Could not start a session: ${text.slice(0, 300)}`);
  }
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

/**
 * Parses a server-sent-event stream into harness events.
 *
 * Written as an async generator so the caller drives consumption and can stop
 * cleanly. It tolerates unknown event types and malformed frames rather than
 * throwing: a single unparseable frame must not tear down a live erasure.
 */
async function* parseSse(response: Response, signal?: AbortSignal): AsyncGenerator<HarnessEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; tolerate CRLF.
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
        const event = frameToEvent(frame);
        if (event) yield event;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    const trailing = frameToEvent(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function frameToEvent(frame: string): HarnessEvent | null {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n');
  if (payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as HarnessEvent;
  } catch {
    return null;
  }
}

async function streamPost(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<AsyncGenerator<HarnessEvent>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(response.status, `${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return parseSse(response, signal);
}

export function sendMessage(sessionId: string, message: string, signal?: AbortSignal) {
  return streamPost(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, { message }, signal);
}

/**
 * Sends the operator's decision on a paused tool call and resumes the stream.
 *
 * The console never runs the tool itself; it tells the harness what the human
 * decided and keeps rendering whatever the harness does next.
 */
export function sendApproval(
  sessionId: string,
  input: { threadId: string; toolCallId: string; decision: 'allow' | 'deny'; reason?: string },
  signal?: AbortSignal,
) {
  return streamPost(`/api/sessions/${encodeURIComponent(sessionId)}/approvals`, input, signal);
}

/** Replays a session's recorded events, so a page reload loses nothing. */
export async function replaySession(sessionId: string): Promise<HarnessEvent[]> {
  const body = await getJson<{ data: HarnessEvent[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/events`,
  );
  return body.data ?? [];
}
