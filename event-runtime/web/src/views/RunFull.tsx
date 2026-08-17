import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { keyGuard, useNow } from "../hooks";
import { hashPath, hashProject, withProject } from "../hash";
import { setContextActions } from "../palette";
import { RunTrace } from "../components/RunTrace";
import {
  Button,
  CopyActions,
  Dialog,
  JumpLink,
  Section,
  StateBadge,
  VerbError,
  copyLink,
  copyText,
  notify,
  shortId,
} from "../components/ui";
import {
  RunDetailBlocks,
  RunFailureBanner,
  isCancellable,
} from "../components/RunDetailBlocks";
import { handleRunArtifactClick, toggleRunPin } from "./Runs";
import { AgentHoverCard } from "../components/AgentHoverCard";
import type { RunListItem } from "../types";

/**
 * Full-page run view (`#/run/:id`, webui doc §10.11) — the trace at a
 * readable measure. The side panel is triage; this is where an operator
 * *reads* what the agent did. Main column: the trace, wide, with kind
 * filters. Sidebar (stacks below on narrow viewports): state, verbs, spec
 * summary, lifecycle, attempts, result, receipt, artifacts — the same
 * blocks as the panel, unchanged semantics.
 */
export function RunFull({
  runId,
  connected,
  onBack,
  onJumpAgent,
  onJumpEvent,
  onJumpProposal,
  onJumpChain,
}: {
  runId: string;
  connected: boolean;
  onBack: () => void;
  onJumpAgent: (ref: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  onJumpProposal?: (id: string) => void;
  /** Open the chain trace this run belongs to (WM-527). */
  onJumpChain?: (correlationId: string, nodeId?: string) => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"cancel" | "force-retry" | null>(null);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const detail = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId),
    refetchInterval: 2000,
  });
  const proposalsQ = useQuery({
    queryKey: ["proposals", "open"],
    queryFn: () => api.proposals(),
    refetchInterval: 2000,
  });
  // Origin event comes from the list view's join, not GET /runs/:id — the
  // cache key is shared with the Runs list, so this is usually a cache hit.
  const listQ = useQuery({
    queryKey: ["runs", "ALL"],
    queryFn: () => api.runs(),
    refetchInterval: 2000,
  });
  const eventsQ = useQuery({
    queryKey: ["events", "ALL"],
    queryFn: () => api.events(),
    refetchInterval: 2000,
  });
  const listRow = useMemo(
    () => (listQ.data?.runs ?? []).find((r) => r.runId === runId) ?? null,
    [listQ.data, runId],
  );
  const followUpEvents = useMemo(() => {
    const events = eventsQ.data?.events ?? [];
    return events.filter(
      (e) => e.causationId === runId || (e.envelope as any)?.causationId === runId,
    );
  }, [eventsQ.data, runId]);
  // The chain this run belongs to: its origin event's correlation id (falling
  // back to the event id, as the chain emitter does), or — for a run whose
  // origin is not in the list — any event it emitted names the same chain.
  const chainKey = useMemo(() => {
    const events = eventsQ.data?.events ?? [];
    const origin = listRow
      ? events.find((e) => e.source === listRow.eventSource && e.eventId === listRow.eventId)
      : null;
    if (origin) return origin.correlationId ?? origin.eventId;
    const emitted = events.find((e) => e.causationId === runId);
    return emitted ? (emitted.correlationId ?? emitted.eventId) : null;
  }, [eventsQ.data, listRow, runId]);
  const runsById = useMemo(() => {
    const map = new Map<string, RunListItem>();
    for (const r of listQ.data?.runs ?? []) {
      map.set(r.runId, r);
    }
    return map;
  }, [listQ.data]);

  const d = detail.data;
  const attemptsExhausted = d
    ? d.run.attempts >= d.run.spec.maxAttempts
    : false;
  const unknownRun =
    detail.isError && (detail.error as ApiError).status === 404;

  const invalidate = () => queryClient.invalidateQueries();

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.cancel(id, reason),
    onSuccess: (_, { id }) => {
      invalidate();
      notify(`Cancelled run ${id}`, "info");
      setConfirm(null);
      setCancelReason("");
    },
    onError: invalidate,
  });

  const retry = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) =>
      api.retry(id, force),
    onSuccess: (_, { id, force }) => {
      invalidate();
      notify(`${force ? "Force retried" : "Retried"} run ${id}`, "ok");
      setConfirm(null);
    },
    onError: (err) => {
      invalidate();
      // attempts_exhausted → offer the explicit, recorded override (spec §4.3)
      if (err instanceof ApiError && err.message === "attempts_exhausted")
        setConfirm("force-retry");
    },
  });

  const approve = useMutation({
    mutationFn: (proposalId: string) => api.approve(proposalId),
    onSuccess: (outcome) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["proposals"] });
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
      if (outcome.approved && outcome.runId) {
        notify(`Approved proposal — queued ${outcome.runId}`, "ok");
      } else if (outcome.replanned && outcome.proposal) {
        notify(`Proposal expired — re-planned new spec`, "info");
        if (onJumpProposal) onJumpProposal(outcome.proposal.id);
      }
      setConfirmApprove(false);
    },
    onError: invalidate,
  });

  const selProposal = useMemo(() => {
    for (const p of proposalsQ.data?.proposals ?? []) {
      if (p.runId === runId) return p;
    }
    return null;
  }, [proposalsQ.data?.proposals, runId]);

  const canApprove = Boolean(
    selProposal &&
      selProposal.status === "open" &&
      selProposal.decision === "run" &&
      d?.run.state === "PROPOSED",
  );

  // Verbs: Esc back to list, x cancel, c copy id, c i / c c copy CLI inspect command, c l copy link.
  useEffect(() => {
    let pendingC = 0;
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const now = Date.now();
      if (e.key === "Escape") {
        onBack();
        return;
      }
      if (e.key === "p") {
        e.preventDefault();
        toggleRunPin(runId);
        return;
      }
      if (e.key === "a" && canApprove && connected && !approve.isPending) {
        e.preventDefault();
        setConfirmApprove(true);
        return;
      }
      if (e.key === "x" && d && connected && isCancellable(d.run.state)) {
        e.preventDefault();
        setConfirm("cancel");
        return;
      }
      if (pendingC && now - pendingC < 800) {
        if (e.key === "i" || e.key === "c") {
          e.preventDefault();
          pendingC = 0;
          copyText(
            `bun event-runtime/cli.mjs inspect ${runId}`,
            "CLI inspect command",
          );
          return;
        }
        if (e.key === "l") {
          e.preventDefault();
          pendingC = 0;
          copyLink();
          return;
        }
      }
      if (e.key === "c") {
        e.preventDefault();
        pendingC = now;
        copyText(runId, "run id");
      } else {
        pendingC = 0;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [d, connected, onBack, runId, canApprove, approve.isPending]);

  // Offer this run's verbs in the ⌘K palette (§5), same rules as the panel.
  useEffect(() => {
    const copy = [
      { label: "Back to Runs", hint: "Esc", run: onBack },
      { label: "Open in tab", hint: "p", run: () => toggleRunPin(runId) },
      {
        label: `Copy ${runId}`,
        hint: "c",
        run: () => copyText(runId, "run id"),
      },
      {
        label: "Copy CLI inspect command",
        hint: "c i",
        run: () =>
          copyText(
            `bun event-runtime/cli.mjs inspect ${runId}`,
            "CLI inspect command",
          ),
      },
      { label: "Copy link to this run", hint: "c l", run: copyLink },
    ];
    if (!d || !connected) {
      setContextActions(copy);
    } else {
      setContextActions([
        ...(canApprove && selProposal
          ? [
              {
                label: `Approve proposal ${selProposal.id}…`,
                hint: "a",
                run: () => setConfirmApprove(true),
              },
            ]
          : []),
        ...(selProposal && onJumpProposal
          ? [
              {
                label: `Open proposal ${selProposal.id}`,
                run: () => onJumpProposal(selProposal.id),
              },
            ]
          : []),
        ...(isCancellable(d.run.state)
          ? [
              {
                label: `Cancel ${d.run.runId}…`,
                hint: "x",
                run: () => setConfirm("cancel"),
              },
            ]
          : []),
        ...(d.run.state === "FAILED"
          ? [
              attemptsExhausted
                ? {
                    label: `Force retry ${d.run.runId}…`,
                    run: () => setConfirm("force-retry"),
                  }
                : {
                    label: `Retry ${d.run.runId}`,
                    run: () => retry.mutate({ id: d.run.runId, force: false }),
                  },
            ]
          : []),
        ...copy,
      ]);
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.run.runId, d?.run.state, attemptsExhausted, connected, canApprove, selProposal]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-(--border) bg-(--surface-1) px-6 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <nav aria-label="Breadcrumb" className="flex items-center gap-2">
            <ol className="flex min-w-0 flex-wrap items-center gap-2 list-none p-0 m-0 text-[13px]">
              <li className="shrink-0">
                <Button onClick={onBack}>
                  <span>← Runs</span>
                  <span
                    aria-hidden="true"
                    className="mono ml-1 text-(--text-faint) text-[10px]"
                  >
                    Esc
                  </span>
                </Button>
              </li>
              <li aria-hidden="true" className="text-(--text-faint) shrink-0">
                /
              </li>
              <li
                className="flex min-w-0 items-center gap-2"
                aria-current="page"
              >
                {(d?.run.state || listRow?.state) && (
                  <StateBadge state={d?.run.state ?? listRow!.state} />
                )}
                <span
                  className="display mono min-w-0 truncate text-[15px] font-semibold text-(--text)"
                  title={runId}
                >
                  {runId}
                </span>
              </li>
            </ol>
          </nav>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {d && (
            <div className="flex items-center gap-1.5">
              {canApprove && selProposal && (
                <Button
                  disabled={!connected || approve.isPending}
                  onClick={() => setConfirmApprove(true)}
                >
                  Approve…{" "}
                  <span
                    className="mono ml-1 text-(--text-faint)"
                    aria-hidden="true"
                  >
                    a
                  </span>
                </Button>
              )}
              {selProposal && onJumpProposal && (
                <Button onClick={() => onJumpProposal(selProposal.id)}>
                  Open proposal
                </Button>
              )}
              {isCancellable(d.run.state) && (
                <Button
                  variant="danger"
                  disabled={!connected || cancel.isPending}
                  onClick={() => setConfirm("cancel")}
                >
                  Cancel{" "}
                  <span
                    className="mono ml-1 text-(--text-faint)"
                    aria-hidden="true"
                  >
                    x
                  </span>
                </Button>
              )}
              {d.run.state === "FAILED" &&
                (attemptsExhausted ? (
                  <Button
                    disabled={!connected}
                    onClick={() => setConfirm("force-retry")}
                  >
                    Force retry…
                  </Button>
                ) : (
                  <Button
                    disabled={!connected || retry.isPending}
                    onClick={() =>
                      retry.mutate({ id: d.run.runId, force: false })
                    }
                  >
                    Retry
                  </Button>
                ))}
            </div>
          )}
          {onJumpChain && chainKey && (
            <Button
              onClick={() => onJumpChain(chainKey, `run:${runId}`)}
            >
              View chain
            </Button>
          )}
          <Button onClick={() => toggleRunPin(runId)}>
            <span>Open in tab</span>
            <span
              aria-hidden="true"
              className="mono ml-1 text-(--text-faint) text-[10px]"
            >
              p
            </span>
          </Button>
          <CopyActions
            id={runId}
            idLabel="run id"
            cli={`bun event-runtime/cli.mjs inspect ${runId}`}
            cliLabel="CLI inspect command"
          />
        </div>
      </header>

      {unknownRun ? (
        <div className="min-h-0 flex-1 overflow-auto p-6 text-(--text-faint)">
          Unknown run <span className="mono">{runId}</span> — it may not exist
          on this runtime.
        </div>
      ) : !d ? (
        <div className="min-h-0 flex-1 overflow-auto p-6 text-(--text-faint)">
          {detail.isError ? "Could not load run detail." : "Loading run…"}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
          {/* Main column: the trace, at a readable measure — the point of the
              page — scrolling on its own so the sidebar never moves with it. */}
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="p-6 xl:mx-auto xl:max-w-[900px]">
              {/* The failure first (WM-93) — renders nothing for other states. */}
              <RunFailureBanner
                state={d.run.state}
                lifecycle={d.lifecycle}
                className="mb-6"
              />
              {d.run.state === "PROPOSED" && (
                <div className="mb-6 rounded-md border border-(--border) bg-(--surface-1) p-4 text-[13px]">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-(--text)">Awaiting Proposal Approval</div>
                      <div className="text-[12px] text-(--text-dim) mt-0.5">
                        {selProposal
                          ? `Proposal ${shortId(selProposal.id)} is open and ready to approve.`
                          : "This run was proposed and is waiting for proposal approval."}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selProposal && onJumpProposal && (
                        <Button onClick={() => onJumpProposal(selProposal.id)}>
                          Open proposal
                        </Button>
                      )}
                      {canApprove && selProposal && (
                        <Button
                          disabled={!connected || approve.isPending}
                          onClick={() => setConfirmApprove(true)}
                        >
                          Approve…
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <RunTrace
                key={runId}
                runId={runId}
                state={d.run.state}
                variant="full"
              />
            </div>
          </main>

          {/* Same shape as the side panel's DetailPane — border-l, fixed
              width, own bg and scroll — so the two are pixel-identical and
              toggling panel ↔ full page reads as the left region swapping
              rather than the whole layout reflowing (WM-136). Stacks full
              width below the trace under xl, where there is no room for two
              columns. */}
          <aside className="w-full shrink-0 overflow-y-auto border-(--border) bg-(--surface-1) p-4 xl:w-[460px] xl:border-l">
            <div onClickCapture={handleRunArtifactClick}>
              <RunDetailBlocks
                d={d}
                now={now}
                connected={connected}
                origin={listRow}
                onJumpAgent={onJumpAgent}
                onJumpEvent={onJumpEvent}
                onCancel={() => setConfirm("cancel")}
                onRetry={() => retry.mutate({ id: d.run.runId, force: false })}
                onForceRetry={() => setConfirm("force-retry")}
                retryPending={retry.isPending}
                afterLifecycle={
                  <Section title="Follow-up Events" id="run-follow-up-events" card={followUpEvents.length === 0}>
                    {followUpEvents.length === 0 ? (
                      <div className="text-[12px] text-(--text-faint)">
                        No follow-up event was emitted.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {followUpEvents.map((e) => {
                          const linkedRun = e.runId ? runsById.get(e.runId) : null;
                          return (
                            <div
                              key={`${e.source}:${e.eventId}`}
                              className="rounded-md border border-(--border) bg-(--surface-0) p-3 text-[12px]"
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="mono font-medium text-(--text) truncate" title={e.type}>
                                  {e.type}
                                </span>
                                <span
                                  className="mono shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
                                  style={{
                                    background: e.status === "planned" || e.status === "admitted" ? "var(--surface-2)" : "var(--surface-1)",
                                    color: e.status === "dead_lettered" ? "var(--hue-err)" : "var(--text-dim)",
                                  }}
                                >
                                  {e.status}
                                </span>
                              </div>

                              <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11px] text-(--text-faint)">
                                <span className="shrink-0">event</span>
                                <JumpLink
                                  onClick={() => onJumpEvent(e.source, e.eventId)}
                                  title={e.eventId}
                                  className="truncate"
                                >
                                  {shortId(e.eventId)}
                                </JumpLink>
                              </div>

                              {e.proposalId && (
                                <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-(--text-faint)">
                                  <span className="shrink-0">proposal</span>
                                  <JumpLink
                                    href={`#/${withProject(hashPath("proposals", e.proposalId), hashProject(window.location.hash))}`}
                                    title={e.proposalId}
                                    className="truncate"
                                  >
                                    {shortId(e.proposalId)}
                                  </JumpLink>
                                </div>
                              )}

                              {e.runId && (
                                <div className="mt-2 border-t border-(--border) pt-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] font-medium text-(--text-dim)">
                                      Follow-up Run
                                    </span>
                                    {linkedRun?.state && (
                                      <StateBadge state={linkedRun.state} />
                                    )}
                                  </div>
                                  <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
                                    <span className="text-(--text-faint)">agent</span>
                                    <span className="text-(--text-dim) truncate">
                                      {linkedRun?.agent ? (
                                        <AgentHoverCard
                                          agentRef={linkedRun.agent}
                                          onJumpAgent={onJumpAgent}
                                        />
                                      ) : (
                                        "—"
                                      )}
                                    </span>
                                  </div>
                                  <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
                                    <span className="text-(--text-faint)">run</span>
                                    <JumpLink
                                      href={`#/${withProject(hashPath("run", e.runId), hashProject(window.location.hash))}`}
                                      title={`Open run ${e.runId}`}
                                      className="text-(--accent) truncate"
                                    >
                                      {shortId(e.runId)} →
                                    </JumpLink>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Section>
                }
                verbError={
                  cancel.error ??
                  (confirm === "force-retry" ? null : retry.error)
                }
              />
            </div>
          </aside>
        </div>
      )}

      {confirmApprove && selProposal && d && (
        <Dialog
          title={`Approve and queue run ${shortId(selProposal.runId ?? d.run.runId)}?`}
          onClose={() => setConfirmApprove(false)}
          wide
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            Approving proposal <span className="mono font-semibold">{selProposal.id}</span> queues this run for execution.
          </div>
          <VerbError error={approve.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmApprove(false)}>Not yet</Button>
            <Button
              disabled={!connected || approve.isPending}
              onClick={() => {
                approve.mutate(selProposal.id);
              }}
            >
              Approve and queue <span className="mono ml-1 opacity-80" aria-hidden="true">↵</span>
            </Button>
          </div>
        </Dialog>
      )}

      {confirm === "cancel" && d && (
        <Dialog
          title={`Cancel ${d.run.runId}?`}
          onClose={() => setConfirm(null)}
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            {d.run.state === "RUNNING"
              ? "The running attempt is stopped with TERM, then KILL, and terminates as cancelled."
              : "The run is cancelled before execution; the operator is recorded as actor."}
          </div>
          <VerbError error={cancel.error} />
          <input
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Reason (optional)"
            className="mb-3 w-full rounded-md border border-(--border-strong) bg-(--surface-0) px-2.5 py-1.5 text-(--text) outline-none focus:border-(--accent)"
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(null)}>Keep run</Button>
            <Button
              variant="danger"
              disabled={cancel.isPending}
              onClick={() =>
                cancel.mutate({
                  id: d.run.runId,
                  reason: cancelReason.trim() || undefined,
                })
              }
            >
              Cancel run
            </Button>
          </div>
        </Dialog>
      )}

      {confirm === "force-retry" && d && (
        <Dialog
          title="Retry past the attempt budget?"
          onClose={() => setConfirm(null)}
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            This run has used {d.run.attempts}/{d.run.spec.maxAttempts}{" "}
            attempts. Forcing a retry overrides the declared budget and is
            recorded in the audit trail as an explicit operator override.
          </div>
          <VerbError error={retry.error} />
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setConfirm(null)}>Leave it</Button>
            <Button
              variant="primary"
              disabled={retry.isPending}
              onClick={() => retry.mutate({ id: d.run.runId, force: true })}
            >
              Force retry
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
