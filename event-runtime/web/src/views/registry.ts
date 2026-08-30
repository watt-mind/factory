/**
 * The view registry (WM-839): one declaration per view drives the nav rail,
 * the `g` chords, the ⌘K "Go to" actions, the lazy import and the hash-route
 * resolve. Adding a page is one entry here — see docs/event-runtime-webui.md
 * "Adding a view".
 *
 * Chord rationale. Agents rides `g t` ("what is this agent?"): o/e/p/r are
 * taken, and `g a` would double-fire the proposals view's `a` (approve) list
 * key. Artifacts uses `g y` (the last sound in "artifact") so it does not
 * compete with list `k`. Workers keeps its natural `g w`: `w` is no view's
 * list verb. Inbox takes `g n` ("needs you"): `n` is no view's list verb
 * either, and `g i` is the In-flight context chord (WM-235). Number keys 1–6
 * belong to an undecided DecisionCard whenever one is on screen
 * (capture-phase window listener, so Inbox's 1–4 status tabs never see them);
 * with no open card the tabs keep their existing binding. Chains rides `g l`
 * ("chain link"): its natural `c` went to Settings (WM-704, config) first
 * (WM-537). `RESERVED_GO_SUFFIXES` below encodes the collision rule and
 * `registry.test.ts` enforces it.
 */
import { createElement, lazy, type ComponentType } from "react";
import type { OperatorContext } from "../context";
import {
  artifactsHash,
  eventsHash,
  hashPath,
  hashSearch,
  hashView,
} from "../hash";
import type { EventFocus, StatusView } from "../types";
import type { ArtifactFilters } from "./Artifacts";
import { Events } from "./Events";
import { Overview } from "./Overview";
import { Runs } from "./Runs";

export type NavGroup = "live" | "work" | "machinery" | "system";

export type WorkerHealthFilter = "live" | "busy" | "stale";
export const isWorkerHealthFilter = (
  value: string | null,
): value is WorkerHealthFilter =>
  value === "live" || value === "busy" || value === "stale";

/**
 * Cross-view navigation and shared state the shell (App.tsx) owns. Views
 * never see this directly — each registry entry's adapter projects the slice
 * a view needs onto that view's own props, so a view stays a plain component
 * with an explicit contract and the shell stays the one owner of state.
 */
export type Shell = {
  connected: boolean;
  healthPending: boolean;
  context: OperatorContext;
  status: StatusView | undefined;
  /** Bumped when a jump re-targets the same route so the view re-focuses. */
  rejumpEpoch: number;
  focusRunState: string | null;
  clearFocusRunState: () => void;
  focusExpired: boolean;
  setFocusExpired: (next: boolean) => void;
  ephemeralEvent: EventFocus | null;
  setEphemeralEvent: (next: EventFocus | null) => void;
  openInject: (seed?: Record<string, unknown>) => void;
  jump: {
    run: (runId: string) => void;
    runFull: (runId: string) => void;
    runs: (state?: string) => void;
    artifactFull: (digest: string, backHash?: string) => void;
    ticket: (ticketId: string) => void;
    pr: (number: number) => void;
    proposal: (id: string) => void;
    event: (source: string, eventId: string, status?: string) => void;
    events: (focus: EventFocus) => void;
    agent: (ref: string) => void;
    workers: (health: WorkerHealthFilter) => void;
    graph: (nodeId?: string) => void;
    chain: (correlationId: string, nodeId?: string) => void;
  };
};

/** What every registered view component receives. */
export type ViewProps = {
  /** Hash segments after the view key: `#/chain/:id/:node` → `[id, node]`. */
  params: readonly string[];
  /** `window.location.hash` at render time — query filters live there. */
  hash: string;
  /** Navigate to a hash path (project context is carried over by the shell). */
  navigate: (path: string) => void;
  shell: Shell;
};

export type ViewDef = {
  /** First hash segment (`#/<key>`); also the nav-rail identity. */
  key: string;
  /** Rail / page-title label. */
  label: string;
  /** `g <go>` chord suffix. Absent for drill-in routes reached from a parent view. */
  go?: string;
  /** Rail group; absent for routes that are not on the rail. */
  group?: NavGroup;
  /** Lazy loader — the view chunk is fetched the first time the route renders. */
  load: () => Promise<{ default: ComponentType<ViewProps> }>;
  /** Documented focus params after the key, e.g. `[":id"]` for `#/runs/:id`. */
  params?: readonly string[];
  /** Nav key that stays `aria-current` while this drill-in route is shown. */
  parent?: string;
  /** View to render instead when the first param is missing (`#/run` → runs). */
  fallback?: string;
  /** Suspense fallback noun; defaults to the lowercased label. */
  loading?: string;
  /**
   * First-paint views ship in the entry chunk (vite.config.ts budget: Overview,
   * Runs and Events stay eager). Set, the shell renders it directly and `load`
   * resolves to the same component.
   */
  component?: ComponentType<ViewProps>;
};

/**
 * Single-key list verbs that would double-fire under a `g` chord. The `?`
 * cheatsheet and `RESERVED_GO_SUFFIXES` both read this list — do not duplicate
 * the keys or labels elsewhere (WM-857).
 */
export const LIST_VERBS: readonly { keys: string; does: string }[] = [
  { keys: "a", does: "approve proposal (Proposals) · ack item (Inbox)" },
  {
    keys: "x",
    does: "reject proposal (Proposals) · cancel run (Runs) · resolve item (Inbox)",
  },
];

/**
 * `g` suffixes no view may take: list verbs above, `i` and `0`–`9` (context
 * chords, WM-235), and `h` (Projects' `g h` opens GitHub).
 */
export const RESERVED_GO_SUFFIXES: ReadonlySet<string> = new Set([
  ...LIST_VERBS.map((v) => v.keys),
  "i",
  "h",
  ..."0123456789",
]);

/** Adapt a view's own props to the registry contract without touching the view. */
function adapt<P extends object>(
  Component: ComponentType<P>,
  map: (v: ViewProps) => P,
): ComponentType<ViewProps> {
  const Adapted = (v: ViewProps) => createElement(Component, map(v));
  Adapted.displayName = `View(${Component.displayName ?? Component.name})`;
  return Adapted;
}

/** Lazy-import a named export and adapt it. */
function load<M, K extends keyof M>(
  importer: () => Promise<M>,
  name: K,
  map: M[K] extends ComponentType<infer P> ? (v: ViewProps) => P : never,
): () => Promise<{ default: ComponentType<ViewProps> }> {
  return () =>
    importer().then((m) => ({
      default: adapt(
        m[name] as ComponentType<object>,
        map as (v: ViewProps) => object,
      ),
    }));
}

const at = (params: readonly string[], i: number) => params[i] ?? null;

export function listSelectionPath(
  view: "runs" | "proposals",
  id: string | null,
  hash: string,
) {
  const path = hashPath(view, id);
  const query = hashSearch(hash);
  if (!query.has("population") || !query.has("from") || !query.has("to"))
    return path;
  query.delete("project");
  return `${path}?${query.toString()}`;
}

export const workerHash = (
  id: string | null,
  health: WorkerHealthFilter | null,
) => {
  const path = hashPath("workers", id);
  return health ? `${path}?health=${encodeURIComponent(health)}` : path;
};

/** The full reader accepts only catalogue return paths; direct links fall back. */
export function artifactBackPath(hash: string): string {
  const back = hashSearch(hash).get("back");
  return back && hashView(back) === "artifacts" ? back : "artifacts";
}

// First-paint views (entry chunk, no Suspense flash on the operator's landing).
const OverviewView = adapt(Overview, ({ navigate, shell }) => ({
  connected: shell.connected,
  context: shell.context,
  onJumpRun: shell.jump.run,
  onJumpProposal: shell.jump.proposal,
  onJumpEvents: shell.jump.events,
  onJumpRuns: shell.jump.runs,
  onJumpWorkers: shell.jump.workers,
  onNavigate: navigate,
  onJumpExpired: () => {
    shell.setFocusExpired(true);
    navigate("proposals");
  },
  onJumpGraph: () => shell.jump.graph(),
  onInject: () => shell.openInject(),
}));

const RunsView = adapt(Runs, ({ params, navigate, shell }) => ({
  connected: shell.connected,
  context: shell.context,
  focusRunId: at(params, 0),
  onSelectRun: (id: string | null) =>
    navigate(listSelectionPath("runs", id, window.location.hash)),
  onOpenFull: shell.jump.runFull,
  focusState: shell.focusRunState,
  onFocusStateConsumed: shell.clearFocusRunState,
  onJumpAgent: shell.jump.agent,
  onJumpEvent: shell.jump.event,
  onJumpProposal: shell.jump.proposal,
  rejumpEpoch: shell.rejumpEpoch,
}));

const EventsView = adapt(Events, ({ params, hash, navigate, shell }) => {
  const source = at(params, 0);
  const eventId = at(params, 1);
  const hashEvent: EventFocus | null =
    source && eventId ? { source, eventId } : null;
  const typeFromHash = hashSearch(hash).get("type");
  const focusEvent: EventFocus = {
    ...(shell.ephemeralEvent ?? {}),
    ...(typeFromHash ? { type: typeFromHash } : {}),
    ...(hashEvent ?? {}),
  };
  const hasEventFocus = !!(
    focusEvent.source ||
    focusEvent.eventId ||
    focusEvent.status ||
    focusEvent.type
  );
  return {
    connected: shell.connected,
    context: shell.context,
    focusEvent: hasEventFocus ? focusEvent : null,
    onFocusConsumed: () => shell.setEphemeralEvent(null),
    onSelectEvent: (s: string | null, e?: string) =>
      navigate(eventsHash(s, e, typeFromHash)),
    onSelectType: (type: string | null) =>
      navigate(eventsHash(hashEvent?.source, hashEvent?.eventId, type)),
    onJumpProposal: shell.jump.proposal,
    onJumpRun: shell.jump.run,
    onJumpChain: shell.jump.chain,
    onTriggerAgain: (envelope: Record<string, unknown>) =>
      shell.openInject(envelope),
    onInject: () => shell.openInject(),
    rejumpEpoch: shell.rejumpEpoch,
  };
});

const eager = (component: ComponentType<ViewProps>) => ({
  component,
  load: () => Promise.resolve({ default: component }),
});

const DEFS = [
  // Attention / Live Actions (badge-carrying / immediate triage)
  {
    key: "overview",
    label: "Overview",
    go: "o",
    group: "live",
    params: [],
    ...eager(OverviewView),
  },
  {
    key: "metrics",
    label: "Metrics",
    go: "m",
    group: "live",
    params: [],
    load: load(
      () => import("./Metrics"),
      "Metrics",
      () => ({}),
    ),
  },
  {
    key: "inbox",
    label: "Inbox",
    go: "n",
    group: "live",
    // `#/inbox/:id` — the Telegram push deep-links here (lib/inbox.mjs telegramMessage).
    params: [":id"],
    load: load(
      () => import("./Inbox"),
      "Inbox",
      ({ params, navigate, shell }) => ({
        connected: shell.connected,
        focusItemId: at(params, 0),
        onSelectItem: (id) => navigate(hashPath("inbox", id)),
        onJumpRun: shell.jump.run,
        onJumpProposal: shell.jump.proposal,
        onJumpEvent: shell.jump.event,
      }),
    ),
  },
  {
    key: "proposals",
    label: "Proposals",
    go: "p",
    group: "live",
    params: [":id"],
    load: load(
      () => import("./Proposals"),
      "Proposals",
      ({ params, navigate, shell }) => ({
        connected: shell.connected,
        healthPending: shell.healthPending,
        context: shell.context,
        onRunQueued: shell.jump.run,
        focusProposalId: at(params, 0),
        onSelectProposal: (id) =>
          navigate(listSelectionPath("proposals", id, window.location.hash)),
        focusExpired: shell.focusExpired,
        onFocusExpiredConsumed: () => shell.setFocusExpired(false),
        onJumpAgent: shell.jump.agent,
        onJumpEvent: shell.jump.event,
        rejumpEpoch: shell.rejumpEpoch,
      }),
    ),
  },
  {
    key: "runs",
    label: "Runs",
    go: "r",
    group: "live",
    params: [":id"],
    ...eager(RunsView),
  },
  {
    key: "events",
    label: "Events",
    go: "e",
    group: "live",
    params: [":source", ":eventId"],
    ...eager(EventsView),
  },

  // Work Journey (artifact and execution lifecycle)
  {
    key: "tickets",
    label: "Tickets",
    go: "k",
    group: "work",
    // An id-less route presents the ticket picker.
    params: [":id"],
    loading: "ticket journey",
    load: load(
      () => import("./Ticket"),
      "Ticket",
      ({ params, shell }) => ({
        ticketId: at(params, 0),
        onNavigate: shell.jump.ticket,
        onNavigatePr: shell.jump.pr,
      }),
    ),
  },
  {
    key: "chains",
    label: "Chains",
    go: "l",
    group: "work",
    params: [],
    load: load(
      () => import("./Chains"),
      "Chains",
      ({ hash, shell }) => ({
        context: shell.context,
        initialStateFilter: hashSearch(hash).get("state"),
        onOpenChain: (correlationId) => shell.jump.chain(correlationId),
      }),
    ),
  },
  {
    key: "projects",
    label: "Projects",
    go: "f",
    group: "work",
    params: [":name"],
    load: load(
      () => import("./Projects"),
      "Projects",
      ({ params, navigate, shell }) => ({
        connected: shell.connected,
        focusRepoName: at(params, 0),
        onSelectRepo: (name) => navigate(hashPath("projects", name)),
      }),
    ),
  },
  {
    key: "artifacts",
    label: "Artifacts",
    go: "y",
    group: "work",
    params: [],
    load: load(
      () => import("./Artifacts"),
      "Artifacts",
      ({ hash, navigate, shell }) => {
        const query = hashSearch(hash);
        const filters: ArtifactFilters = {
          kind: query.get("kind"),
          orphan: query.has("orphan") ? query.get("orphan") === "true" : null,
          search: query.get("search") ?? "",
        };
        return {
          metrics: shell.status?.artifacts,
          filters,
          onFiltersChange: (next) => navigate(artifactsHash(next)),
          onJumpRun: shell.jump.run,
          onOpenFull: shell.jump.artifactFull,
        };
      },
    ),
  },

  // Machinery & Topology (configuration, workers, cadence, graph)
  {
    key: "agents",
    label: "Agents",
    go: "t",
    group: "machinery",
    params: [":ref"],
    load: load(
      () => import("./Agents"),
      "Agents",
      ({ params, navigate, shell }) => ({
        context: shell.context,
        focusAgentRef: at(params, 0),
        onSelectAgent: (ref) => navigate(hashPath("agents", ref)),
      }),
    ),
  },
  {
    key: "workers",
    label: "Workers",
    go: "w",
    group: "machinery",
    params: [":id"],
    load: load(
      () => import("./Workers"),
      "Workers",
      ({ params, hash, navigate, shell }) => {
        const healthFromHash = hashSearch(hash).get("health");
        const focusHealth = isWorkerHealthFilter(healthFromHash)
          ? healthFromHash
          : null;
        return {
          context: shell.context,
          focusWorkerId: at(params, 0),
          onSelectWorker: (id) => navigate(workerHash(id, focusHealth)),
          focusHealth,
          onFocusHealthChange: (health) => navigate(workerHash(null, health)),
        };
      },
    ),
  },
  {
    key: "schedules",
    label: "Schedules",
    go: "s",
    group: "machinery",
    params: [":loop"],
    load: load(
      () => import("./Schedules"),
      "Schedules",
      ({ params, navigate, shell }) => ({
        connected: shell.connected,
        context: shell.context,
        focusScheduleLoop: at(params, 0),
        onSelectSchedule: (loop) => navigate(hashPath("schedules", loop)),
        onJumpProposal: shell.jump.proposal,
        onJumpRun: shell.jump.run,
        onJumpEvent: shell.jump.event,
        onJumpAgent: shell.jump.agent,
        rejumpEpoch: shell.rejumpEpoch,
      }),
    ),
  },
  {
    key: "graph",
    label: "Graph",
    go: "g",
    group: "machinery",
    params: [":nodeId"],
    load: load(
      () => import("./Graph"),
      "Graph",
      ({ params, navigate, shell }) => ({
        context: shell.context,
        focusNodeId: at(params, 0),
        onSelectNode: (id) => navigate(hashPath("graph", id)),
        onJumpAgent: shell.jump.agent,
        onJumpEvents: shell.jump.events,
        onJumpProposal: shell.jump.proposal,
      }),
    ),
  },

  // System
  {
    key: "settings",
    label: "Settings",
    go: "c",
    group: "system",
    params: [":section"],
    load: load(
      () => import("./Settings"),
      "Settings",
      ({ params, navigate }) => ({
        focusSectionId: at(params, 0),
        onSelectSection: (id) => navigate(hashPath("settings", id)),
      }),
    ),
  },

  // Drill-in routes: reached from a parent view (or ⌘K), not from the rail.
  // Distinct first segments so crossing from the list pushes history and Back
  // restores the panel.
  {
    key: "run",
    label: "Run",
    parent: "runs",
    fallback: "runs",
    params: [":id"],
    load: load(
      () => import("./RunFull"),
      "RunFull",
      ({ params, navigate, shell }) => {
        const runId = params[0]!;
        return {
          runId,
          connected: shell.connected,
          onBack: () => navigate(hashPath("runs", runId)),
          onJumpAgent: shell.jump.agent,
          onJumpEvent: shell.jump.event,
          onJumpProposal: shell.jump.proposal,
          onJumpChain: shell.jump.chain,
        };
      },
    ),
  },
  {
    // The PR journey (WM-640) shares the ticket journey chunk — same layout,
    // other subject.
    key: "prs",
    label: "PR",
    parent: "tickets",
    params: [":number"],
    loading: "PR journey",
    load: load(
      () => import("./Ticket"),
      "PullRequest",
      ({ params, shell }) => ({
        number: at(params, 0),
        onNavigateTicket: shell.jump.ticket,
      }),
    ),
  },
  {
    // `#/chain/:correlationId[/:nodeId]` — the chain trace (WM-527); node
    // selection rides the hash so a pasted link lands on the same node.
    key: "chain",
    label: "Chain",
    parent: "chains",
    fallback: "overview",
    params: [":correlationId", ":nodeId"],
    load: load(
      () => import("./Chain"),
      "Chain",
      ({ params, navigate, shell }) => {
        const correlationId = params[0]!;
        return {
          correlationId,
          focusNodeId: at(params, 1),
          onSelectNode: (id) => navigate(hashPath("chain", correlationId, id)),
          onJumpEvent: shell.jump.event,
          onJumpRun: shell.jump.run,
          onOpenRunFull: shell.jump.runFull,
          onJumpProposal: shell.jump.proposal,
          onJumpAgent: shell.jump.agent,
        };
      },
    ),
  },
  {
    // `#/artifact/:digest` is the full-page artifact reader view (WM-828).
    key: "artifact",
    label: "Artifact",
    parent: "artifacts",
    fallback: "artifacts",
    params: [":digest"],
    load: load(
      () => import("./ArtifactFull"),
      "ArtifactFull",
      ({ params, hash, navigate, shell }) => ({
        digest: params[0]!,
        onBack: () => navigate(artifactBackPath(hash)),
        onJumpRun: shell.jump.run,
      }),
    ),
  },
] as const satisfies readonly ViewDef[];

/** Every view, rail order first, then the drill-in routes. */
export const VIEWS: readonly ViewDef[] = DEFS;

export type ViewKey = (typeof DEFS)[number]["key"];
export type NavItem = ViewDef & { key: NavKey; go: string; group: NavGroup };
export type NavKey = Extract<(typeof DEFS)[number], { go: string }>["key"];

/**
 * The nav rail: the chorded, grouped subset of VIEWS — same objects, so a
 * consumer that reads NAV sees exactly what the shell derives from VIEWS.
 */
export const NAV: readonly NavItem[] = VIEWS.filter(
  (v): v is NavItem => v.go !== undefined && v.group !== undefined,
);

const byKey = new Map<string, ViewDef>(VIEWS.map((v) => [v.key, v]));
const DEFAULT_VIEW = byKey.get("overview")!;

export function findView(key: string | undefined): ViewDef | undefined {
  return key === undefined ? undefined : byKey.get(key);
}

/** Rail entry `key` stays current on its own route and on its drill-ins. */
export function navIsCurrent(key: string, view?: string): boolean {
  return key === view || (view !== undefined && findView(view)?.parent === key);
}

/** Page-title / rail label for the current first segment. */
export function viewLabel(view: string | undefined): string {
  return findView(view)?.label ?? DEFAULT_VIEW.label;
}

/**
 * Hash segments → the view to render and its params. Unknown keys land on
 * Overview (the pre-registry not-found behaviour); an id-less drill-in falls
 * back to its list view.
 */
export function resolveView(route: readonly string[]): ResolvedView {
  const def = findView(route[0] ?? DEFAULT_VIEW.key);
  if (!def) return resolved(DEFAULT_VIEW, []);
  if (def.fallback && !route[1]) {
    return resolved(byKey.get(def.fallback) ?? DEFAULT_VIEW, []);
  }
  return resolved(def, route.slice(1));
}

export type ResolvedView = {
  def: ViewDef;
  params: string[];
  /** Stable per view: the eager component, or the one `lazy(def.load)` made at module load. */
  component: ComponentType<ViewProps>;
};

// One lazy() per view, created once — a fresh lazy() per render would remount
// the view (and refetch its chunk's module state) on every shell re-render.
const components = new Map<string, ComponentType<ViewProps>>(
  VIEWS.map((v) => [v.key, v.component ?? lazy(v.load)]),
);

function resolved(def: ViewDef, params: string[]): ResolvedView {
  return { def, params, component: components.get(def.key)! };
}
