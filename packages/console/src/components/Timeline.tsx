import { useState } from 'react';
import type { TimelineItem, ToolItem } from '../session';

/**
 * The agent's activity, folded into one readable stream.
 *
 * Tool calls collapse by default and expand to show arguments and the raw
 * response, so the operator can audit any step without drowning in JSON. The
 * risk badge on each call comes from the harness's own tool annotations.
 */

const TIER_LABEL: Record<string, string> = {
  'read-only': 'read',
  write: 'write',
  destructive: 'destructive',
  system: 'system',
};

const TIER_CLASS: Record<string, string> = {
  'read-only': 'read',
  write: 'write',
  destructive: 'destructive',
  system: 'system',
};

function prettyJson(raw: string): string {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const statusLabel =
    item.status === 'awaiting_approval'
      ? 'awaiting approval'
      : item.status === 'denied'
        ? 'denied by operator'
        : item.status;

  return (
    <div className="item">
      <div
        className="tool-head"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        aria-expanded={open}
      >
        <span className="icon">{open ? '▾' : '▸'}</span>
        <span className={`badge ${TIER_CLASS[item.tier] ?? 'write'}`}>
          {TIER_LABEL[item.tier] ?? item.tier}
        </span>
        <span className="tool-name">{item.name}</span>
        {item.server && <span className="tool-server">{item.server}</span>}
        <span className="spacer" />
        <span className={`status ${item.status}`}>
          {item.status === 'running' && <span className="spinner" />}
          {statusLabel}
        </span>
      </div>
      {open && (
        <div className="tool-body">
          <h5>Arguments</h5>
          <pre className="payload">{prettyJson(item.args) || '(none)'}</pre>
          {item.response !== undefined && (
            <>
              <h5>Response</h5>
              <pre className="payload">{prettyJson(item.response)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Timeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) {
    return (
      <div className="empty">
        No activity yet.
        <br />
        Send an erasure request to begin.
      </div>
    );
  }

  return (
    <div className="timeline">
      {items.map((item) => {
        switch (item.kind) {
          case 'tool':
            return <ToolRow key={item.id} item={item} />;
          case 'message':
            return (
              <div className="item message" key={item.id}>
                {item.threadId !== 'main' && <div className="thread">subagent · {item.threadId}</div>}
                {item.text}
              </div>
            );
          case 'sandbox':
            return (
              <div className="item sandbox" key={item.id}>
                <span className="icon">[ ]</span>
                Sandbox provisioned for code execution
                <span className="spacer" />
                <span className="tool-server">{item.sandboxId}</span>
              </div>
            );
          case 'subagent':
            return (
              <div className="item subagent" key={item.id}>
                <span className="icon">{'>>'}</span>
                Subagent: {item.title}
                <span className="spacer" />
                <span className={`status ${item.status}`}>
                  {item.status === 'running' && <span className="spinner" />}
                  {item.status}
                </span>
              </div>
            );
          case 'notice':
            return (
              <div className={`item notice ${item.level}`} key={item.id}>
                <span className="icon">!</span>
                {item.text}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
