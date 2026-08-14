import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, artifactUrl } from "../api";
import { hashPath } from "../hash";
import { dur } from "../heartbeat";
import { useListKeys, useNow, useTabKeys } from "../hooks";
import { setContextActions } from "../palette";
import { RunTrace } from "../components/RunTrace";
import { readPinnedRuns, savePinnedRuns } from "../components/ContextTabs";
import type { OperatorContext } from "../context";
import { matchesInFlight, matchesRepo } from "../context";
import { RUN_FACETS, matchesFilterQuery, parseFilterQuery } from "../filterQuery";
import { decideRevealFilters, formatRevealNotification } from "../reveal";
import type { Attempt, ArtifactRef, LifecycleEvent, RunListItem, RunState } from "../types";
import {
  Ago,
  Button,
  Dialog,
  Disclosure,
  FilterInput,
  ListPane,
  DetailPane,
  humanSize,
  JsonBlock,
  JumpLink,
  KV,
  ListEmpty,
  notify,
  Section,
  StateBadge,
  VerbError,
  copyText,
  copyLink,
} from "../components/ui";

const STATE_TABS: (RunState | "ALL")[] = [
  "ALL", "QUEUED", "LEASED", "RUNNING", "VERIFYING", "COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED",
];
export const TERMINAL: RunState[] = ["COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED"];
export const isCancellable = (state: RunState) => !TERMINAL.includes(state) && state !== "VERIFYING";

/**
 * The two states `reapExpiredLeases` sweeps (lib/worker.mjs) — so exactly the
 * states where the current attempt is racing a deadline. A VERIFYING run has
 * already exited its agent and is never reaped, so it has no clock to show.
 */
const IN_FLIGHT: RunState[] = ["LEASED", "RUNNING"];


/** `off`: no deadline running yet. `spent`: the deadline passed; the runtime has not caught up. */
type Clock = { kind: "off" } | { kind: "live"; leftMs: number } | { kind: "spent" };

/** A deadline we cannot read is no deadline: better silent than counting down to NaN. */
const clockTo = (iso: string, offsetMs: number, now: number): Clock => {
  const deadline = Date.parse(iso) + offsetMs;
  if (Number.isNaN(deadline)) return { kind: "off" };
  // Whole seconds, rounded up: the last fraction of a second reads 0:01, so
  // only a genuinely spent deadline reads `spent`.
  const left = Math.ceil((deadline - now) / 1000) * 1000;
  return left <= 0 ? { kind: "spent" } : { kind: "live", leftMs: left };
};

/**
 * The two deadlines an in-flight attempt is racing, both from what the API
 * already serves:
 *
 * - the agent's budget — the worker hands `spec.timeoutSeconds` to the adapter
 *   when it starts the attempt and records TIMED_OUT if the child outlives it,
 *   so the deadline is `started_at + timeoutSeconds`, a shade early because
 *   workspace setup happens between the two;
 * - the lease — minted once at claim for the budget plus a fixed grace and
 *   never renewed, so when it passes `reapExpiredLeases` re-queues the run
 *   whatever the worker believes it is doing.
 */
function deadlinesOf(a: Attempt, timeoutSeconds: number, now: number): { timeout: Clock; lease: Clock } {
  return {
    timeout: a.started_at ? clockTo(a.started_at, timeoutSeconds * 1000, now) : { kind: "off" },
    lease: a.lease_expires_at ? clockTo(a.lease_expires_at, 0, now) : { kind: "off" },
  };
}

/** One hue per clock, so the countdown and the meter never disagree. */
const budgetHue = (c: Clock, timeoutSeconds: number): string | undefined => {
  if (c.kind === "spent") return "var(--hue-err)";
  // The last tenth of the declared budget — long enough to notice on a long run.
  if (c.kind === "live" && c.leftMs <= timeoutSeconds * 100) return "var(--hue-warn)";
  return undefined;
};

/**
 * How long this agent has left before the worker stops it. The arithmetic is
 * local and the verdict stays the runtime's: a spent budget says so rather than
 * claiming the run is TIMED_OUT, which is the state badge's call on the next poll.
 */
function BudgetClock({ c, timeoutSeconds }: { c: Clock; timeoutSeconds: number }) {
  const budget = `${timeoutSeconds}s budget`;
  if (c.kind === "off")
    return (
      <span className="text-(--text-faint)" title={`${budget}, not started`}>
        {budget}, not started
      </span>
    );
  const hue = budgetHue(c, timeoutSeconds);
  if (c.kind === "spent")
    return (
      <span style={{ color: hue }} title="budget spent">
        budget spent
      </span>
    );
  return (
    <span style={{ color: hue }} title={`timeout in ${dur(c.leftMs)}`}>
      timeout in {dur(c.leftMs)}
    </span>
  );
}

function LeaseClock({ c, urgent }: { c: Clock; urgent: boolean }) {
  if (c.kind === "off") return <span title="no lease">no lease</span>;
  if (c.kind === "spent")
    return (
      <span style={{ color: "var(--hue-err)" }} title="reap due">
        reap due
      </span>
    );
  return (
    <span style={urgent ? { color: "var(--hue-warn)" } : undefined} title={`reaped in ${dur(c.leftMs)}`}>
      reaped in {dur(c.leftMs)}
    </span>
  );
}

/** How much of the budget is spent — the glance; `BudgetClock` is the number. */
function BudgetMeter({ c, timeoutSeconds }: { c: Clock; timeoutSeconds: number }) {
  if (c.kind === "off" || timeoutSeconds <= 0) return null;
  const spent = c.kind === "spent" ? 1 : 1 - c.leftMs / (timeoutSeconds * 1000);
  return (
    <div className="mt-2 h-1 overflow-hidden rounded-full bg-(--surface-2)" aria-hidden="true">
      <div
        className="h-full rounded-full transition-[width,background-color] duration-1000 ease-linear"
        style={{
          width: `${Math.min(100, Math.max(2, spent * 100))}%`,
          background: budgetHue(c, timeoutSeconds) ?? "var(--hue-ok)",
        }}
      />
    </div>
  );
}

function RowDeadlines({ r, now }: { r: RunListItem; now: number }) {
  const { startedAt, leaseExpiresAt, timeoutSeconds = 0 } = r as { startedAt?: string | null; leaseExpiresAt?: string | null; timeoutSeconds?: number };
  const t = startedAt && timeoutSeconds > 0 ? clockTo(startedAt, timeoutSeconds * 1000, now) : null;
  const l = leaseExpiresAt ? clockTo(leaseExpiresAt, 0, now) : null;
  const hasT = t && t.kind !== "off";
  const hasL = l && l.kind !== "off";
  if (!hasT && !hasL) return null;
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] tabular-nums text-(--text-faint)">
      {hasT && <BudgetClock c={t} timeoutSeconds={timeoutSeconds} />}
      {hasT && hasL && <span>·</span>}
      {hasL && <LeaseClock c={l} urgent={t?.kind === "spent"} />}
    </div>
  );
}

/** Terminal states whose reason is a failure the operator reads first (WM-93). */
const ERROR_STATES: RunState[] = ["FAILED", "TIMED_OUT", "REFUSED"];

/**
 * Why the run ended badly, surfaced first (WM-93): a FAILED/TIMED_OUT/REFUSED
 * run's reason used to live only in the last LIFECYCLE row, below the spec
 * JSON. Derived from the same lifecycle data the LIFECYCLE section renders —
 * the last transition into the current terminal state — no new API surface.
 * Renders nothing for any other state.
 */
export function RunFailureBanner({
  state,
  lifecycle,
  className = "mb-4",
}: {
  state: RunState;
  lifecycle: LifecycleEvent[];
  className?: string;
}) {
  if (!ERROR_STATES.includes(state)) return null;
  const terminal = [...lifecycle].reverse().find((e) => e.to_state === state);
  const reason = terminal?.reason ?? null;
  const hue = state === "REFUSED" ? "var(--hue-warn)" : "var(--hue-err)";
  return (
    <div
      role="alert"
      className={`rounded-md border px-3 py-2 ${className}`}
      style={{ borderColor: hue, background: `color-mix(in oklch, ${hue} 8%, transparent)` }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-medium tracking-wider uppercase" style={{ color: hue }}>
          {state}
        </span>
        {reason && (
          <button
            type="button"
            onClick={() => copyText(reason, "failure reason")}
            className="shrink-0 text-[12px] text-(--text-dim) hover:text-(--accent)"
          >
            Copy reason
          </button>
        )}
      </div>
      {/* Full string, wrapping allowed — never truncate the one line that explains the failure. */}
      <div className="mono mt-1 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-(--text)">
        {reason ?? "No reason recorded on the terminal transition."}
      </div>
    </div>
  );
}

const rowWash = (s: string) =>
  s === "FAILED" || s === "TIMED_OUT" ? "row-wash-err" : s === "REFUSED" ? "row-wash-warn" : "";

export function ActorRef({ actor, className }: { actor: string; className?: string }) {
  if (!/^worker_.+/.test(actor)) return <>{actor}</>;
  return (
    <JumpLink
      onClick={() => {
        window.location.hash = `#/${hashPath("workers", actor)}`;
      }}
      title={actor}
      className={className}
    >
      {actor}
    </JumpLink>
  );
}

const isTextArtifact = (k: string) =>
  /^(transcript|diff|report|evidence)$/i.test(k) || /\.(txt|json|jsonl|md|log)$/i.test(k);

export function ArtifactRow({ a }: { a: ArtifactRef }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textFriendly = isTextArtifact(a.kind);

  const togglePreview = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (content === null && !loading) {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(artifactUrl(a.sha256));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const txt = await res.text();
        setContent(txt);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="border-b border-(--border) py-1.5 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate">
          {a.kind}
          <span className="mono ml-2 text-[11px] text-(--text-faint)" title={a.sha256}>
            {a.sha256.slice(0, 12)}
          </span>
        </span>
        <span className="flex shrink-0 items-baseline gap-3">
          <span className="tabular-nums text-(--text-faint)">{humanSize(a.sizeBytes)}</span>
          {textFriendly && (
            <button
              type="button"
              onClick={togglePreview}
              className="text-[12px] text-(--text-dim) hover:text-(--accent)"
            >
              {open ? "Hide" : "Preview"}
            </button>
          )}
          <a
            href={artifactUrl(a.sha256, a.kind)}
            target="_blank"
            rel="noreferrer"
            className="text-(--accent) hover:underline"
          >
            Open
          </a>
        </span>
      </div>
      {open && (
        <div className="mt-2">
          {loading && <div className="text-[11px] text-(--text-faint)">Loading artifact preview…</div>}
          {error && (
            <div className="text-[11px]" style={{ color: "var(--hue-err)" }}>
              Failed to load preview: {error}
            </div>
          )}
          {content !== null && (
            <pre className="mono max-h-64 overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-2.5 text-[11.5px] leading-relaxed whitespace-pre-wrap">
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Runs (webui spec §4.3): state tabs, lifecycle timeline, guarded verbs. */
export function Runs({
  connected,
  context,
  focusRunId,
  onSelectRun,
  onOpenFull,
  focusState,
  onFocusStateConsumed,
  onJumpAgent,
  onJumpEvent,
  rejumpEpoch,
}: {
  connected: boolean;
  context: OperatorContext;
  focusRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  onOpenFull: (runId: string) => void;
  focusState: string | null;
  onFocusStateConsumed: () => void;
  onJumpAgent: (ref: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  rejumpEpoch?: number;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof STATE_TABS)[number]>("ALL");
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState<"cancel" | "force-retry" | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  // A project / In-flight filter is client-side; fetching only the active
  // status tab would make every other tab's badge a factory-wide lie.
  const fetchAll = context.kind !== "all";
  const list = useQuery({
    queryKey: ["runs", fetchAll ? "ALL" : tab],
    queryFn: () => api.runs(fetchAll || tab === "ALL" ? undefined : tab),
    refetchInterval: 2000,
  });
  const statusQ = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const rows = list.data?.runs ?? [];
  const scoped = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.runId === focusRunId ||
          (matchesRepo(r.repos, context) && matchesInFlight(r.state, context)),
      ),
    [rows, context, focusRunId],
  );
  const byTab = useMemo(
    () => (!fetchAll || tab === "ALL" ? scoped : scoped.filter((r) => r.state === tab)),
    [fetchAll, scoped, tab],
  );
  // `is:stale` is the doctor's projection, not a guess this view makes: a run
  // held by a worker whose heartbeat has gone (lib/workers.mjs stalledWorkers).
  const staleRuns = useMemo(
    () => new Set((statusQ.data?.anomalies.stalledWorkers ?? []).map((w) => w.runId)),
    [statusQ.data],
  );
  const parsed = useMemo(() => parseFilterQuery(filter, RUN_FACETS), [filter]);
  const visible = useMemo(
    () => byTab.filter((r) => matchesFilterQuery(r, parsed, RUN_FACETS, { staleRuns })),
    [byTab, parsed, staleRuns],
  );

  const selectedId = focusRunId;
  const selectedIndex = useMemo(() => visible.findIndex((r) => r.runId === selectedId), [visible, selectedId]);

  // Deep link / jump: switch to ALL if the run isn't on this tab. Hash stays put.
  // Reveal (clear filter) once per focus id, after the run is on the tab so a
  // late arrival still surfaces. Typing a filter does not re-reveal.
  // Under `fetchAll` the list carries every state, so presence in `rows` says
  // nothing about the tab — the tab has to be part of the membership test, or
  // the switch to ALL never fires and the row stays unrendered.
  const pendingReveal = useRef<{
    key: string;
    snapshot: { filter: string };
  } | null>(null);
  const lastKey = useRef<string | null>(null);
  const lastRejump = useRef<number | undefined>(rejumpEpoch);
  const tabChangedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusRunId) {
      pendingReveal.current = null;
      lastKey.current = null;
      lastRejump.current = rejumpEpoch;
      tabChangedFor.current = null;
      return;
    }

    const isNewKey = focusRunId !== lastKey.current;
    const isRejump = rejumpEpoch !== lastRejump.current;
    lastKey.current = focusRunId;
    lastRejump.current = rejumpEpoch;

    if (isNewKey || isRejump) {
      pendingReveal.current = {
        key: focusRunId,
        snapshot: { filter },
      };
    }

    const onTab = rows.some(
      (r) => r.runId === focusRunId && (!fetchAll || tab === "ALL" || r.state === tab),
    );
    if (onTab) {
      const latch = pendingReveal.current;
      if (latch && latch.key === focusRunId) {
        pendingReveal.current = null; // decided once
        const isVisible = visible.some((r) => r.runId === focusRunId);
        const currentFilters = { filter };
        const emptyFilters = { filter: "" };
        const decision = decideRevealFilters(latch.snapshot, currentFilters, emptyFilters, isVisible);
        if (decision.cleared) {
          setFilter(decision.next.filter);
        }
        const tabChanged = tabChangedFor.current === focusRunId;
        tabChangedFor.current = null;
        if (tabChanged || decision.cleared) {
          const row = rows.find((r) => r.runId === focusRunId);
          const msg = formatRevealNotification({
            kind: "run",
            id: focusRunId,
            state: row?.state,
            tabChanged,
            filterCleared: decision.cleared,
          });
          if (msg) notify(msg, "info");
        }
      }
      return;
    }
    if (tab !== "ALL") {
      tabChangedFor.current = focusRunId;
      setTab("ALL");
    }
  }, [focusRunId, rejumpEpoch, rows, tab, visible, fetchAll, filter]);

  useEffect(() => {
    if (focusState && (STATE_TABS as readonly string[]).includes(focusState)) {
      setTab(focusState as (typeof STATE_TABS)[number]);
      onFocusStateConsumed();
    } else if (focusState) {
      onFocusStateConsumed();
    }
  }, [focusState, onFocusStateConsumed]);

  // In flight is LEASED+RUNNING; a COMPLETED (etc.) status tab would be empty.
  useEffect(() => {
    if (context.kind !== "inflight") return;
    setTab((t) => (t === "LEASED" || t === "RUNNING" || t === "ALL" ? t : "ALL"));
  }, [context.kind]);

  const sel = selectedIndex >= 0 ? visible[selectedIndex] : null;

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const detail = useQuery({
    queryKey: ["run", selectedId],
    queryFn: () => api.run(selectedId as string),
    enabled: sel !== null,
    refetchInterval: 2000,
  });

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

  const selectTab = (t: (typeof STATE_TABS)[number]) => {
    setTab(t);
    if (selectedId) onSelectRun(null);
  };
  useTabKeys(STATE_TABS, tab, selectTab);

  useListKeys({
    count: visible.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectRun(visible[i]?.runId ?? null),
    // §5 "Enter/o — open detail": selection already opens the panel, so the
    // open verb graduates to the full-page run view (`g o` is safe — list
    // verbs stand down while the chord prefix is armed, hooks.ts).
    onOpen: () => sel && onOpenFull(sel.runId),
    onClose: () => {
      if (selectedId) onSelectRun(null);
      else if (filter) setFilter("");
    },
    keys: {
      // §5 convention: `x` is the destructive verb on the selection — here, cancel.
      x: () => sel && connected && isCancellable(sel.state) && setConfirm("cancel"),
      c: () => sel && copyText(sel.runId, "run id"),
    },
  });

  const d = detail.data;
  const attemptsExhausted = d ? d.run.attempts >= d.run.spec.maxAttempts : false;

  // The reaper keys off the run's current attempt (`a.attempt = r.attempts`),
  // so that is the only attempt whose deadlines are still running.
  const current =
    d && IN_FLIGHT.includes(d.run.state)
      ? (d.attempts.find((a) => a.attempt === d.run.attempts) ?? null)
      : null;
  const clocks = d && current ? deadlinesOf(current, d.run.spec.timeoutSeconds, now) : null;

  const pinRun = (id: string) => {
    const cur = readPinnedRuns();
    if (!cur.includes(id)) {
      savePinnedRuns([...cur, id]);
      notify(`Pinned ${id}`, "ok");
    } else {
      notify("Already pinned", "info");
    }
  };

  // Offer the selection's verbs in the ⌘K palette (§5).
  useEffect(() => {
    if (!sel) {
      setContextActions([]);
    } else {
      const copy = [
        { label: "Open in tab", run: () => pinRun(sel.runId) },
        { label: "Open full view", hint: "o", run: () => onOpenFull(sel.runId) },
        { label: "Copy run id", hint: "c", run: () => copyText(sel.runId, "run id") },
        { label: "Copy link", run: copyLink },
      ];
      if (!d || !connected) {
        setContextActions(copy);
      } else {
        setContextActions([
          ...(isCancellable(d.run.state)
            ? [{ label: "Cancel run…", hint: "x", run: () => setConfirm("cancel") }]
            : []),
          ...(d.run.state === "FAILED"
            ? [
                attemptsExhausted
                  ? { label: "Force retry run…", run: () => setConfirm("force-retry") }
                  : { label: "Retry run", run: () => retry.mutate({ id: d.run.runId, force: false }) },
              ]
            : []),
          ...copy,
        ]);
      }
    }
    return () => setContextActions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.runId, d?.run.runId, d?.run.state, attemptsExhausted, connected]);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
        <h1 className="display mb-4 text-lg font-semibold">Runs</h1>

        {/* `flex-wrap`: the token chips are a full-width item, so they take
            their own line under the tabs and the box instead of squeezing them. */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist" aria-label="Run state">
            {STATE_TABS.map((t) => {
              const byState = statusQ.data?.runs.byState ?? {};
              const count = fetchAll
                ? t === "ALL"
                  ? scoped.length
                  : scoped.filter((r) => r.state === t).length
                : t === "ALL"
                  ? Object.values(byState).reduce((n, v) => n + (v ?? 0), 0)
                  : (byState[t] ?? 0);
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => selectTab(t)}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium ${
                    tab === t ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
                  }`}
                >
                  {t === "ALL" ? "All" : t}
                  {count > 0 && <span className="ml-1.5 tabular-nums text-(--text-faint)">{count}</span>}
                </button>
              );
            })}
          </div>
          <FilterInput
            value={filter}
            onChange={setFilter}
            placeholder="agent:… state:… is:stale"
            label="Filter runs"
            query={parsed}
          />
        </div>
          </>
        }
      >

        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              {["Run", "State", "Agent", "Adapter", "Attempts", "Reason", "Origin", "Updated"].map((h) => (
                <th key={h} className="sticky top-0 z-10 bg-(--surface-0) border-b border-(--border) px-3 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr
                key={r.runId}
                onClick={() => onSelectRun(r.runId)}
                aria-selected={i === selectedIndex}
                className={`cursor-pointer hover:bg-(--surface-1) ${rowWash(r.state)} ${i === selectedIndex ? "row-selected" : ""}`}
              >
                <td className="mono max-w-52 truncate border-b border-(--border) px-3 py-1.5">{r.runId}</td>
                <td className="border-b border-(--border) px-3 py-1.5">
                  <StateBadge state={r.state} />
                  {IN_FLIGHT.includes(r.state) && <RowDeadlines r={r} now={now} />}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-dim)">
                  <JumpLink
                    onClick={() => onJumpAgent(r.agent)}
                    title={`Open ${r.agent} in Agents`}
                  >
                    {r.agent}
                  </JumpLink>
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">{r.adapter}</td>
                <td className="border-b border-(--border) px-3 py-1.5 tabular-nums text-(--text-dim)">
                  {r.attempts}/{r.maxAttempts}
                </td>
                <td className="mono max-w-36 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  {r.reasonCode ?? "-"}
                </td>
                <td className="mono max-w-40 truncate border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  {r.eventId && r.eventSource ? (
                    <JumpLink onClick={() => onJumpEvent(r.eventSource!, r.eventId!)} title="Open origin event">
                      {r.eventId}
                    </JumpLink>
                  ) : (
                    (r.eventId ?? "-")
                  )}
                </td>
                <td className="border-b border-(--border) px-3 py-1.5 text-(--text-faint)">
                  <Ago iso={r.updated_at} now={now} />
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={8}
                query={list}
                filtered={scoped.length > 0}
                noun="runs"
                empty={
                  context.kind === "inflight"
                    ? "No runs in flight."
                    : context.kind === "repo"
                      ? `No runs for ${context.name}.`
                      : tab === "ALL"
                        ? "No runs."
                        : `No ${tab} runs.`
                }
                action={
                  // Only In flight can strand an operator with no way back but the
                  // context strip's All tab — offer the same exit inline (WM-91).
                  context.kind === "inflight" ? (
                    <Button
                      onClick={() => {
                        if (typeof window !== "undefined") window.location.hash = "#/runs";
                      }}
                    >
                      Show all runs
                    </Button>
                  ) : undefined
                }
              />
            )}
          </tbody>
        </table>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[460px]"
          title={
            <span className="flex min-w-0 items-center gap-2">
              <StateBadge state={sel.state} />
              <JumpLink
                onClick={() => onOpenFull(sel.runId)}
                title={`Open ${sel.runId}`}
                className="truncate"
              >
                {sel.runId}
              </JumpLink>
            </span>
          }
          actions={
            <>
              <Button onClick={() => pinRun(sel.runId)}>Open in tab</Button>
              <Button onClick={() => onOpenFull(sel.runId)}>
                Expand <span className="mono ml-1 opacity-70">o</span>
              </Button>
              <Button onClick={() => copyText(sel.runId, "run id")}>Copy id</Button>
              <Button onClick={() => copyText(`bun event-runtime/cli.mjs inspect ${sel.runId}`, "CLI inspect command")}>
                Copy CLI
              </Button>
              <Button onClick={copyLink}>Copy link</Button>
              <Button onClick={() => onSelectRun(null)}>Close</Button>
            </>
          }
        >

          {!d && (
            <div className="text-(--text-faint)">{detail.isError ? "Could not load run detail." : "Loading run…"}</div>
          )}

          {d && (
            <>
          <RunFailureBanner state={d.run.state} lifecycle={d.lifecycle} />

          <Section title="Run">
            <KV k="run" v={d.run.runId} />
            <KV
              k="agent"
              v={
                <JumpLink
                  onClick={() => onJumpAgent(d.run.spec.agent)}
                  title={`Open ${d.run.spec.agent} in Agents`}
                >
                  {d.run.spec.agent}
                </JumpLink>
              }
            />
            <KV k="adapter" v={d.run.spec.adapter} />
            <KV k="attempts" v={`${d.run.attempts}/${d.run.spec.maxAttempts}`} />
            {sel.eventId && (
              <KV
                k="origin event"
                v={
                  sel.eventSource ? (
                    <JumpLink
                      onClick={() => onJumpEvent(sel.eventSource!, sel.eventId!)}
                      title="Open origin event"
                    >
                      {`${sel.eventSource} · ${sel.eventId}`}
                    </JumpLink>
                  ) : (
                    `${sel.eventSource ?? "?"} · ${sel.eventId}`
                  )
                }
              />
            )}
            <KV k="idempotencyKey" v={d.run.idempotencyKey} />
            <KV k="specHash" v={d.run.specHash} />
            <KV k="workspace" v={d.workspace} />
            <KV k="created" v={<Ago iso={d.run.created_at} now={now} />} />
            <KV k="updated" v={<Ago iso={d.run.updated_at} now={now} />} />
            <KV k="placement" v={d.run.spec.placement ? JSON.stringify(d.run.spec.placement) : "any worker"} />
            <Disclosure label="immutable RunSpec" defaultOpen>
              <JsonBlock value={d.run.spec} />
            </Disclosure>
          </Section>

          {/* What a live run is racing, above the verbs: cancelling is the
              answer to a budget about to be spent on a hung agent. */}
          {current && clocks && (
            <Section title="Deadlines">
              <div className="rounded-md border border-(--border) px-3 py-2 tabular-nums" aria-live="off">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-(--text-faint)">
                    attempt #{current.attempt}{" "}
                    {current.started_at ? (
                      <>
                        started <Ago iso={current.started_at} now={now} className="text-(--text-dim)" />
                      </>
                    ) : (
                      "not started"
                    )}
                  </span>
                  <BudgetClock c={clocks.timeout} timeoutSeconds={d.run.spec.timeoutSeconds} />
                </div>
                <BudgetMeter c={clocks.timeout} timeoutSeconds={d.run.spec.timeoutSeconds} />
                <div className="mt-2 flex items-baseline justify-between gap-4 text-[11px] text-(--text-faint)">
                  <span className="flex items-baseline gap-1.5 truncate">
                    lease owner
                    {current.lease_owner ? (
                      <ActorRef actor={current.lease_owner} />
                    ) : (
                      <span className="mono">unclaimed</span>
                    )}
                  </span>
                  <LeaseClock c={clocks.lease} urgent={clocks.timeout.kind === "spent"} />
                </div>
                <div className="mt-2 text-[11px] text-(--text-faint)">
                  The lease outlasts the budget by a fixed grace and is never renewed.
                </div>
              </div>
            </Section>
          )}

          <div className="mb-4 flex gap-2">
            {isCancellable(d.run.state) && (
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

          <Section title="Lifecycle">
            <div className="rounded-md border border-(--border) px-3 py-1">
              {d.lifecycle.map((e) => (
                <div key={e.seq} className="flex items-baseline gap-2 border-b border-(--border) py-1.5 last:border-0">
                  <span className="mono w-[64px] shrink-0 text-(--text-faint)" title={e.at}>
                    {new Date(e.at).toLocaleTimeString([], { hour12: false })}
                  </span>
                  <span className="shrink-0">
                    {e.from_state ?? "·"} → <StateBadge state={e.to_state} />
                  </span>
                  <span className="truncate text-(--text-faint)">
                    <ActorRef actor={e.actor} className="text-[13px]" />
                    {e.reason ? ` · ${e.reason}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </Section>

          {/* key: a run switch must reset the feed's cursor and scroll state. */}
          <RunTrace
            key={d.run.runId}
            runId={d.run.runId}
            state={d.run.state}
            onExpand={() => onOpenFull(d.run.runId)}
          />

          {d.attempts.length > 0 && (
            <Section title="Attempts">
              {d.attempts.map((a) => (
                <div key={a.attempt} className="mb-1 rounded-md border border-(--border) px-3 py-1.5">
                  <div className="flex justify-between">
                    <span>#{a.attempt}</span>
                    <span className="text-(--text-dim)">{a.terminal_state ?? "in flight"}</span>
                  </div>
                  <div className="mono truncate text-[11px] text-(--text-faint)">
                    {a.reason_code ?? ""} {a.workspace_path ?? ""}
                  </div>
                  <div className="flex items-baseline gap-1.5 truncate text-[11px] text-(--text-faint)">
                    <span>owner</span>
                    {a.lease_owner ? <ActorRef actor={a.lease_owner} /> : <span className="mono">unclaimed</span>}
                  </div>
                  {(a.started_at || a.finished_at) && (
                    <div className="mt-1 flex gap-3 text-[11px] text-(--text-faint)">
                      {a.started_at && (
                        <span>
                          started <Ago iso={a.started_at} now={now} />
                        </span>
                      )}
                      {a.finished_at && (
                        <span>
                          finished <Ago iso={a.finished_at} now={now} />
                        </span>
                      )}
                    </div>
                  )}
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
            </>
          )}
        </DetailPane>
      )}

      {confirm === "cancel" && d && (
        <Dialog title={`Cancel ${d.run.runId}?`} onClose={() => setConfirm(null)}>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            {d.run.state === "RUNNING"
              ? "Running attempt is stopped with TERM/KILL and cancelled."
              : "Run is cancelled before execution."}
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
        <Dialog title="Retry past attempt budget?" onClose={() => setConfirm(null)}>
          <div className="mb-3 text-[12px] text-(--text-dim)">
            Used {d.run.attempts}/{d.run.spec.maxAttempts} attempts. Forcing retry is recorded as an operator override.
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
