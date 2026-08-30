import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, extendRun } from "../api";
import { keyGuard, refetchIntervals, useNow } from "../hooks";
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
import { TicketText } from "../components/TicketHoverCard";
import type { RunSummary } from "../types";

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
  const [customExtend, setCustomExtend] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("15");
  const [extendNotice, setExtendNotice] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const detail = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId),
    ...refetchIntervals.primary,
  });
  const proposalsQ = useQuery({
    queryKey: ["proposals", "open"],
    queryFn: () => api.proposals(),
    ...refetchIntervals.secondary,
  });
  // Origin event comes from the list view's join, not GET /runs/:id — the
  // cache key is shared with the Runs list, so this is usually a cache hit.
  const listQ = useQuery({
    queryKey: ["runs", "ALL"],
    queryFn: () => api.runs(),
    ...refetchIntervals.secondary,
  });
  const eventsQ = useQuery({
    queryKey: ["events", "ALL"],
    queryFn: () => api.events(),
    ...refetchIntervals.secondary,
  });
  const listRow: RunSummary | null = useMemo(
    () => (listQ.data?.runs ?? []).find((r) => r.runId === runId) ?? null,
    [listQ.data, runId],
  );
  const followUpEvents = useMemo(() => {
    const events = eventsQ.data?.events ?? [];
    return events.filter(
      (e) => e.causationId === runId || e.envelope?.causationId === runId,
    );
  }, [eventsQ.data, runId]);
  // The chain this run belongs to: any event it emitted names the same chain.
  // This used to also try the list row's origin event (source/eventId), but
  // the bounded GET /runs summary (WM-976) dropped both fields off the run
  // row, so that join can never match — the origin-event sidebar row
  // (RunDetailBlocks) is in the same position, and gracefully renders nothing
  // once `listRow` no longer carries `eventId`/`eventSource`.
  const chainKey = useMemo(() => {
    const events = eventsQ.data?.events ?? [];
    const emitted = events.find((e) => e.causationId === runId);
    return emitted ? (emitted.correlationId ?? emitted.eventId) : null;
  }, [eventsQ.data, runId]);
  const runsById = useMemo(() => {
    const map = new Map<string, RunSummary>();
    for (const r of listQ.data?.runs ?? []) {
      map.set(r.runId, r);
    }
    return map;
  }, [listQ.data]);

  // A query can resolve with a partial payload while caches hydrate. Treat a
  // detail without its root run as unpopulated so every guarded d.run access
  // below stays on the loading/fallback path.
  const d = detail.data?.run ? detail.data : undefined;
  const attemptsExhausted = d
    ? d.run.attempts >= d.run.spec.maxAttempts
    : false;
  const unknownRun =
    detail.isError && (detail.error as ApiError).status === 404;
  const customMinutesNumber = Number(customMinutes);
  const customMinutesValid =
    customMinutes.trim() !== "" &&
    Number.isInteger(customMinutesNumber) &&
    customMinutesNumber >= 1 &&
    customMinutesNumber <= 60;

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

  const extend = useMutation({
    mutationFn: ({ id, seconds }: { id: string; seconds: number }) =>
      extendRun(id, seconds),
    onSuccess: (outcome) => {
      invalidate();
      const minutes = Math.round(outcome.seconds / 60);
      const message = `Run extended by ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
      setExtendNotice(message);
      notify(`${message} (${outcome.runId})`, "ok");
      setCustomExtend(false);
    },
    onError: () => {
      setExtendNotice(null);
      invalidate();
    },
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
    d?.run?.state === "PROPOSED",
  );

  // Verbs: Esc back to list, x cancel, c / l view chain, p open proposal, a approve.
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
        if (selProposal && onJumpProposal) {
          onJumpProposal(selProposal.id);
        } else {
          toggleRunPin(runId);
        }
        return;
      }
      if ((e.key === "c" || e.key === "l") && onJumpChain && chainKey) {
        e.preventDefault();
        onJumpChain(chainKey, `run:${runId}`);
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
  }, [
    d,
    connected,
    onBack,
    runId,
    canApprove,
    approve.isPending,
    selProposal,
    onJumpProposal,
    onJumpChain,
    chainKey,
  ]);

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
                hint: "p",
                run: () => onJumpProposal(selProposal.id),
              },
            ]
          : []),
        ...(onJumpChain && chainKey
          ? [
              {
                label: "View chain",
                hint: "c",
                run: () => onJumpChain(chainKey, `run:${runId}`),
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
        ...(["RUNNING", "VERIFYING"].includes(d.run.state)
          ? [
              {
                label: `Extend ${d.run.runId}…`,
                run: () => setCustomExtend(true),
              },
            ]
          : []),
        ...copy,
      ]);
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    d?.run?.runId,
    d?.run?.state,
    attemptsExhausted,
    connected,
    canApprove,
    selProposal,
  ]);

  const inflight = Boolean(d && ["RUNNING", "VERIFYING"].includes(d.run.state));
  const showVerbRow =
    Boolean(canApprove && selProposal) ||
    Boolean(d && isCancellable(d.run.state)) ||
    inflight ||
    Boolean(d && d.run.state === "FAILED");

  return (
    <div className="fixed inset-0 z-20 flex h-full min-w-0 flex-col overflow-hidden bg-(--surface-0) sm:static sm:z-auto">
      <header className="sticky top-0 z-10 flex shrink-0 flex-col items-stretch gap-2 border-b border-(--border) bg-(--surface-1) px-6 py-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-2"
            >
              <ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-2 p-0 text-[13px]">
                <li className="shrink-0">
                  <Button onClick={onBack}>
                    <span>← Runs</span>
                    <span
                      aria-hidden="true"
                      className="mono ml-1 text-xs text-(--text-faint)"
                    >
                      Esc
                    </span>
                  </Button>
                </li>
                <li aria-hidden="true" className="shrink-0 text-(--text-faint)">
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
                    className="display min-w-0 truncate text-[15px] font-semibold text-(--text)"
                    title={d?.subject ? `${d.subject} · ${runId}` : runId}
                  >
                    {d?.subject ? (
                      <TicketText text={d.subject} />
                    ) : (
                      <span className="mono">{shortId(runId)}</span>
                    )}
                  </span>
                </li>
              </ol>
            </nav>
            <div className="shrink-0 text-(--text-faint)">
              <CopyActions
                id={runId}
                idLabel="run id"
                cli={`bun event-runtime/cli.mjs inspect ${runId}`}
                cliLabel="CLI inspect command"
              />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {selProposal && onJumpProposal && (
              <Button onClick={() => onJumpProposal(selProposal.id)}>
                <span>Open proposal</span>
                <span
                  aria-hidden="true"
                  className="mono ml-1 text-xs text-(--text-faint)"
                >
                  p
                </span>
              </Button>
            )}
            {onJumpChain && chainKey && (
              <Button onClick={() => onJumpChain(chainKey, `run:${runId}`)}>
                <span>View chain</span>
                <span
                  aria-hidden="true"
                  className="mono ml-1 text-xs text-(--text-faint)"
                >
                  c
                </span>
              </Button>
            )}
            <Button onClick={() => toggleRunPin(runId)}>
              <span>Open in tab</span>
              {(!selProposal || !onJumpProposal) && (
                <span
                  aria-hidden="true"
                  className="mono ml-1 text-xs text-(--text-faint)"
                >
                  p
                </span>
              )}
            </Button>
          </div>
        </div>
        {showVerbRow && (
          <div className="flex min-h-7 flex-wrap items-center gap-1.5">
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
            {d && isCancellable(d.run.state) && (
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
            {inflight && d && (
              <>
                <span
                  className="mr-1 text-[12px] text-(--text-dim) tabular-nums"
                  title="Current execution deadline. The sidebar budget meter preserves the original approved RunSpec; its lease clock reflects extensions."
                >
                  Remaining{" "}
                  {d.deadlineAt
                    ? (() => {
                        const left = Math.max(
                          0,
                          Date.parse(d.deadlineAt) - now,
                        );
                        const minutes = Math.ceil(left / 60_000);
                        return minutes >= 60
                          ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
                          : `${minutes}m`;
                      })()
                    : "—"}
                </span>
                <Button
                  disabled={extend.isPending}
                  onClick={() => setCustomExtend(true)}
                >
                  Extend…
                </Button>
              </>
            )}
            {d &&
              d.run.state === "FAILED" &&
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
        {extend.error && !customExtend && <VerbError error={extend.error} />}
        {extendNotice && (
          <div className="mt-1 text-[12px] text-(--hue-ok)" role="status">
            {extendNotice}. The Remaining clock is the current execution
            deadline; the sidebar budget preserves the original approved
            RunSpec.
          </div>
        )}
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
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden">
          {/* Main column: the trace, at a readable measure — the point of the
              page — scrolling on its own so the sidebar never moves with it. */}
          <main className="min-w-0 flex-none overflow-visible xl:flex-1 xl:overflow-y-auto">
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
                      <div className="font-semibold text-(--text)">
                        Awaiting Proposal Approval
                      </div>
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
          <aside className="w-full shrink-0 overflow-visible border-(--border) bg-(--surface-1) p-4 xl:w-[460px] xl:overflow-y-auto xl:border-l">
            <div onClickCapture={handleRunArtifactClick}>
              <RunDetailBlocks
                d={d}
                now={now}
                connected={connected}
                // The bounded GET /runs summary (WM-976) dropped eventId/
                // eventSource off the list row, so there is no origin event
                // left to join here.
                origin={null}
                onJumpAgent={onJumpAgent}
                onJumpEvent={onJumpEvent}
                onCancel={() => setConfirm("cancel")}
                onRetry={() => retry.mutate({ id: d.run.runId, force: false })}
                onForceRetry={() => setConfirm("force-retry")}
                retryPending={retry.isPending}
                afterLifecycle={
                  <Section
                    title="Follow-up Events"
                    id="run-follow-up-events"
                    card={followUpEvents.length === 0}
                  >
                    {followUpEvents.length === 0 ? (
                      <div className="text-[12px] text-(--text-faint)">
                        No follow-up event was emitted.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {followUpEvents.map((e) => {
                          const linkedRun = e.runId
                            ? runsById.get(e.runId)
                            : null;
                          return (
                            <div
                              key={`${e.source}:${e.eventId}`}
                              className="rounded-md border border-(--border) bg-(--surface-0) p-3 text-[12px]"
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <span
                                  className="mono font-medium text-(--text) truncate"
                                  title={e.type}
                                >
                                  {e.type}
                                </span>
                                <span
                                  className="mono shrink-0 rounded px-1.5 py-0.5 text-xs font-medium tracking-wide uppercase"
                                  style={{
                                    background:
                                      e.status === "planned" ||
                                      e.status === "admitted"
                                        ? "var(--surface-2)"
                                        : "var(--surface-1)",
                                    color:
                                      e.status === "dead_lettered"
                                        ? "var(--hue-err)"
                                        : "var(--text-dim)",
                                  }}
                                >
                                  {e.status}
                                </span>
                              </div>

                              <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11px] text-(--text-faint)">
                                <span className="shrink-0">event</span>
                                <JumpLink
                                  onClick={() =>
                                    onJumpEvent(e.source, e.eventId)
                                  }
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
                                    <span className="text-(--text-faint)">
                                      agent
                                    </span>
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
                                    <span className="text-(--text-faint)">
                                      run
                                    </span>
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
          footer={
            <>
              <Button onClick={() => setConfirmApprove(false)}>Not yet</Button>
              <Button
                disabled={!connected || approve.isPending}
                onClick={() => {
                  approve.mutate(selProposal.id);
                }}
              >
                Approve and queue{" "}
                <span className="mono ml-1 opacity-80" aria-hidden="true">
                  ↵
                </span>
              </Button>
            </>
          }
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            Approving proposal{" "}
            <span className="mono font-semibold">{selProposal.id}</span> queues
            this run for execution.
          </div>
          <VerbError error={approve.error} />
        </Dialog>
      )}

      {customExtend && d && (
        <Dialog
          title={`Extend ${d.run.runId}`}
          onClose={() => setCustomExtend(false)}
          footer={
            <>
              <Button onClick={() => setCustomExtend(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!connected || extend.isPending || !customMinutesValid}
                onClick={() =>
                  extend.mutate({
                    id: d.run.runId,
                    seconds: customMinutesNumber * 60,
                  })
                }
              >
                Extend run
              </Button>
            </>
          }
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            Add up to 60 minutes per request. The policy run limit still
            applies.
          </div>
          <VerbError error={extend.error} />
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <Button
              disabled={!connected || extend.isPending}
              onClick={() =>
                extend.mutate({ id: d.run.runId, seconds: 15 * 60 })
              }
            >
              +15m
            </Button>
            <Button
              disabled={!connected || extend.isPending}
              onClick={() =>
                extend.mutate({ id: d.run.runId, seconds: 30 * 60 })
              }
            >
              +30m
            </Button>
          </div>
          <label className="mb-3 block text-[12px] text-(--text-dim)">
            Minutes
            <input
              aria-label="Extension minutes"
              aria-describedby="extension-minutes-help"
              aria-invalid={!customMinutesValid}
              type="number"
              min="1"
              max="60"
              step="1"
              value={customMinutes}
              onChange={(e) => setCustomMinutes(e.target.value)}
              className="mt-1 w-full rounded-md border border-(--border-strong) bg-(--surface-0) px-2.5 py-1.5 text-(--text) outline-none focus:border-(--accent)"
            />
            <span
              id="extension-minutes-help"
              className={
                customMinutesValid
                  ? "mt-1 block text-(--text-faint)"
                  : "mt-1 block text-(--hue-err)"
              }
            >
              Enter a whole number from 1 to 60.
            </span>
          </label>
        </Dialog>
      )}

      {confirm === "cancel" && d && (
        <Dialog
          title={`Cancel ${d.run.runId}?`}
          onClose={() => setConfirm(null)}
          footer={
            <>
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
            </>
          }
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
        </Dialog>
      )}

      {confirm === "force-retry" && d && (
        <Dialog
          title="Retry past the attempt budget?"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>Leave it</Button>
              <Button
                variant="primary"
                disabled={retry.isPending}
                onClick={() => retry.mutate({ id: d.run.runId, force: true })}
              >
                Force retry
              </Button>
            </>
          }
        >
          <div className="mb-3 text-[12px] text-(--text-dim)">
            This run has used {d.run.attempts}/{d.run.spec.maxAttempts}{" "}
            attempts. Forcing a retry overrides the declared budget and is
            recorded in the audit trail as an explicit operator override.
          </div>
          <VerbError error={retry.error} />
        </Dialog>
      )}
    </div>
  );
}
