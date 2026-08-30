import { useQuery } from "@tanstack/react-query";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
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
import {
  artifactFullHash,
  artifactsHash,
  eventsHash,
  hashPath,
  hashProject,
  hashSearch,
  withProject,
} from "./hash";
import {
  keyGuard,
  refetchIntervals,
  setApiBusyBackoff,
  THEMES,
  useHashRoute,
  useTheme,
  type Theme,
} from "./hooks";
import { goPrefixActive } from "./goSequence";
import type { EventFocus } from "./types";
import {
  CommandPalette,
  useGoSequences,
  type PaletteAction,
} from "./components/CommandPalette";
import {
  IconButton,
  ToastContainer,
  copyLink,
  copyText,
} from "./components/ui";
import {
  NAV,
  navIsCurrent,
  resolveView,
  viewLabel as viewLabelFor,
  workerHash,
  type NavKey,
  type Shell,
  type WorkerHealthFilter,
} from "./views/registry";
import { Button as PrimitiveButton } from "./components/ui";

// Route helpers moved to the view registry (WM-839); re-exported for callers
// (and tests) that reach them through App.
export { listSelectionPath, navIsCurrent } from "./views/registry";

type NavBadge = {
  count: number;
  hue: string;
  word?: string;
  title?: string;
};

function reloadAge(loadedAt?: string) {
  if (!loadedAt) return null;
  const elapsed = Math.max(0, Date.now() - Date.parse(loadedAt));
  if (!Number.isFinite(elapsed)) return null;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function NavCount({ id, badge }: { id: string; badge: NavBadge }) {
  return (
    <span
      id={id}
      aria-hidden="true"
      className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium leading-none tabular-nums"
      title={badge.title}
      style={{
        color: badge.hue,
        background: `color-mix(in oklch, ${badge.hue} 12%, transparent)`,
      }}
    >
      {badge.count}
      {badge.word && <span className="ml-1">{badge.word}</span>}
    </span>
  );
}

const ShortcutsDialog = lazy(() =>
  import("./components/ShortcutsDialog").then((m) => ({
    default: m.ShortcutsDialog,
  })),
);
const InjectDialog = lazy(() =>
  import("./components/InjectDialog").then((m) => ({
    default: m.InjectDialog,
  })),
);

/**
 * Loader for the ticket-journey chunk. A mutable seam so tests can make the
 * dynamic import itself reject without poisoning bun's shared module registry.
 */
export const ticketJourneyChunk = {
  load: () => import("./subjectJourney"),
};

export function App() {
  const [route, navigateRaw] = useHashRoute();
  const view = route[0];
  const project = hashProject(window.location.hash);
  const context = contextFromProject(project);
  const [openRepos, setOpenRepos] = useState<string[]>(() => {
    try {
      return readContextTabs(sessionStorage.getItem(CONTEXT_STORAGE_KEY))
        .openRepos;
    } catch {
      return [];
    }
  });
  const navigate = useCallback(
    (path: string) =>
      navigateRaw(withProject(path, hashProject(window.location.hash))),
    [navigateRaw],
  );
  const hashPathNow = () =>
    window.location.hash.replace(/^#\/?/, "") || "overview";
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

  const reposQ = useQuery({
    queryKey: ["repos"],
    queryFn: api.repos,
    ...refetchIntervals.secondary,
  });

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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [injectOpen, setInjectOpen] = useState(false);
  const [injectSeed, setInjectSeed] = useState<
    Record<string, unknown> | undefined
  >(undefined);
  const [helpOpen, setHelpOpen] = useState(false);
  const [focusRunState, setFocusRunState] = useState<string | null>(null);
  const [focusExpired, setFocusExpired] = useState(false);
  const [ephemeralEvent, setEphemeralEvent] = useState<EventFocus | null>(null);
  const [filterFocus, setFilterFocus] = useState(false);
  const [viewAnnouncement, setViewAnnouncement] = useState("");
  const mainRef = useRef<HTMLElement>(null);
  const mobileNavToggleRef = useRef<HTMLButtonElement>(null);
  const mobileNavCloseRef = useRef<HTMLButtonElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);
  const mobileNavWasOpenRef = useRef(false);
  const previousViewRef = useRef(view);

  useEffect(() => {
    function closeMobileNavOnDesktopResize() {
      if (window.innerWidth >= 768) setMobileNavOpen(false);
    }
    window.addEventListener("resize", closeMobileNavOnDesktopResize);
    return () =>
      window.removeEventListener("resize", closeMobileNavOnDesktopResize);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) {
      if (mobileNavWasOpenRef.current) mobileNavToggleRef.current?.focus();
      mobileNavWasOpenRef.current = false;
      return;
    }
    mobileNavWasOpenRef.current = true;
    mobileNavCloseRef.current?.focus();

    function handleMobileNavKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileNavOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        mobileNavRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!mobileNavRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleMobileNavKey);
    return () => window.removeEventListener("keydown", handleMobileNavKey);
  }, [mobileNavOpen]);

  useEffect(() => {
    const root = mainRef.current;
    if (!root) return;
    let disposed = false;
    let uninstall = () => {};
    // Two separate catches: a rejected dynamic import is a stale chunk after a
    // deploy (WM-1367) and must not be confused with a genuine install-time
    // throw, so each failure is logged under its own message.
    void ticketJourneyChunk.load().then(
      ({ installTicketJourneyLinks }) => {
        if (disposed) return;
        try {
          uninstall = installTicketJourneyLinks(root, jumpToTicket);
        } catch (error: unknown) {
          console.warn("ticket journey links failed to install", error);
        }
      },
      (error: unknown) => {
        if (disposed) return;
        console.warn("ticket journey chunk import failed", error);
      },
    );
    return () => {
      disposed = true;
      uninstall();
    };
  }, []);

  const [rejumpEpoch, setRejumpEpoch] = useState(0);

  const jumpToRun = (runId: string) => {
    setRejumpEpoch((n) => n + 1);
    navigate(hashPath("runs", runId));
  };
  const openRunFull = (runId: string) => navigate(hashPath("run", runId));
  const openArtifactFull = (digest: string, backHash?: string) =>
    navigate(artifactFullHash(digest, backHash));
  const jumpToTicket = (ticketId: string) =>
    navigate(hashPath("tickets", ticketId));
  const jumpToPr = (number: number) =>
    navigate(hashPath("prs", String(number)));
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
      setEphemeralEvent(
        focus.status || focus.type
          ? { status: focus.status, type: focus.type }
          : null,
      );
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
  const jumpToWorker = (id: string) => navigate(workerHash(id, null));
  const jumpToWorkers = (health: WorkerHealthFilter) =>
    navigate(workerHash(null, health));
  const jumpToProject = (name: string) => navigate(hashPath("projects", name));
  const jumpToGraph = (nodeId?: string) => navigate(hashPath("graph", nodeId));
  const jumpToChain = (correlationId: string, nodeId?: string) =>
    navigate(hashPath("chain", correlationId, nodeId));

  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    ...refetchIntervals.primary,
    retry: false,
  });
  const connected = health.isSuccess;
  // A first load that has not answered yet is "connecting", not "down". Every
  // piece of connection chrome — chip, status bar, banner — reads this rather
  // than !connected, so an in-flight /health never flashes an outage.
  const healthPending = health.isPending;
  const healthFailed = !connected && !healthPending;
  const registryHealth = health.data?.registry;
  const registryReloadAge = reloadAge(registryHealth?.loadedAt);

  useEffect(() => {
    if (health.data?.tick?.overruns && health.data.tick.overruns > 0) {
      setApiBusyBackoff(true);
    } else if (
      health.data?.tick &&
      health.data.tick.overruns === 0 &&
      (health.data.tick.lastMs ?? 0) < 1000
    ) {
      setApiBusyBackoff(false);
    }
  }, [health.data]);

  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    ...refetchIntervals.primary,
  });
  const openProposals = status.data?.proposals?.open ?? 0;
  const activeRuns = Object.entries(status.data?.runs?.byState ?? {})
    .filter(([s]) => ["QUEUED", "LEASED", "RUNNING", "VERIFYING"].includes(s))
    .reduce((sum, [, n]) => sum + (n ?? 0), 0);
  const eventAttention =
    (status.data?.events?.human_needed ?? 0) +
    (status.data?.events?.dead_lettered ?? 0);
  const scopedNav = context.kind === "repo";
  const scopedRunsNav = context.kind !== "all";
  const busyWorkers = status.data?.workers?.busy ?? 0;
  const staleWorkers = status.data?.workers?.stale ?? 0;
  // null until the first status lands: reading "no workers" off a pending
  // fetch is the same false alarm as flashing "unreachable" on first load.
  const liveWorkers = status.data?.workers?.live ?? null;
  const stoppedSchedulesCount = (status.data?.anomalies?.stoppedSchedules ?? [])
    .length;

  // Workers is the one badge whose meaning can flip: a stale
  // heartbeat is a worker that is gone while claiming to work, so it
  // outranks the busy count. The word carries that — reading the
  // count off the tone alone fails in the contrast theme.
  const inboxOpen = status.data?.inbox?.open ?? 0;
  const navBadges: Record<NavKey, NavBadge> = {
    overview: { count: 0, hue: "var(--accent)" },
    metrics: { count: 0, hue: "var(--accent)" },
    // Open = not even acked yet. Warn hue: every one of these is a human's
    // turn, which is exactly what the amber wash means everywhere else.
    inbox: {
      count: inboxOpen,
      hue: "var(--hue-warn)",
      title: `${inboxOpen} inbox item${inboxOpen === 1 ? "" : "s"} waiting on you`,
    },
    events: { count: scopedNav ? 0 : eventAttention, hue: "var(--accent)" },
    chains: { count: 0, hue: "var(--accent)" },
    proposals: { count: scopedNav ? 0 : openProposals, hue: "var(--accent)" },
    runs: { count: scopedRunsNav ? 0 : activeRuns, hue: "var(--accent)" },
    tickets: { count: 0, hue: "var(--accent)" },
    projects: { count: 0, hue: "var(--accent)" },
    agents: { count: 0, hue: "var(--accent)" },
    artifacts: {
      count: status.data?.artifacts?.orphans ?? 0,
      hue: "var(--hue-warn)",
      title: `${status.data?.artifacts?.orphans ?? 0} orphan artifact${status.data?.artifacts?.orphans === 1 ? "" : "s"} (unreferenced)`,
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
    settings: { count: 0, hue: "var(--accent)" },
  };

  const env = health.data?.env;
  const envHue = connected
    ? env?.name === "live"
      ? "var(--hue-warn)"
      : "var(--hue-info)"
    : healthPending
      ? "var(--text-dim)"
      : "var(--hue-err)";
  const envLabel = connected
    ? env
      ? env.adapter
        ? `${env.name} · ${env.adapter}`
        : env.name
      : "…"
    : healthPending
      ? "connecting"
      : "disconnected";

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

  const viewLabel = viewLabelFor(view);

  useEffect(() => {
    const id = route.length > 1 ? route[route.length - 1] : null;
    const typeQ = hashSearch(window.location.hash).get("type");
    const detail = id ?? typeQ;
    const pageTitle = detail
      ? `factory · ${viewLabel} · ${detail}`
      : `factory · ${viewLabel}`;
    document.title = inboxOpen > 0 ? `(${inboxOpen}) ${pageTitle}` : pageTitle;
  }, [inboxOpen, route, viewLabel]);

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
    setMobileNavOpen(false);
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
        setMobileNavOpen(false);
        setInjectOpen(true);
      } else if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((open) => !open);
      } else if (e.key === "/") {
        e.preventDefault();
        const traceSearch = document.querySelector<HTMLInputElement>(
          "[data-trace-search]",
        );
        if (traceSearch) {
          traceSearch.focus();
          traceSearch.select();
          return;
        }
        const el =
          document.querySelector<HTMLInputElement>("[data-view-filter]");
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
        const traceSearch = document.querySelector<HTMLInputElement>(
          "[data-trace-search]",
        );
        if (traceSearch) {
          traceSearch.focus();
          traceSearch.select();
          return;
        }
        const el =
          document.querySelector<HTMLInputElement>("[data-view-filter]");
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

  // The registry resolves the first hash segment to a view and hands it the
  // shell slice it needs (WM-839); unknown keys land on Overview.
  const {
    def: viewDef,
    params: viewParams,
    component: View,
  } = resolveView(route);
  const shell: Shell = {
    connected,
    healthPending,
    context,
    status: status.data,
    rejumpEpoch,
    focusRunState,
    clearFocusRunState: () => setFocusRunState(null),
    focusExpired,
    setFocusExpired,
    ephemeralEvent,
    setEphemeralEvent,
    openInject: (seed) => {
      if (seed) setInjectSeed(seed);
      setInjectOpen(true);
    },
    jump: {
      run: jumpToRun,
      runFull: openRunFull,
      runs: jumpToRuns,
      artifactFull: openArtifactFull,
      ticket: jumpToTicket,
      pr: jumpToPr,
      proposal: jumpToProposal,
      event: jumpToEvent,
      events: jumpToEvents,
      agent: jumpToAgent,
      workers: jumpToWorkers,
      graph: jumpToGraph,
      chain: jumpToChain,
    },
  };

  return (
    <div className="flex h-screen flex-col">
      <div
        aria-hidden={mobileNavOpen ? true : undefined}
        inert={mobileNavOpen ? true : undefined}
      >
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
      </div>
      <div className="relative flex min-h-0 flex-1">
        {mobileNavOpen && (
          <button
            type="button"
            aria-label="Dismiss navigation"
            tabIndex={-1}
            className="absolute inset-0 z-10 bg-black/45 md:hidden"
            onClick={() => setMobileNavOpen(false)}
          />
        )}
        <nav
          ref={mobileNavRef}
          id="primary-navigation"
          aria-label="Primary"
          className={`${mobileNavOpen ? "flex" : "hidden"} absolute inset-y-0 left-0 z-20 w-64 shrink-0 flex-col overflow-y-auto border-r border-(--border) bg-(--surface-1) shadow-xl md:static md:flex md:w-52 md:overflow-y-visible md:shadow-none`}
        >
          <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
            <div className="flex min-w-0 items-center gap-2">
              <img
                src="/watt-mind-logo.svg"
                alt="Watt Mind"
                className="size-5.5 shrink-0"
              />
              <span className="display text-[14px] font-semibold">factory</span>
            </div>
            <div className="flex items-center gap-1">
              <PrimitiveButton
                bare
                type="button"
                className="rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase"
                title={
                  env?.home
                    ? `${env.home} · policy ${health.data?.policyVersion} — click to copy home`
                    : healthPending
                      ? "connecting to the runtime… — click to retry"
                      : "runtime unreachable — click to retry"
                }
                style={{
                  color: envHue,
                  background: `color-mix(in oklch, ${envHue} 15%, transparent)`,
                }}
                onClick={() =>
                  env?.home
                    ? copyText(env.home, "runtime home")
                    : health.refetch()
                }
              >
                {envLabel}
              </PrimitiveButton>
              {mobileNavOpen && (
                <button
                  ref={mobileNavCloseRef}
                  type="button"
                  aria-label="Close navigation"
                  className="flex size-11 items-center justify-center rounded text-lg text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text) md:hidden"
                  onClick={() => setMobileNavOpen(false)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 px-2">
            {NAV.map((n, index) => {
              const prev = index > 0 ? NAV[index - 1] : null;
              const isGroupBoundary = prev && prev.group !== n.group;
              const badge = navBadges[n.key];
              const current = navIsCurrent(n.key, view);
              return (
                <Fragment key={n.key}>
                  {isGroupBoundary && (
                    <div
                      role="separator"
                      className="my-1.5 mx-2.5 border-t border-(--border)"
                    />
                  )}
                  <PrimitiveButton
                    bare
                    type="button"
                    aria-current={current ? "page" : undefined}
                    aria-describedby={
                      badge.count > 0 ? `nav-badge-${n.key}` : undefined
                    }
                    onClick={() => {
                      setMobileNavOpen(false);
                      navigate(n.key);
                    }}
                    className={`flex min-h-11 w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] md:min-h-0 ${
                      current
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
                      <NavCount id={`nav-badge-${n.key}`} badge={badge} />
                    )}
                  </PrimitiveButton>
                </Fragment>
              );
            })}
            <PrimitiveButton
              bare
              type="button"
              onClick={() => {
                setMobileNavOpen(false);
                setInjectOpen(true);
              }}
              className="mt-2 min-h-11 w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-(--text-dim) hover:bg-(--surface-2) md:min-h-0"
            >
              Inject event…{" "}
              <span className="mono ml-1 text-(--text-faint)">i</span>
            </PrimitiveButton>
          </div>
        </nav>

        <main
          ref={mainRef}
          tabIndex={-1}
          aria-hidden={mobileNavOpen ? true : undefined}
          inert={mobileNavOpen ? true : undefined}
          className="flex min-w-0 flex-1 flex-col focus:outline-none"
        >
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-(--border) bg-(--surface-1) px-2 md:hidden">
            <button
              ref={mobileNavToggleRef}
              type="button"
              aria-label="Open navigation"
              aria-controls="primary-navigation"
              aria-expanded={mobileNavOpen}
              className="flex size-11 items-center justify-center rounded-md text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
              onClick={() => setMobileNavOpen(true)}
            >
              <span aria-hidden="true" className="text-lg leading-none">
                ☰
              </span>
            </button>
            <span className="display truncate text-[13px] font-semibold">
              {viewLabel}
            </span>
          </div>
          <div aria-live="polite" aria-atomic="true" className="sr-only">
            {viewAnnouncement}
          </div>
          {healthFailed && (
            <div
              role="status"
              className="shrink-0 border-b px-4 py-2 text-[12px]"
              style={{
                color: "var(--hue-err)",
                background:
                  "color-mix(in oklch, var(--hue-err) 10%, transparent)",
                borderColor:
                  "color-mix(in oklch, var(--hue-err) 35%, var(--border))",
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <span>
                  Runtime unreachable — lists show last cached data; verbs are
                  disabled until <span className="mono">/health</span> responds.
                  This is not an empty factory.
                </span>
                <PrimitiveButton
                  bare
                  type="button"
                  onClick={() => health.refetch()}
                  className="shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    color: "var(--hue-err)",
                    borderColor:
                      "color-mix(in oklch, var(--hue-err) 40%, var(--border))",
                  }}
                >
                  Retry
                </PrimitiveButton>
              </div>
            </div>
          )}
          {connected && registryHealth?.lastReloadError && (
            <div
              role="alert"
              className="shrink-0 border-b px-4 py-2 text-[12px]"
              style={{
                color: "var(--hue-err)",
                background:
                  "color-mix(in oklch, var(--hue-err) 10%, transparent)",
                borderColor:
                  "color-mix(in oklch, var(--hue-err) 35%, var(--border))",
              }}
            >
              Registry reload failed — running last-good configuration.{" "}
              <span className="mono">
                {registryHealth.lastReloadError.message}
              </span>
            </div>
          )}
          <div
            data-testid="view-slot"
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <Suspense
              fallback={
                <div className="p-5 text-(--text-faint)">
                  Loading {viewDef.loading ?? viewDef.label.toLowerCase()}…
                </div>
              }
            >
              <View
                params={viewParams}
                hash={window.location.hash}
                navigate={navigate}
                shell={shell}
              />
            </Suspense>
          </div>
        </main>
      </div>

      <footer
        role="contentinfo"
        aria-label="Status bar"
        aria-hidden={mobileNavOpen ? true : undefined}
        inert={mobileNavOpen ? true : undefined}
        className="flex h-7 shrink-0 items-center justify-between overflow-hidden border-t border-(--border) bg-(--surface-1) px-3 text-[11px] select-none"
      >
        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap text-(--text-dim)">
          <div className="flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{
                background: connected
                  ? "var(--hue-ok)"
                  : healthPending
                    ? "var(--text-dim)"
                    : "var(--hue-err)",
              }}
            />
            {connected ? (
              <span>
                connected ·{" "}
                <span className="mono">{health.data?.policyVersion}</span>
                {registryReloadAge && (
                  <span
                    className="ml-1 text-(--text-faint)"
                    title={`Registry ${registryHealth?.stamp ?? "unknown stamp"} loaded ${registryHealth?.loadedAt}`}
                  >
                    · registry {registryReloadAge} ago
                  </span>
                )}
                {liveWorkers !== null && (
                  <span
                    className="ml-1"
                    style={
                      staleWorkers > 0
                        ? { color: "var(--hue-warn)" }
                        : undefined
                    }
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
            ) : healthPending ? (
              <span>connecting…</span>
            ) : (
              <span style={{ color: "var(--hue-err)" }}>
                runtime unreachable
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden text-(--text-faint) md:block">
            <span className="mono">⌘K</span> commands ·{" "}
            <span className="mono">i</span> inject ·{" "}
            <span className="mono">g</span> go · <span className="mono">?</span>{" "}
            keys
          </div>
          <IconButton
            onClick={cycleTheme}
            aria-label={`Theme: ${theme}. Switch to ${nextTheme}.`}
            tooltip={`Theme ${theme} — click for ${nextTheme}`}
            className="text-(--text-faint) focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--focus-ring)"
          >
            <ThemeIcon theme={theme} />
          </IconButton>
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
        onJumpTicket={jumpToTicket}
        onJumpPr={jumpToPr}
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
export function GoPrefixHint({
  armed,
  currentView,
}: {
  armed: boolean;
  currentView?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-9 left-4 z-30 max-w-[calc(100vw-20rem)] lg:left-1/2 lg:-translate-x-1/2 lg:max-w-[calc(100vw-24rem)]"
    >
      {armed && (
        <>
          <span className="sr-only">
            Navigation prefix g armed — press a second key
          </span>
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
                background:
                  "color-mix(in oklch, var(--accent) 16%, transparent)",
              }}
            >
              g
            </span>
            <span className="text-(--text-dim)">then</span>
            {NAV.map((n) => {
              const isCurrent = navIsCurrent(n.key, currentView);
              if (isCurrent) {
                return (
                  <span
                    key={n.key}
                    className="whitespace-nowrap opacity-60 text-(--text-faint)"
                  >
                    <span className="mono text-(--text-dim)">{n.go}</span>{" "}
                    {n.label}{" "}
                    <span className="rounded px-1 text-xs text-(--text-faint) ring-1 ring-inset ring-(--border)">
                      current
                    </span>
                  </span>
                );
              }
              return (
                <span
                  key={n.key}
                  className="whitespace-nowrap text-(--text-faint)"
                >
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
      <svg
        aria-hidden
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <circle cx="8" cy="8" r="3.5" />
        <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
      </svg>
    );
  }
  if (theme === "contrast") {
    return (
      <svg
        aria-hidden
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="8" cy="8" r="6" />
        <path d="M8 2a6 6 0 0 1 0 12V2z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d="M13.5 10.2A6 6 0 0 1 5.8 2.5 6 6 0 1 0 13.5 10.2z"
        fill="currentColor"
        fillOpacity="0.2"
      />
    </svg>
  );
}
