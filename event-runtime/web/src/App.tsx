import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { api } from "./api";
import { ContextTabs } from "./components/ContextTabs";
import {
  CONTEXT_STORAGE_KEY,
  contextFromProject,
  projectFromContext,
  readContextTabs,
  rememberOpenRepo,
  type OperatorContext,
} from "./context";
import { artifactsHash, eventsHash, hashPath, hashProject, hashSearch, withProject } from "./hash";
import { keyGuard, THEMES, useHashRoute, useTheme, type Theme } from "./hooks";
import { goPrefixActive } from "./goSequence";
import type { EventFocus } from "./types";
import { CommandPalette, useGoSequences, type PaletteAction } from "./components/CommandPalette";
import { ToastContainer, copyLink, copyText } from "./components/ui";
import type { ArtifactFilters } from "./views/Artifacts";
import { Events } from "./views/Events";
import { Overview } from "./views/Overview";
import { Runs } from "./views/Runs";
import { NAV, type NavKey } from "./nav";

type WorkerHealthFilter = "live" | "busy" | "stale";
const isWorkerHealthFilter = (value: string | null): value is WorkerHealthFilter =>
  value === "live" || value === "busy" || value === "stale";

type NavBadge = {
  count: number;
  hue: string;
  word?: string;
  title?: string;
};

const Artifacts = lazy(() => import("./views/Artifacts").then((m) => ({ default: m.Artifacts })));
const Graph = lazy(() => import("./views/Graph").then((m) => ({ default: m.Graph })));
const Chain = lazy(() => import("./views/Chain").then((m) => ({ default: m.Chain })));
const Projects = lazy(() => import("./views/Projects").then((m) => ({ default: m.Projects })));
const Schedules = lazy(() => import("./views/Schedules").then((m) => ({ default: m.Schedules })));
const Proposals = lazy(() => import("./views/Proposals").then((m) => ({ default: m.Proposals })));
const Agents = lazy(() => import("./views/Agents").then((m) => ({ default: m.Agents })));
const RunFull = lazy(() => import("./views/RunFull").then((m) => ({ default: m.RunFull })));
const Workers = lazy(() => import("./views/Workers").then((m) => ({ default: m.Workers })));
const ShortcutsDialog = lazy(() =>
  import("./components/ShortcutsDialog").then((m) => ({ default: m.ShortcutsDialog })),
);
const InjectDialog = lazy(() =>
  import("./components/InjectDialog").then((m) => ({ default: m.InjectDialog })),
);

export function App() {
  const [route, navigateRaw] = useHashRoute();
  const view = route[0];
  const project = hashProject(window.location.hash);
  const context = contextFromProject(project);
  const [openRepos, setOpenRepos] = useState<string[]>(() => {
    try {
      return readContextTabs(sessionStorage.getItem(CONTEXT_STORAGE_KEY)).openRepos;
    } catch {
      return [];
    }
  });
  const navigate = useCallback(
    (path: string) => navigateRaw(withProject(path, hashProject(window.location.hash))),
    [navigateRaw],
  );
  const hashPathNow = () => window.location.hash.replace(/^#\/?/, "") || "overview";
  const selectContext = useCallback(
    (next: OperatorContext) => {
      const nextProject = projectFromContext(next);
      if (next.kind === "inflight" && view !== "runs") {
        navigateRaw(withProject("runs", nextProject));
        return;
      }
      navigateRaw(withProject(hashPathNow(), nextProject));
    },
    [navigateRaw, view],
  );
  const openRepo = (name: string) => {
    setOpenRepos((prev) => rememberOpenRepo(prev, name));
    navigateRaw(withProject(hashPathNow(), name));
  };
  const closeRepo = (name: string) => {
    setOpenRepos((prev) => prev.filter((n) => n !== name));
    if (context.kind === "repo" && context.name === name) {
      navigateRaw(withProject(hashPathNow(), null));
    }
  };

  const reposQ = useQuery({ queryKey: ["repos"], queryFn: api.repos, refetchInterval: 30_000 });

  useEffect(() => {
    if (!project || project === "all" || project === "inflight") return;
    setOpenRepos((prev) => rememberOpenRepo(prev, project));
  }, [project]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        CONTEXT_STORAGE_KEY,
        JSON.stringify({ openRepos, active: project ?? "all" }),
      );
    } catch {
      // Private mode / blocked storage: the strip still works for this load.
    }
  }, [openRepos, project]);

  const [theme, cycleTheme] = useTheme();
  const [injectOpen, setInjectOpen] = useState(false);
  const [injectSeed, setInjectSeed] = useState<Record<string, unknown> | undefined>(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  const [focusRunState, setFocusRunState] = useState<string | null>(null);
  const [focusExpired, setFocusExpired] = useState(false);
  const [ephemeralEvent, setEphemeralEvent] = useState<EventFocus | null>(null);
  const [filterFocus, setFilterFocus] = useState(false);
  const [viewAnnouncement, setViewAnnouncement] = useState("");
  const mainRef = useRef<HTMLElement>(null);
  const previousViewRef = useRef(view);

  const focusRunId = view === "runs" ? (route[1] ?? null) : null;
  // `#/run/:id` is the full-page run view — a distinct first segment, so
  // crossing from `#/runs/:id` pushes history and Back restores the panel.
  const fullRunId = view === "run" ? (route[1] ?? null) : null;
  const focusProposalId = view === "proposals" ? (route[1] ?? null) : null;
  const focusRepoName = view === "projects" ? (route[1] ?? null) : null;
  const focusAgentRef = view === "agents" ? (route[1] ?? null) : null;
  const focusScheduleLoop = view === "schedules" ? (route[1] ?? null) : null;
  const focusWorkerId = view === "workers" ? (route[1] ?? null) : null;
  const workerHealthFromHash = view === "workers" ? hashSearch(window.location.hash).get("health") : null;
  const focusWorkerHealth = isWorkerHealthFilter(workerHealthFromHash) ? workerHealthFromHash : null;
  const focusGraphNode = view === "graph" ? (route[1] ?? null) : null;
  // `#/chain/:correlationId[/:nodeId]` — the chain trace (WM-527); node
  // selection rides the hash so a pasted link lands on the same node.
  const chainId = view === "chain" ? (route[1] ?? null) : null;
  const focusChainNode = view === "chain" ? (route[2] ?? null) : null;
  const artifactQuery = hashSearch(window.location.hash);
  const artifactFilters: ArtifactFilters = {
    kind: view === "artifacts" ? artifactQuery.get("kind") : null,
    orphan:
      view !== "artifacts" || !artifactQuery.has("orphan")
        ? null
        : artifactQuery.get("orphan") === "true",
    search: view === "artifacts" ? (artifactQuery.get("search") ?? "") : "",
  };
  const hashEvent: EventFocus | null =
    view === "events" && route[1] && route[2]
      ? { source: route[1], eventId: route[2] }
      : null;
  const typeFromHash = view === "events" ? hashSearch(window.location.hash).get("type") : null;
  const focusEvent =
    view === "events"
      ? {
          ...(ephemeralEvent ?? {}),
          ...(typeFromHash ? { type: typeFromHash } : {}),
          ...(hashEvent ?? {}),
        }
      : null;
  const hasEventFocus =
    !!(focusEvent && (focusEvent.source || focusEvent.eventId || focusEvent.status || focusEvent.type));

  const [rejumpEpoch, setRejumpEpoch] = useState(0);

  const jumpToRun = (runId: string) => {
    setRejumpEpoch((n) => n + 1);
    navigate(hashPath("runs", runId));
  };
  const openRunFull = (runId: string) => navigate(hashPath("run", runId));
  const jumpToRuns = (state?: string) => {
    if (state) setFocusRunState(state);
    setRejumpEpoch((n) => n + 1);
    navigate("runs");
  };
  const jumpToProposal = (id: string) => {
    setRejumpEpoch((n) => n + 1);
    navigate(hashPath("proposals", id));
  };
  const jumpToEvent = (source: string, eventId: string, status?: string) => {
    setEphemeralEvent(status ? { status } : null);
    setRejumpEpoch((n) => n + 1);
    navigate(hashPath("events", source, eventId));
  };
  const jumpToEvents = (focus: EventFocus) => {
    setRejumpEpoch((n) => n + 1);
    if (focus.source && focus.eventId) {
      setEphemeralEvent(focus.status || focus.type ? { status: focus.status, type: focus.type } : null);
      navigate(hashPath("events", focus.source, focus.eventId));
      return;
    }
    if (focus.type) {
      setEphemeralEvent(focus.status ? { status: focus.status } : null);
      navigate(eventsHash(null, null, focus.type));
      return;
    }
    setEphemeralEvent(focus);
    navigate("events");
  };
  const jumpToAgent = (ref: string) => navigate(hashPath("agents", ref));
  const workerHash = (id: string | null, health: WorkerHealthFilter | null) => {
    const path = hashPath("workers", id);
    return health ? `${path}?health=${encodeURIComponent(health)}` : path;
  };
  const jumpToWorker = (id: string) => navigate(workerHash(id, null));
  const jumpToWorkers = (health: WorkerHealthFilter) => navigate(workerHash(null, health));
  const jumpToProject = (name: string) => navigate(hashPath("projects", name));
  const jumpToGraph = (nodeId?: string) => navigate(hashPath("graph", nodeId));
  const jumpToChain = (correlationId: string, nodeId?: string) =>
    navigate(hashPath("chain", correlationId, nodeId));

  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 2000,
    retry: false,
  });
  const connected = health.isSuccess;
  // Banner only after a failed fetch — first-load pending must not flash
  // "unreachable" over an empty factory.
  const healthFailed = !connected && !health.isPending;

  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const openProposals = status.data?.proposals.open ?? 0;
  const activeRuns = Object.entries(status.data?.runs.byState ?? {})
    .filter(([s]) => ["QUEUED", "LEASED", "RUNNING", "VERIFYING"].includes(s))
    .reduce((sum, [, n]) => sum + (n ?? 0), 0);
  const eventAttention =
    (status.data?.events.human_needed ?? 0) + (status.data?.events.dead_lettered ?? 0);
  const scopedNav = context.kind === "repo";
  const scopedRunsNav = context.kind !== "all";
  const busyWorkers = status.data?.workers.busy ?? 0;
  const staleWorkers = status.data?.workers.stale ?? 0;
  // null until the first status lands: reading "no workers" off a pending
  // fetch is the same false alarm as flashing "unreachable" on first load.
  const liveWorkers = status.data?.workers.live ?? null;
  const stoppedSchedulesCount =
    ((status.data?.anomalies as any)?.stoppedSchedules ?? []).length;

  // Workers is the one badge whose meaning can flip: a stale
  // heartbeat is a worker that is gone while claiming to work, so it
  // outranks the busy count. The word carries that — reading the
  // count off the tone alone fails in the contrast theme.
  const navBadges: Record<NavKey, NavBadge> = {
    overview: { count: 0, hue: "var(--accent)" },
    events: { count: scopedNav ? 0 : eventAttention, hue: "var(--accent)" },
    proposals: { count: scopedNav ? 0 : openProposals, hue: "var(--accent)" },
    runs: { count: scopedRunsNav ? 0 : activeRuns, hue: "var(--accent)" },
    projects: { count: 0, hue: "var(--accent)" },
    agents: { count: 0, hue: "var(--accent)" },
    artifacts: {
      count: status.data?.artifacts.orphans ?? 0,
      hue: "var(--hue-warn)",
      word: "orphan",
      title: `${status.data?.artifacts.orphans ?? 0} unreferenced artifact${status.data?.artifacts.orphans === 1 ? "" : "s"}`,
    },
    schedules:
      stoppedSchedulesCount > 0
        ? {
            count: stoppedSchedulesCount,
            hue: "var(--hue-err)",
            word: "stopped",
            title: `${stoppedSchedulesCount} scheduled loop${stoppedSchedulesCount === 1 ? "" : "s"} stopped or errored`,
          }
        : { count: 0, hue: "var(--accent)" },
    workers:
      staleWorkers > 0
        ? {
            count: staleWorkers,
            hue: "var(--hue-warn)",
            word: "stale",
            title: `${staleWorkers} worker${staleWorkers === 1 ? "" : "s"} whose heartbeat has gone stale`,
          }
        : {
            count: busyWorkers,
            hue: "var(--accent)",
            title: `${busyWorkers} worker${busyWorkers === 1 ? "" : "s"} busy`,
          },
    graph: { count: 0, hue: "var(--accent)" },
  };

  const env = health.data?.env;
  const envHue = !connected
    ? "var(--hue-err)"
    : env?.name === "live"
      ? "var(--hue-warn)"
      : "var(--hue-info)";
  const envLabel = !connected
    ? "disconnected"
    : env
      ? env.adapter
        ? `${env.name} · ${env.adapter}`
        : env.name
      : "…";

  const goArmed = useGoSequences(
    useMemo(() => {
      const map: Record<string, () => void> = Object.fromEntries(
        NAV.map((n) => [n.go, () => navigate(n.key)]),
      );
      map["0"] = () => selectContext({ kind: "all" });
      map["i"] = () => selectContext({ kind: "inflight" });
      openRepos.slice(0, 9).forEach((name, idx) => {
        map[String(idx + 1)] = () => selectContext({ kind: "repo", name });
      });
      return map;
    }, [navigate, selectContext, openRepos]),
  );

  const viewLabel =
    NAV.find((n) => n.key === view)?.label ??
    (view === "run" ? "Run" : view === "chain" ? "Chain" : "Overview");

  useEffect(() => {
    const id = route.length > 1 ? route[route.length - 1] : null;
    const typeQ = hashSearch(window.location.hash).get("type");
    const detail = id ?? typeQ;
    document.title = detail ? `factory · ${viewLabel} · ${detail}` : `factory · ${viewLabel}`;
  }, [route, viewLabel]);

  useEffect(() => {
    if (!filterFocus) return;
    const el = document.querySelector<HTMLInputElement>("[data-view-filter]");
    if (!el) return;
    el.focus();
    setFilterFocus(false);
  }, [filterFocus, view]);

  useEffect(() => {
    if (previousViewRef.current === view) return;
    previousViewRef.current = view;
    setViewAnnouncement(`${viewLabel} view`);
    // `/` intentionally sends focus to the destination view's filter instead.
    // Fall back to main when a lazy destination has not mounted its filter yet.
    if (!document.activeElement?.matches("[data-view-filter]")) {
      mainRef.current?.focus({ preventScroll: true });
    }
  }, [view, viewLabel]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (goPrefixActive()) return;
      if (e.key === "i") {
        e.preventDefault();
        setInjectOpen(true);
      } else if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((open) => !open);
      } else if (e.key === "/") {
        e.preventDefault();
        const traceSearch = document.querySelector<HTMLInputElement>("[data-trace-search]");
        if (traceSearch) {
          traceSearch.focus();
          traceSearch.select();
          return;
        }
        const el = document.querySelector<HTMLInputElement>("[data-view-filter]");
        if (el) el.focus();
        else {
          setFilterFocus(true);
          navigate("events");
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const nextTheme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];

  const paletteActions: PaletteAction[] = [
    ...NAV.map((n) => ({
      label: `Go to ${n.label}`,
      hint: `g ${n.go}`,
      group: "Go" as const,
      run: () => navigate(n.key),
    })),
    {
      label: "Context: All",
      hint: "g 0",
      group: "Go" as const,
      run: () => selectContext({ kind: "all" }),
    },
    ...openRepos.slice(0, 9).map((name, idx) => ({
      label: `Context: ${name}`,
      hint: `g ${idx + 1}`,
      group: "Go" as const,
      run: () => selectContext({ kind: "repo", name }),
    })),
    {
      label: "Context: In flight",
      hint: "g i",
      group: "Go" as const,
      run: () => selectContext({ kind: "inflight" }),
    },
    { label: "Inject event…", hint: "i", run: () => setInjectOpen(true) },
    {
      label: "Show orphan artifacts",
      group: "Commands" as const,
      run: () => navigate(artifactsHash({ orphan: true })),
    },
    {
      label: "Search artifacts",
      hint: "/",
      group: "Commands" as const,
      run: () => {
        setFilterFocus(true);
        navigate("artifacts");
      },
    },
    {
      label: "Focus filter",
      hint: "/",
      run: () => {
        const traceSearch = document.querySelector<HTMLInputElement>("[data-trace-search]");
        if (traceSearch) {
          traceSearch.focus();
          traceSearch.select();
          return;
        }
        const el = document.querySelector<HTMLInputElement>("[data-view-filter]");
        if (el) el.focus();
        else {
          setFilterFocus(true);
          navigate("events");
        }
      },
    },
    { label: "Copy link to this page", run: copyLink },
    { label: "Keyboard shortcuts", hint: "?", run: () => setHelpOpen(true) },
    { label: `Cycle theme (${THEMES.join(" → ")})`, run: cycleTheme },
  ];

  return (
    <div className="flex h-screen flex-col">
      <ContextTabs
        repos={reposQ.data?.repos ?? []}
        reposError={reposQ.isError}
        openRepos={openRepos}
        active={context}
        onSelect={selectContext}
        onOpen={openRepo}
        onClose={closeRepo}
        goArmed={goArmed}
      />
      <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Primary"
        className="flex w-52 shrink-0 flex-col border-r border-(--border) bg-(--surface-1)"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <img src="/watt-mind-logo.svg" alt="Watt Mind" className="size-5.5 shrink-0" />
            <span className="display text-[14px] font-semibold">factory</span>
          </div>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase"
            title={
              env
                ? `${env.home} · policy ${health.data?.policyVersion} — click to copy home`
                : "runtime unreachable"
            }
            style={{
              color: envHue,
              background: `color-mix(in oklch, ${envHue} 15%, transparent)`,
            }}
            onClick={() => env?.home && copyText(env.home, "runtime home")}
          >
            {envLabel}
          </button>
        </div>
        <div className="flex-1 px-2">
          {NAV.map((n) => {
            const badge = navBadges[n.key];
            return (
              <button
                key={n.key}
                type="button"
                aria-current={view === n.key || (n.key === "runs" && view === "run") ? "page" : undefined}
                aria-describedby={badge.count > 0 ? `nav-badge-${n.key}` : undefined}
                onClick={() => navigate(n.key)}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] ${
                  view === n.key || (n.key === "runs" && view === "run")
                    ? "bg-(--surface-3) font-medium text-(--text)"
                    : "text-(--text-dim) hover:bg-(--surface-2)"
                }`}
              >
                <span>{n.label}</span>
                {badge.count > 0 && (
                  /* aria-hidden keeps the count out of the accessible name —
                     "Events" must not announce as "Events 6" — while the
                     aria-describedby reference above still reads it back as
                     the button's description (accname spec includes hidden
                     nodes referenced by labelledby/describedby). */
                  <span
                    id={`nav-badge-${n.key}`}
                    aria-hidden="true"
                    className="rounded px-1.5 text-[11px] tabular-nums"
                    title={badge.title}
                    style={{
                      color: badge.hue,
                      background: `color-mix(in oklch, ${badge.hue} 12%, transparent)`,
                    }}
                  >
                    {badge.count}
                    {badge.word && <span className="ml-1">{badge.word}</span>}
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setInjectOpen(true)}
            className="mt-2 w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-(--text-dim) hover:bg-(--surface-2)"
          >
            Inject event… <span className="mono ml-1 text-(--text-faint)">i</span>
          </button>
        </div>
      </nav>

      <main
        ref={mainRef}
        tabIndex={-1}
        className="flex min-w-0 flex-1 flex-col focus:outline-none"
      >
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {viewAnnouncement}
        </div>
        {healthFailed && (
          <div
            role="status"
            className="shrink-0 border-b px-4 py-2 text-[12px]"
            style={{
              color: "var(--hue-err)",
              background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
              borderColor: "color-mix(in oklch, var(--hue-err) 35%, var(--border))",
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <span>
                Runtime unreachable — lists show last cached data; verbs are disabled until{" "}
                <span className="mono">/health</span> responds. This is not an empty factory.
              </span>
              <button
                type="button"
                onClick={() => health.refetch()}
                className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium"
                style={{
                  color: "var(--hue-err)",
                  borderColor: "color-mix(in oklch, var(--hue-err) 40%, var(--border))",
                }}
              >
                Retry
              </button>
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {view === "proposals" ? (
            <Suspense fallback={<div className="p-5 text-(--text-faint)">Loading proposals…</div>}>
              <Proposals
                connected={connected}
                context={context}
                onRunQueued={jumpToRun}
                focusProposalId={focusProposalId}
                onSelectProposal={(id) => navigate(hashPath("proposals", id))}
                focusExpired={focusExpired}
                onFocusExpiredConsumed={() => setFocusExpired(false)}
                onJumpAgent={jumpToAgent}
                onJumpEvent={jumpToEvent}
                rejumpEpoch={rejumpEpoch}
              />
            </Suspense>
          ) : view === "run" && fullRunId ? (
            <Suspense fallback={<div className="p-5 text-(--text-faint)">Loading run…</div>}>
              <RunFull
                runId={fullRunId}
                connected={connected}
                onBack={() => navigate(hashPath("runs", fullRunId))}
                onJumpAgent={jumpToAgent}
                onJumpEvent={jumpToEvent}
                onJumpProposal={jumpToProposal}
                onJumpChain={jumpToChain}
              />
            </Suspense>
          ) : view === "runs" || view === "run" ? (
            <Runs
              connected={connected}
              context={context}
              focusRunId={focusRunId}
              onSelectRun={(id) => navigate(hashPath("runs", id))}
              onOpenFull={openRunFull}
              focusState={focusRunState}
              onFocusStateConsumed={() => setFocusRunState(null)}
              onJumpAgent={jumpToAgent}
              onJumpEvent={jumpToEvent}
              onJumpProposal={jumpToProposal}
              rejumpEpoch={rejumpEpoch}
            />
          ) : view === "projects" ? (
            <Suspense fallback={<div className="p-5 text-(--text-faint)">Loading projects…</div>}>
              <Projects
                connected={connected}
                focusRepoName={focusRepoName}
                onSelectRepo={(name) => navigate(hashPath("projects", name))}
              />
            </Suspense>
          ) : view === "chain" && chainId ? (
            <Suspense fallback={<div className="p-5 text-(--text-faint)">Loading chain…</div>}>
              <Chain
                correlationId={chainId}
                focusNodeId={focusChainNode}
                onSelectNode={(id) => navigate(hashPath("chain", chainId, id))}
                onJumpEvent={jumpToEvent}
                onJumpRun={jumpToRun}
                onOpenRunFull={openRunFull}
                onJumpProposal={jumpToProposal}
                onJumpAgent={jumpToAgent}
              />
            </Suspense>
          ) : view === "graph" ? (
            <Suspense fallback={<div className="p-5 text-(--text-faint)">Loading graph…</div>}>
              <Graph
                context={context}
                focusNodeId={focusGraphNode}
                onSelectNode={(id) => navigate(hashPath("graph", id))}
                onJumpAgent={jumpToAgent}
                onJumpEvents={jumpToEvents}
              />
            </Suspense>
          ) : view === "agents" ? (
            <Suspense fallback={<div className="p-5 text-(--text-faint)">Loading agents…</div>}>
              <Agents
                context={context}
                focusAgentRef={focusAgentRef}
                onSelectAgent={(ref) => navigate(hashPath("agents", ref))}
              />
            </Suspense>
          ) : view === "schedules" ? (
            <Suspense fallback={<div className="p-5 text-(--text-faint)">Loading schedules…</div>}>
              <Schedules
                connected={connected}
                context={context}
                focusScheduleLoop={focusScheduleLoop}
                onSelectSchedule={(loop) => navigate(hashPath("schedules", loop))}
                onJumpProposal={jumpToProposal}
                onJumpRun={jumpToRun}
                onJumpEvent={jumpToEvent}
                onJumpAgent={jumpToAgent}
                rejumpEpoch={rejumpEpoch}
              />
            </Suspense>
          ) : view === "workers" ? (
            <Suspense fallback={<div className="p-5 text-(--text-faint)">Loading workers…</div>}>
              <Workers
                context={context}
                focusWorkerId={focusWorkerId}
                onSelectWorker={(id) => navigate(workerHash(id, focusWorkerHealth))}
                focusHealth={focusWorkerHealth}
                onFocusHealthChange={(health) => navigate(workerHash(null, health))}
              />
            </Suspense>
          ) : view === "artifacts" ? (
            <Suspense fallback={<div className="p-5 text-(--text-faint)">Loading artifacts…</div>}>
              <Artifacts
                metrics={status.data?.artifacts}
                filters={artifactFilters}
                onFiltersChange={(filters) => navigate(artifactsHash(filters))}
                onJumpRun={jumpToRun}
              />
            </Suspense>
          ) : view === "events" ? (
            <Events
              connected={connected}
              context={context}
              focusEvent={hasEventFocus ? focusEvent : null}
              onFocusConsumed={() => setEphemeralEvent(null)}
              onSelectEvent={(source, eventId) =>
                navigate(eventsHash(source, eventId, typeFromHash))
              }
              onSelectType={(type) =>
                navigate(eventsHash(hashEvent?.source, hashEvent?.eventId, type))
              }
              onJumpProposal={jumpToProposal}
              onJumpRun={jumpToRun}
              onJumpChain={jumpToChain}
              onTriggerAgain={(envelope) => {
                setInjectSeed(envelope);
                setInjectOpen(true);
              }}
              onInject={() => setInjectOpen(true)}
              rejumpEpoch={rejumpEpoch}
            />
          ) : (
            <Overview
              connected={connected}
              context={context}
              onJumpRun={jumpToRun}
              onJumpProposal={jumpToProposal}
              onJumpEvents={jumpToEvents}
              onJumpRuns={jumpToRuns}
              onJumpWorkers={jumpToWorkers}
              onNavigate={navigate}
              onJumpExpired={() => {
                setFocusExpired(true);
                navigate("proposals");
              }}
              onJumpGraph={() => jumpToGraph()}
              onInject={() => setInjectOpen(true)}
            />
          )}
        </div>
      </main>
      </div>

      <footer
        role="contentinfo"
        aria-label="Status bar"
        className="flex h-7 shrink-0 items-center justify-between border-t border-(--border) bg-(--surface-1) px-3 text-[11px] select-none"
      >
        <div className="flex items-center gap-2 text-(--text-dim)">
          <div className="flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: connected ? "var(--hue-ok)" : "var(--hue-err)" }}
            />
            {connected ? (
              <span>
                connected · <span className="mono">{health.data?.policyVersion}</span>
                {liveWorkers !== null && (
                  <span
                    className="ml-1"
                    style={staleWorkers > 0 ? { color: "var(--hue-warn)" } : undefined}
                    title={
                      staleWorkers > 0
                        ? `${liveWorkers} live · ${staleWorkers} worker${staleWorkers === 1 ? "" : "s"} whose heartbeat has gone stale`
                        : `${liveWorkers} live worker${liveWorkers === 1 ? "" : "s"}`
                    }
                  >
                    ·{" "}
                    {staleWorkers > 0
                      ? `${staleWorkers} stale worker${staleWorkers === 1 ? "" : "s"}`
                      : liveWorkers === 0
                        ? "no workers"
                        : `${liveWorkers} worker${liveWorkers === 1 ? "" : "s"}`}
                  </span>
                )}
              </span>
            ) : (
              <span style={{ color: "var(--hue-err)" }}>runtime unreachable</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-(--text-faint)">
            <span className="mono">⌘K</span> commands · <span className="mono">i</span> inject ·{" "}
            <span className="mono">g</span> go · <span className="mono">?</span> keys
          </div>
          <button
            type="button"
            onClick={cycleTheme}
            title={`Theme ${theme} — click for ${nextTheme}`}
            aria-label={`Theme: ${theme}. Switch to ${nextTheme}.`}
            className="flex cursor-pointer items-center justify-center rounded p-1 text-(--text-faint) hover:bg-(--surface-2) hover:text-(--text) focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--focus-ring) transition-colors"
          >
            <ThemeIcon theme={theme} />
          </button>
        </div>
      </footer>

      <CommandPalette
        actions={paletteActions}
        onJumpRun={jumpToRun}
        onJumpProposal={jumpToProposal}
        onJumpEvent={jumpToEvent}
        onJumpAgent={jumpToAgent}
        onJumpWorker={jumpToWorker}
        onJumpProject={jumpToProject}
      />
      {injectOpen && (
        <Suspense fallback={null}>
          <InjectDialog
            initialEnvelope={injectSeed}
            onClose={() => {
              setInjectOpen(false);
              setInjectSeed(undefined);
            }}
            onAdmitted={(source, eventId) => {
              setInjectOpen(false);
              setInjectSeed(undefined);
              jumpToEvent(source, eventId);
            }}
          />
        </Suspense>
      )}
      {helpOpen && (
        <Suspense fallback={null}>
          <ShortcutsDialog onClose={() => setHelpOpen(false)} />
        </Suspense>
      )}
      <GoPrefixHint armed={goArmed} currentView={view} />
      <ToastContainer />
    </div>
  );
}

/**
 * The armed `g` prefix, on screen for as long as the chord window is open.
 * Without it a `g` plus any hesitation reads as a dropped keystroke, and the
 * suffix pressed after the window lapsed fires as a bare list verb instead.
 *
 * `fixed` and `pointer-events-none` on purpose: the indicator appears mid-key
 * and must not reflow the nav/list/detail layout under it, or reading the row
 * it is about to leave becomes impossible. The region itself stays mounted
 * while empty — a screen reader only announces nodes inserted into a live
 * region that already existed (see ToastContainer).
 */
export function GoPrefixHint({ armed, currentView }: { armed: boolean; currentView?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-9 left-4 z-30 max-w-[calc(100vw-20rem)] lg:left-1/2 lg:-translate-x-1/2 lg:max-w-[calc(100vw-24rem)]"
    >
      {armed && (
        <>
          <span className="sr-only">Navigation prefix g armed — press a second key</span>
          {/* The legend is the point for a sighted operator and noise read
              aloud: the sentence above says the same thing in one breath. */}
          <div
            aria-hidden="true"
            className="flex max-w-full flex-wrap items-center justify-center gap-x-2.5 gap-y-1 rounded-full border border-(--border-strong) bg-(--surface-2) px-3 py-1.5 text-[11px] shadow-lg"
          >
            <span
              className="mono rounded px-1.5 font-semibold"
              style={{
                color: "var(--accent)",
                background: "color-mix(in oklch, var(--accent) 16%, transparent)",
              }}
            >
              g
            </span>
            <span className="text-(--text-dim)">then</span>
            {NAV.map((n) => {
              const isCurrent =
                n.key === currentView || (n.key === "runs" && currentView === "run");
              if (isCurrent) {
                return (
                  <span
                    key={n.key}
                    className="whitespace-nowrap opacity-60 text-(--text-faint)"
                  >
                    <span className="mono text-(--text-dim)">{n.go}</span> {n.label}{" "}
                    <span className="rounded px-1 text-[10px] text-(--text-faint) ring-1 ring-inset ring-(--border)">
                      current
                    </span>
                  </span>
                );
              }
              return (
                <span key={n.key} className="whitespace-nowrap text-(--text-faint)">
                  <span className="mono text-(--text)">{n.go}</span> {n.label}
                </span>
              );
            })}
            <span className="whitespace-nowrap text-(--text-faint)">
              <span className="mono text-(--text)">0</span> All
            </span>
            <span className="whitespace-nowrap text-(--text-faint)">
              <span className="mono text-(--text)">1–9</span> repos
            </span>
            <span className="whitespace-nowrap text-(--text-faint)">
              <span className="mono text-(--text)">i</span> In flight
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** Subtle theme glyph reflecting active theme state (dark / light / contrast). */
function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "light") {
    return (
      <svg aria-hidden width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="3.5" />
        <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
      </svg>
    );
  }
  if (theme === "contrast") {
    return (
      <svg aria-hidden width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6" />
        <path d="M8 2a6 6 0 0 1 0 12V2z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg aria-hidden width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 10.2A6 6 0 0 1 5.8 2.5 6 6 0 1 0 13.5 10.2z" fill="currentColor" fillOpacity="0.2" />
    </svg>
  );
}

