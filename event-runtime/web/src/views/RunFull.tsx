import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { keyGuard, useNow } from "../hooks";
import { setContextActions } from "../palette";
import { RunTrace } from "../components/RunTrace";
import {
  Button,
  Dialog,
  JumpLink,
  StateBadge,
  VerbError,
  copyLink,
  copyText,
  notify,
} from "../components/ui";
import { RunDetailBlocks, RunFailureBanner, isCancellable } from "../components/RunDetailBlocks";

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
}: {
  runId: string;
  connected: boolean;
  onBack: () => void;
  onJumpAgent: (ref: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"cancel" | "force-retry" | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const detail = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId),
    refetchInterval: 2000,
  });
  // Origin event comes from the list view's join, not GET /runs/:id — the
  // cache key is shared with the Runs list, so this is usually a cache hit.
  const listQ = useQuery({ queryKey: ["runs", "ALL"], queryFn: () => api.runs(), refetchInterval: 2000 });
  const listRow = useMemo(
    () => (listQ.data?.runs ?? []).find((r) => r.runId === runId) ?? null,
    [listQ.data, runId],
  );

  const d = detail.data;
  const attemptsExhausted = d ? d.run.attempts >= d.run.spec.maxAttempts : false;
  const unknownRun = detail.isError && (detail.error as ApiError).status === 404;

  const invalidate = () => queryClient.invalidateQueries();

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.cancel(id, reason),
    onSuccess: (_, { id }) => {
      invalidate();
      notify(`Cancelled run ${id}`, "info");
      setConfirm(null);
      setCancelReason("");
    },
    onError: invalidate,
  });

  const retry = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) => api.retry(id, force),
    onSuccess: (_, { id, force }) => {
      invalidate();
      notify(`${force ? "Force retried" : "Retried"} run ${id}`, "ok");
      setConfirm(null);
    },
    onError: (err) => {
      invalidate();
      // attempts_exhausted → offer the explicit, recorded override (spec §4.3)
      if (err instanceof ApiError && err.message === "attempts_exhausted") setConfirm("force-retry");
    },
  });

  // Same verbs as the panel: Esc back to the list, x cancel, c copy id.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        onBack();
      } else if (e.key === "x" && d && connected && isCancellable(d.run.state)) {
        e.preventDefault();
        setConfirm("cancel");
      } else if (e.key === "c") {
        e.preventDefault();
        copyText(runId, "run id");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [d, connected, onBack, runId]);

  // Offer this run's verbs in the ⌘K palette (§5), same rules as the panel.
  useEffect(() => {
    const copy = [
      { label: "Back to Runs", hint: "Esc", run: onBack },
      { label: `Copy ${runId}`, hint: "c", run: () => copyText(runId, "run id") },
      { label: "Copy link to this run", run: copyLink },
    ];
    if (!d || !connected) {
      setContextActions(copy);
    } else {
      setContextActions([
        ...(isCancellable(d.run.state)
          ? [{ label: `Cancel ${d.run.runId}…`, hint: "x", run: () => setConfirm("cancel") }]
          : []),
        ...(d.run.state === "FAILED"
          ? [
              attemptsExhausted
                ? { label: `Force retry ${d.run.runId}…`, run: () => setConfirm("force-retry") }
                : { label: `Retry ${d.run.runId}`, run: () => retry.mutate({ id: d.run.runId, force: false }) },
            ]
          : []),
        ...copy,
      ]);
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.run.runId, d?.run.state, attemptsExhausted, connected]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-(--border) bg-(--surface-1) px-6 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <nav aria-label="Breadcrumb" className="flex items-center gap-2">
            <ol className="flex min-w-0 flex-wrap items-center gap-2 list-none p-0 m-0 text-[13px]">
              <li className="shrink-0">
                <Button onClick={onBack}>
                  Runs
                </Button>
              </li>
              <li aria-hidden="true" className="text-(--text-faint) shrink-0">
                /
              </li>
              <li className="flex min-w-0 items-center gap-2" aria-current="page">
                {(d?.run.state || listRow?.state) && (
                  <StateBadge state={d?.run.state ?? listRow!.state} />
                )}
                <span className="display mono min-w-0 truncate text-[15px] font-semibold text-(--text)" title={runId}>
                  {runId}
                </span>
              </li>
            </ol>
          </nav>
          {d && (
            <span className="text-[12px] text-(--text-faint)">
              <JumpLink
                onClick={() => onJumpAgent(d.run.spec.agent)}
                title={`What is ${d.run.spec.agent}? Open in Agents`}
              >
                {d.run.spec.agent}
              </JumpLink>{" "}
              · {d.run.spec.adapter} · {d.run.attempts}/{d.run.spec.maxAttempts} attempts
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {d && (
            <div className="flex items-center gap-1.5">
              {isCancellable(d.run.state) && (
                <Button
                  variant="danger"
                  disabled={!connected || cancel.isPending}
                  onClick={() => setConfirm("cancel")}
                >
                  Cancel <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">x</span>
                </Button>
              )}
              {d.run.state === "FAILED" && (
                attemptsExhausted ? (
                  <Button disabled={!connected} onClick={() => setConfirm("force-retry")}>
                    Force retry…
                  </Button>
                ) : (
                  <Button
                    disabled={!connected || retry.isPending}
                    onClick={() => retry.mutate({ id: d.run.runId, force: false })}
                  >
                    Retry
                  </Button>
                )
              )}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[11px] text-(--text-faint)">
            <span>copy:</span>
            <button
              type="button"
              onClick={() => copyText(runId, "run id")}
              className="cursor-pointer hover:text-(--text)"
            >
              id
            </button>
            <span>·</span>
            <button
              type="button"
              onClick={() => copyText(`bun event-runtime/cli.mjs inspect ${runId}`, "CLI inspect command")}
              className="cursor-pointer hover:text-(--text)"
            >
              CLI
            </button>
            <span>·</span>
            <button type="button" onClick={copyLink} className="cursor-pointer hover:text-(--text)">
              link
            </button>
          </div>
        </div>
      </header>

      {unknownRun ? (
        <div className="min-h-0 flex-1 overflow-auto p-6 text-(--text-faint)">
          Unknown run <span className="mono">{runId}</span> — it may not exist on this runtime.
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
            <div className="p-6 xl:max-w-[900px]">
              {/* The failure first (WM-93) — renders nothing for other states. */}
              <RunFailureBanner state={d.run.state} lifecycle={d.lifecycle} className="mb-6" />
              <RunTrace key={runId} runId={runId} state={d.run.state} variant="full" />
            </div>
          </main>

          {/* Same shape as the side panel's DetailPane — border-l, fixed
              width, own bg and scroll — so the two are pixel-identical and
              toggling panel ↔ full page reads as the left region swapping
              rather than the whole layout reflowing (WM-136). Stacks full
              width below the trace under xl, where there is no room for two
              columns. */}
          <aside className="w-full shrink-0 overflow-y-auto border-(--border) bg-(--surface-1) p-4 xl:w-[460px] xl:border-l">
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
              verbError={cancel.error ?? (confirm === "force-retry" ? null : retry.error)}
            />
          </aside>
        </div>
      )}

      {confirm === "cancel" && d && (
        <Dialog title={`Cancel ${d.run.runId}?`} onClose={() => setConfirm(null)}>
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
              onClick={() => cancel.mutate({ id: d.run.runId, reason: cancelReason.trim() || undefined })}
            >
              Cancel run
            </Button>
          </div>
        </Dialog>
      )}

      {confirm === "force-retry" && d && (
        <Dialog title="Retry past the attempt budget?" onClose={() => setConfirm(null)}>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            This run has used {d.run.attempts}/{d.run.spec.maxAttempts} attempts. Forcing a retry
            overrides the declared budget and is recorded in the audit trail as an explicit operator
            override.
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
