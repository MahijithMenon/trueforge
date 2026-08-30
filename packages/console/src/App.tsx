import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  ApiError,
  createSession,
  fetchAudit,
  fetchEstate,
  fetchHealth,
  fetchTools,
  replaySession,
  sendApproval,
  sendMessage,
} from './api';
import { ApprovalGate } from './components/ApprovalGate';
import { AuditPanel } from './components/AuditPanel';
import { EstatePanel } from './components/EstatePanel';
import { Timeline } from './components/Timeline';
import { initialSessionState, sessionReducer } from './session';
import type { AuditResponse, Estate, HarnessEvent, ToolTier } from './types';

const SESSION_KEY = 'tombstone.sessionId';

/** Prepared requests keep rehearsal deterministic and show both outcomes. */
const SCENARIOS = [
  {
    label: 'Erasure request — Priya Raman',
    text:
      'We have received a GDPR Article 17 erasure request from priya.raman@example.com, ' +
      'submitted through the privacy portal and identity-verified. Please handle it end to end.',
  },
  {
    label: 'Erasure request — Daniel Okafor (under legal hold)',
    text:
      'Please process an Article 17 erasure request for daniel.okafor@example.com, ' +
      'received through the privacy portal.',
  },
];

export default function App() {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [estate, setEstate] = useState<Estate | null>(null);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [health, setHealth] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState(SCENARIOS[0]?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const refreshGroundTruth = useCallback(async () => {
    const [nextEstate, nextAudit] = await Promise.allSettled([fetchEstate(), fetchAudit()]);
    if (nextEstate.status === 'fulfilled') setEstate(nextEstate.value);
    if (nextAudit.status === 'fulfilled') setAudit(nextAudit.value);
  }, []);

  // Initial load: health, tool tiers, and ground truth.
  useEffect(() => {
    void (async () => {
      const [healthResult, toolsResult] = await Promise.allSettled([fetchHealth(), fetchTools()]);
      if (healthResult.status === 'fulfilled') setHealth(healthResult.value.checks);
      else setHealth({ 'control plane': 'unreachable' });

      if (toolsResult.status === 'fulfilled') {
        const tiers: Record<string, ToolTier> = {};
        for (const tool of toolsResult.value.tools) tiers[tool.name] = tool.tier;
        dispatch({ type: 'tiers', tiers });
      }
      await refreshGroundTruth();
    })();
  }, [refreshGroundTruth]);

  /**
   * Restores a previous session on reload.
   *
   * TrueForge keeps session state server-side, so the console can rebuild its
   * entire timeline from the recorded events. Closing the tab mid-erasure does
   * not lose the case.
   */
  useEffect(() => {
    const stored = window.localStorage.getItem(SESSION_KEY);
    if (!stored) return;
    setSessionId(stored);
    void (async () => {
      try {
        const events = await replaySession(stored);
        for (const event of events) dispatch({ type: 'event', event });
        if (events.length > 0) setBanner('Restored the previous session from the harness.');
      } catch {
        window.localStorage.removeItem(SESSION_KEY);
        setSessionId(null);
      }
    })();
  }, []);

  // Keep the newest activity in view.
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.items.length, state.pendingApproval]);

  const consume = useCallback(
    async (stream: AsyncGenerator<HarnessEvent>) => {
      try {
        for await (const event of stream) dispatch({ type: 'event', event });
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        dispatch({ type: 'stream_error', message: (error as Error).message });
      } finally {
        await refreshGroundTruth();
      }
    },
    [refreshGroundTruth],
  );

  const startRun = useCallback(async () => {
    if (draft.trim().length === 0 || busy) return;
    setBusy(true);
    setBanner(null);
    try {
      let id = sessionId;
      if (!id) {
        id = await createSession();
        window.localStorage.setItem(SESSION_KEY, id);
        setSessionId(id);
      }
      dispatch({ type: 'started' });
      const controller = new AbortController();
      abortRef.current = controller;
      await consume(await sendMessage(id, draft, controller.signal));
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 502
          ? 'The TrueForge harness is not reachable. Start it with `npm run harness`, then run `npm run provision`.'
          : (error as Error).message;
      dispatch({ type: 'stream_error', message });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, consume, draft, sessionId]);

  const decide = useCallback(
    async (decision: 'allow' | 'deny', reason?: string) => {
      const pending = state.pendingApproval;
      if (!pending || !sessionId || busy) return;
      setBusy(true);
      try {
        if (decision === 'deny') {
          // Reflect the refusal immediately; the harness confirms it in-stream.
          dispatch({ type: 'denied', toolCallId: pending.toolCallId });
        }
        const controller = new AbortController();
        abortRef.current = controller;
        await consume(
          await sendApproval(
            sessionId,
            {
              threadId: pending.threadId,
              toolCallId: pending.toolCallId,
              decision,
              ...(reason ? { reason } : {}),
            },
            controller.signal,
          ),
        );
      } catch (error) {
        dispatch({ type: 'stream_error', message: (error as Error).message });
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, consume, sessionId, state.pendingApproval],
  );

  const newCase = useCallback(() => {
    abortRef.current?.abort();
    window.localStorage.removeItem(SESSION_KEY);
    setSessionId(null);
    dispatch({ type: 'reset' });
    setBanner(null);
    void refreshGroundTruth();
  }, [refreshGroundTruth]);

  const statusLabel =
    state.status === 'awaiting_approval'
      ? 'paused — awaiting approval'
      : state.status === 'running'
        ? 'running'
        : state.status;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Tombstone</h1>
          <span className="sub">right-to-erasure console</span>
        </div>
        <span className="spacer" />
        <div className="health">
          <div className="health-item">
            <span className={`dot ${state.status === 'running' ? 'ok' : ''}`} />
            {statusLabel}
          </div>
          {Object.entries(health).map(([name, value]) => (
            <div className="health-item" key={name}>
              <span className={`dot ${value === 'ok' ? 'ok' : 'bad'}`} />
              {name}
            </div>
          ))}
          <button className="btn ghost" onClick={newCase} disabled={busy}>
            New case
          </button>
        </div>
      </header>

      <div className="columns">
        <section className="col">
          <div className="col-head">
            Estate — live from Postgres
            <span className="spacer" />
          </div>
          <div className="col-body">
            <EstatePanel estate={estate} />
          </div>
        </section>

        <section className="col">
          <div className="col-head">
            Agent activity
            <span className="spacer" />
            {state.usage?.totalTokens ? (
              <span className="tool-server">{state.usage.totalTokens.toLocaleString()} tokens</span>
            ) : null}
          </div>
          <div className="col-body" ref={timelineRef}>
            {banner && <div className="banner info">{banner}</div>}
            {state.error && <div className="banner">{state.error}</div>}
            <Timeline items={state.items} />
            {state.pendingApproval && (
              <div style={{ marginTop: 12 }}>
                <ApprovalGate
                  pending={state.pendingApproval}
                  auditEntries={audit?.entries ?? []}
                  busy={busy}
                  onDecide={(decision, reason) => void decide(decision, reason)}
                />
              </div>
            )}
          </div>

          <div className="composer">
            <div className="scenarios">
              {SCENARIOS.map((scenario) => (
                <button
                  key={scenario.label}
                  className="scenario"
                  onClick={() => setDraft(scenario.text)}
                  disabled={busy}
                >
                  {scenario.label}
                </button>
              ))}
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Describe the erasure request..."
              disabled={busy}
            />
            <div className="composer-actions">
              <span className="tool-server">
                {sessionId ? `session ${sessionId.slice(0, 12)}...` : 'no session yet'}
              </span>
              <span className="spacer" />
              <button className="btn primary" onClick={() => void startRun()} disabled={busy || !draft.trim()}>
                {busy ? 'Working...' : 'Send to agent'}
              </button>
            </div>
          </div>
        </section>

        <section className="col">
          <div className="col-head">Audit trail — hash chained</div>
          <div className="col-body">
            <AuditPanel audit={audit} />
          </div>
        </section>
      </div>
    </div>
  );
}
