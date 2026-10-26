import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Clock3,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Square,
  X,
  AlertCircle,
} from "lucide-react";
import type { AppState, LocalTask, Reply, Job } from "../types";
import { api } from "../core/api";
import { EmptyPanel, IconButton, SectionHeading } from "./ui";
export default function Tasks({
  connected,
  state,
  tasks,
  refresh,
  draft,
  stop,
  onConnect,
  notice,
  addReply,
  recover,
  approvalAction,
}: {
  connected: boolean;
  state: AppState | null;
  tasks: LocalTask[];
  refresh: () => void;
  draft: (s: string) => void;
  stop: () => void;
  onConnect: () => void;
  notice: (s: string) => void;
  addReply: (r: Reply) => void;
  recover: (id: string) => void;
  /** A decision tapped in the notification shade, applied once on arrival. */
  approvalAction?: { id: string; decision: boolean; nonce: number } | null;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    const read = async () => {
      if (document.hidden) return;
      try {
        const r = await api.jobs();
        if (alive) setJobs(r.jobs);
      } catch {
        /* status UI already reports connection failures */
      }
    };
    void read();
    const timer = setInterval(() => void read(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [connected]);
  const [approving, setApproving] = useState("");
  // The shade hands over one decision; applying it is the same code path as
  // tapping Approve here, so the PC's stale/changed check still applies.
  const applied = useRef(0);
  useEffect(() => {
    if (!approvalAction || approvalAction.nonce === applied.current) return;
    if (!state?.pending.some((p) => p.id === approvalAction.id)) return;
    applied.current = approvalAction.nonce;
    void decide(approvalAction.id, approvalAction.decision);
  }, [approvalAction, state]);
  async function decide(id: string, approve: boolean) {
    if (approving) return;
    setApproving(id);
    try {
      const reply = await api.post<Reply>("/api/app/approval", { id, approve });
      addReply(reply);
      refresh();
    } catch (e) {
      notice(
        e instanceof Error ? e.message : "Could not resolve that approval.",
      );
      refresh();
    } finally {
      setApproving("");
    }
  }
  return (
    <div className="page-content">
      <SectionHeading
        eyebrow="LESS JUGGLING. MORE DOING."
        title="Room to focus."
        action={
          <IconButton
            label="Refresh tasks"
            disabled={!connected}
            onClick={refresh}
          >
            <RefreshCw size={18} />
          </IconButton>
        }
      >
        Your work, without the guesswork.
      </SectionHeading>
      {!connected ? (
        <EmptyPanel
          icon={<ListChecks size={30} strokeWidth={1.4} />}
          title="Big ideas. Clear next steps."
          action={
            <button className="button primary" onClick={onConnect}>
              Connect your PC
              <ArrowRight size={17} />
            </button>
          }
        >
          Live tasks and approval requests come from your agent. Connect to see
          what’s actually happening.
        </EmptyPanel>
      ) : (
        <>
          {!!state?.pending.length && (
            <section className="approval-section">
              <div className="section-label">
                <ShieldCheck size={16} />
                YOUR APPROVAL NEEDED
              </div>
              {state.pending.map((p) => (
                <div className="approval-card" key={p.id}>
                  <h3>Pause. Take a look.</h3>
                  <p>{p.text}</p>
                  <small>
                    Approval is bound to this exact request. Changed or expired
                    requests cannot be approved.
                  </small>
                  <div className="button-row">
                    <button
                      className="button primary"
                      disabled={!!approving || !!state?.active.length}
                      onClick={() => void decide(p.id, true)}
                    >
                      {approving === p.id ? (
                        <LoaderCircle size={16} className="spin" />
                      ) : (
                        <Check size={16} />
                      )}
                      Approve this action
                    </button>
                    <button
                      className="button"
                      disabled={!!approving || !!state?.active.length}
                      onClick={() => void decide(p.id, false)}
                    >
                      <X size={16} />
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}
          <div className="task-overview">
            <div>
              <span className="muted">On your PC</span>
              <h2>
                {!state
                  ? "Live state unavailable."
                  : state.active.length
                    ? `${state.active.length} active ${state.active.length === 1 ? "task" : "tasks"}`
                    : "A clear desk."}
              </h2>
              <p>
                {!state
                  ? "Update the PC agent for structured tasks and bound approvals. Local requests remain listed below."
                  : state.active.length
                    ? "Actual agent activity. No invented progress percentages."
                    : "No active agent tasks right now."}
              </p>
            </div>
            {!!state?.active.length && (
              <button className="button" onClick={stop}>
                <Square size={15} />
                Request stop
              </button>
            )}
          </div>
          {state?.active.map((t) => (
            <div className="task-row" key={t.id}>
              <LoaderCircle size={18} className="spin" />
              <div>
                <strong>{t.label}</strong>
                <span>{t.detail}</span>
              </div>
              <small>{Math.round(t.elapsedMs / 1000)}s</small>
            </div>
          ))}
          {!!state?.batch?.entries.length && (
            <section className="content-section">
              <div className="section-label">LATEST BATCH</div>
              {state.batch.entries.map((e) => (
                <div className="task-row" key={e.index}>
                  {e.status === "running" ? (
                    <LoaderCircle size={18} className="spin" />
                  ) : e.status === "completed" ? (
                    <Check size={18} />
                  ) : (
                    <Clock3 size={18} />
                  )}
                  <div>
                    <strong>{e.command}</strong>
                    <span>
                      {e.text?.slice(0, 220) || "Not started."}
                      {e.completedAfterStop
                        ? " Finished despite stop; do not repeat."
                        : ""}
                    </span>
                  </div>
                  <small className="small-pill">{e.status}</small>
                </div>
              ))}
            </section>
          )}
          <section className="content-section">
            <div className="section-label">THIS DEVICE · RECENT REQUESTS</div>
            {tasks.length ? (
              [...tasks].reverse().map((t) => (
                <div className="task-row" key={t.id}>
                  {t.state === "running" ? (
                    <LoaderCircle size={18} className="spin" />
                  ) : t.state === "unknown" ? (
                    <AlertCircle size={18} />
                  ) : (
                    <Check size={18} />
                  )}
                  <div>
                    <strong>{t.text.slice(0, 100)}</strong>
                    <span>
                      {t.state === "unknown"
                        ? "Connection interrupted. Outcome unknown; inspect the PC before repeating."
                        : t.state === "replied"
                          ? "Agent replied. Read the result to verify the outcome."
                          : t.state === "stopped"
                            ? "Stop requested. Already-started actions may still finish."
                            : "Waiting for the agent’s result."}
                    </span>
                  </div>
                  <small
                    className={`small-pill ${
                      t.state === "running"
                        ? "pill-run"
                        : t.state === "replied"
                          ? "pill-ok"
                          : t.state === "unknown"
                            ? "pill-bad"
                            : ""
                    }`}
                  >
                    {t.state}
                  </small>
                </div>
              ))
            ) : (
              <div className="quiet-card">
                A little breathing room. Requests you send from this device
                appear here.
              </div>
            )}
          </section>
        </>
      )}
      {connected && jobs.length > 0 && (
        <section className="content-section">
          <div className="section-label">RECOVERABLE PC REQUESTS</div>
          {jobs.map((job) => (
            <div className="task-row" key={job.id}>
              <Clock3 size={18} />
              <div>
                <strong>{job.label}</strong>
                <span>
                  {job.state}
                  {job.stopRequested
                    ? " · stop was requested; inspect the settled outcome"
                    : ""}
                </span>
              </div>
              <button
                className="button compact"
                onClick={() => recover(job.id)}
              >
                View result
                <ArrowRight size={14} />
              </button>
            </div>
          ))}
        </section>
      )}
      <div className="batch-callout">
        <span className="empty-icon small">
          <ListChecks size={21} />
        </span>
        <div>
          <h3>A few things on your mind?</h3>
          <p>
            Batch up to 8 independent tasks. PC changes stay serial;
            confirmations never happen automatically.
          </p>
          <button
            className="text-button"
            onClick={() =>
              draft(
                "/batch /ask explain recursion || /ask suggest a study routine || /time",
              )
            }
          >
            Draft a batch
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
