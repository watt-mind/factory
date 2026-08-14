import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { keyGuard, useNow } from "../hooks";
import { setContextActions } from "../palette";
import { RunTrace } from "../components/RunTrace";
import {
  Ago,
  Button,
  Dialog,
  Disclosure,
  JsonBlock,
  JumpLink,
  KV,
  Section,
  StateBadge,
  VerbError,
  copyLink,
  copyText,
  notify,
} from "../components/ui";
import { ActorRef, ArtifactRow, RunFailureBanner, TERMINAL } from "./Runs";

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
      } else if (e.key === "x" && d && connected && !TERMINAL.includes(d.run.state)) {
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
        ...(!TERMINAL.includes(d.run.state)
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
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-(--border) px-6 py-3">
        <Button onClick={onBack}>← Runs</Button>
        {d && <StateBadge state={d.run.state} />}
        <span className="display mono min-w-0 truncate text-[15px] font-semibold" title={runId}>
          {runId}
        </span>
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
        <span className="ml-auto flex shrink-0 gap-1.5">
          <Button onClick={() => copyText(runId, "run id")}>Copy id</Button>
          <Button onClick={copyLink}>Copy link</Button>
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {unknownRun ? (
          <div className="p-6 text-(--text-faint)">
            Unknown run <span className="mono">{runId}</span> — it may not exist on this runtime.
          </div>
        ) : !d ? (
          <div className="p-6 text-(--text-faint)">
            {detail.isError ? "Could not load run detail." : "Loading run…"}
          </div>
        ) : (
          <>
          {/* The failure first, full width under the header (WM-93) — renders nothing for other states. */}
          <RunFailureBanner state={d.run.state} lifecycle={d.lifecycle} className="mx-6 mt-6 mb-0" />
          <div className="flex flex-col gap-8 p-6 xl:flex-row">
            {/* Main column: the trace, at a readable measure — the point of the page. */}
            <main className="min-w-0 flex-1 xl:max-w-[900px]">
              <RunTrace key={runId} runId={runId} state={d.run.state} variant="full" />
            </main>

            <aside className="w-full shrink-0 xl:w-[400px]">
              <div className="mb-4 flex gap-2">
                {!TERMINAL.includes(d.run.state) && (
                  <Button variant="danger" disabled={!connected} onClick={() => setConfirm("cancel")}>
                    Cancel <span className="mono ml-1 opacity-70">x</span>
                  </Button>
                )}
                {/* §8: only FAILED → QUEUED is a legal retry transition. */}
                {d.run.state === "FAILED" &&
                  (attemptsExhausted ? (
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
                  ))}
              </div>
              <VerbError error={cancel.error ?? (confirm === "force-retry" ? null : retry.error)} />

              <Section title="Run">
                <KV
                  k="agent"
                  v={
                    <JumpLink
                      onClick={() => onJumpAgent(d.run.spec.agent)}
                      title={`What is ${d.run.spec.agent}? Open in Agents`}
                    >
                      {d.run.spec.agent}
                    </JumpLink>
                  }
                />
                <KV k="adapter" v={d.run.spec.adapter} />
                <KV k="attempts" v={`${d.run.attempts}/${d.run.spec.maxAttempts}`} />
                {listRow?.eventId && (
                  <KV
                    k="origin event"
                    v={
                      listRow.eventSource ? (
                        <JumpLink
                          onClick={() => onJumpEvent(listRow.eventSource!, listRow.eventId!)}
                          title="Open origin event"
                        >
                          {`${listRow.eventSource} · ${listRow.eventId}`}
                        </JumpLink>
                      ) : (
                        listRow.eventId
                      )
                    }
                  />
                )}
                <KV k="idempotencyKey" v={d.run.idempotencyKey} />
                <KV k="specHash" v={d.run.specHash} />
                <KV k="workspace" v={d.workspace} />
                <KV k="created" v={<Ago iso={d.run.created_at} now={now} />} />
                <KV k="updated" v={<Ago iso={d.run.updated_at} now={now} />} />
                <Disclosure label="immutable RunSpec">
                  <JsonBlock value={d.run.spec} />
                </Disclosure>
              </Section>

              <Section title="Lifecycle">
                <div className="rounded-md border border-(--border) px-3 py-1 text-[12px]">
                  {d.lifecycle.map((e) => (
                    <div key={e.seq} className="flex items-baseline gap-2 border-b border-(--border) py-1.5 last:border-0">
                      <span className="mono w-[64px] shrink-0 text-[11px] text-(--text-faint)" title={e.at}>
                        {new Date(e.at).toLocaleTimeString([], { hour12: false })}
                      </span>
                      <span className="shrink-0 font-medium">
                        <span className="text-(--text-dim)">{e.from_state ?? "·"}</span>
                        <span className="mx-1 text-(--text-faint)">→</span>
                        <StateBadge state={e.to_state} />
                      </span>
                      <span className="truncate text-[11.5px] text-(--text-faint)">
                        <ActorRef actor={e.actor} className="text-[11.5px] mono rounded bg-(--surface-1) px-1.5 py-0.5 border border-(--border)" />
                        {e.reason ? <span className="ml-1 text-(--text-dim)">· {e.reason}</span> : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>

              {d.attempts.length > 0 && (
                <Section title="Attempts">
                  {d.attempts.map((a) => (
                    <div key={a.attempt} className="mb-1 rounded-md border border-(--border) bg-(--surface-0) px-3 py-2 text-[12px]">
                      <div className="flex justify-between font-medium">
                        <span className="mono text-(--text)">#{a.attempt}</span>
                        <span className="text-(--text-dim)">{a.terminal_state ?? "in flight"}</span>
                      </div>
                      <div className="mono truncate text-[11px] text-(--text-faint) mt-0.5">
                        {a.reason_code ?? ""} {a.workspace_path ?? ""}
                      </div>
                      <div className="flex items-baseline gap-1.5 truncate text-[11px] text-(--text-faint) mt-1">
                        <span className="uppercase text-[10px] tracking-wider text-(--text-faint)">owner</span>
                        {a.lease_owner ? (
                          <ActorRef actor={a.lease_owner} className="mono rounded bg-(--surface-1) px-1.5 py-0.5 border border-(--border) text-[11px]" />
                        ) : (
                          <span className="mono text-(--text-faint)">unclaimed</span>
                        )}
                      </div>
                    </div>
                  ))}
                </Section>
              )}

              {d.result && (
                <Section title={`Result · ${d.result.terminalState}${d.result.reasonCode ? ` · ${d.result.reasonCode}` : ""}`}>
                  {d.result.artifact !== undefined ? (
                    <Disclosure label="artifact" defaultOpen>
                      <JsonBlock value={d.result.artifact} />
                    </Disclosure>
                  ) : (
                    <Disclosure label="result" defaultOpen>
                      <JsonBlock value={d.result} />
                    </Disclosure>
                  )}
                  {d.result.evidence !== undefined && (
                    <Disclosure label="evidence — what the agent claims it verified">
                      <JsonBlock value={d.result.evidence} />
                    </Disclosure>
                  )}
                </Section>
              )}

              {d.result && (
                <Section title="Artifacts">
                  {(d.result.artifacts ?? []).length === 0 ? (
                    <div className="text-(--text-faint)">No stored artifacts.</div>
                  ) : (
                    <div className="rounded-md border border-(--border) px-3 py-1">
                      {(d.result.artifacts ?? []).map((a) => (
                        <ArtifactRow key={a.sha256} a={a} />
                      ))}
                    </div>
                  )}
                </Section>
              )}

              {d.receipt && (
                <Section title="Receipt">
                  {Object.entries(d.receipt).map(([k, v]) => (
                    <KV key={k} k={k} v={v} />
                  ))}
                </Section>
              )}
            </aside>
          </div>
          </>
        )}
      </div>

      {confirm === "cancel" && d && (
        <Dialog title={`Cancel ${d.run.runId}?`} onClose={() => setConfirm(null)}>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            {d.run.state === "RUNNING"
              ? "The running attempt is stopped with TERM, then KILL, and terminates as cancelled."
              : "The run is cancelled before execution; the operator is recorded as actor."}
          </div>
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
