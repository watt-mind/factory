import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { useHashRoute, useTheme } from "./hooks";
import { CommandPalette, useGoSequences, type PaletteAction } from "./components/CommandPalette";
import { InjectDialog } from "./components/InjectDialog";
import { ToastContainer } from "./components/ui";
import { Agents } from "./views/Agents";
import { Events } from "./views/Events";
import { Graph } from "./views/Graph";
import { Overview } from "./views/Overview";
import { Proposals } from "./views/Proposals";
import { Runs } from "./views/Runs";

// Agents rides `g t` ("what is this agent?"): o/e/p/r are taken, and `g a`
// would double-fire the proposals view's `a` (approve) list key — chord
// suffixes must never collide with single-key verbs.
const NAV = [
  { key: "overview", label: "Overview", go: "o" },
  { key: "events", label: "Events", go: "e" },
  { key: "proposals", label: "Proposals", go: "p" },
  { key: "runs", label: "Runs", go: "r" },
  { key: "agents", label: "Agents", go: "t" },
  { key: "graph", label: "Graph", go: "g" },
] as const;

export function App() {
  const [route, navigate] = useHashRoute();
  const view = route[0];
  const [, cycleTheme] = useTheme();
  const [injectOpen, setInjectOpen] = useState(false);
  const [focusRunId, setFocusRunId] = useState<string | null>(null);
  const [focusProposalId, setFocusProposalId] = useState<string | null>(null);
  const [focusEventStatus, setFocusEventStatus] = useState<string | null>(null);
  const [focusAgentRef, setFocusAgentRef] = useState<string | null>(null);

  const jumpToRun = (runId: string) => {
    setFocusRunId(runId);
    navigate("runs");
  };
  const jumpToProposal = (id: string) => {
    setFocusProposalId(id);
    navigate("proposals");
  };
  const jumpToEvents = (status: string) => {
    setFocusEventStatus(status);
    navigate("events");
  };
  const jumpToAgent = (ref: string) => {
    setFocusAgentRef(ref);
    navigate("agents");
  };

  // Deep link #/runs/:id → the runs view with that run selected, then
  // normalize the hash so the master-detail pane owns selection state.
  useEffect(() => {
    if (route[0] === "runs" && route[1]) {
      setFocusRunId(route[1]);
      navigate("runs");
    }
  }, [route, navigate]);

  // Connection indicator (spec §4.1): reads keep rendering from cache when
  // the runtime is down; verbs disable.
  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 2000,
    retry: false,
  });
  const connected = health.isSuccess;

  const status = useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 2000 });
  const openProposals = status.data?.proposals.open ?? 0;
  const activeRuns = Object.entries(status.data?.runs.byState ?? {})
    .filter(([s]) => ["QUEUED", "LEASED", "RUNNING", "VERIFYING"].includes(s))
    .reduce((sum, [, n]) => sum + (n ?? 0), 0);
  // Events needing an operator: the two statuses requeue exists for.
  const eventAttention =
    (status.data?.events.human_needed ?? 0) + (status.data?.events.dead_lettered ?? 0);

  // Environment chip: which runtime this UI can mutate. "live" wears the
  // warning tone — approving there triggers real agent runs; anything else
  // (dev, or a serve-wide fake-adapter override) stays informational.
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

  useGoSequences(
    useMemo(
      () => Object.fromEntries(NAV.map((n) => [n.go, () => navigate(n.key)])),
      [navigate],
    ),
  );

  const paletteActions: PaletteAction[] = [
    ...NAV.map((n) => ({ label: `Go to ${n.label}`, hint: `g ${n.go}`, run: () => navigate(n.key) })),
    { label: "Inject event…", run: () => setInjectOpen(true) },
    { label: "Cycle theme (dark → light → contrast)", run: cycleTheme },
  ];

  return (
    <div className="flex h-screen">
      <nav className="flex w-52 shrink-0 flex-col border-r border-(--border) bg-(--surface-1)">
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <img src="/watt-mind-logo.svg" alt="Watt Mind" className="size-5.5 shrink-0" />
            <span className="display text-[14px] font-semibold">factory</span>
          </div>
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
            title={
              env
                ? `${env.home} · policy ${health.data?.policyVersion}`
                : "runtime unreachable"
            }
            style={{
              color: envHue,
              background: `color-mix(in oklch, ${envHue} 15%, transparent)`,
            }}
          >
            {envLabel}
          </span>
        </div>
        <div className="flex-1 px-2">
          {NAV.map((n) => {
            const count =
              n.key === "proposals"
                ? openProposals
                : n.key === "runs"
                  ? activeRuns
                  : n.key === "events"
                    ? eventAttention
                    : 0;
            return (
              <button
                key={n.key}
                type="button"
                onClick={() => navigate(n.key)}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] ${
                  view === n.key
                    ? "bg-(--surface-3) font-medium text-(--text)"
                    : "text-(--text-dim) hover:bg-(--surface-2)"
                }`}
              >
                <span>{n.label}</span>
                {count > 0 && (
                  <span
                    className="rounded px-1.5 text-[11px] tabular-nums"
                    style={{
                      color: "var(--accent)",
                      background: "color-mix(in oklch, var(--accent) 14%, transparent)",
                    }}
                  >
                    {count}
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
            Inject event…
          </button>
        </div>
        <div className="border-t border-(--border) px-4 py-3 text-[11px]">
          <div className="flex items-center gap-2">
            <span
              className="size-2 rounded-full"
              style={{ background: connected ? "var(--hue-ok)" : "var(--hue-err)" }}
            />
            {connected ? (
              <span className="text-(--text-dim)">
                connected · <span className="mono">{health.data?.policyVersion}</span>
              </span>
            ) : (
              <span style={{ color: "var(--hue-err)" }}>runtime unreachable</span>
            )}
          </div>
          <div className="mt-1.5 text-(--text-faint)">
            <span className="mono">⌘K</span> commands · <span className="mono">g</span>+
            <span className="mono">o/e/p/r/t/g</span> navigate
          </div>
        </div>
      </nav>

      <main className="min-w-0 flex-1">
        {view === "proposals" ? (
          <Proposals
            connected={connected}
            onRunQueued={jumpToRun}
            focusProposalId={focusProposalId}
            onFocusConsumed={() => setFocusProposalId(null)}
            onJumpAgent={jumpToAgent}
          />
        ) : view === "runs" ? (
          <Runs
            connected={connected}
            focusRunId={focusRunId}
            onFocusConsumed={() => setFocusRunId(null)}
            onJumpAgent={jumpToAgent}
          />
        ) : view === "graph" ? (
          <Graph />
        ) : view === "agents" ? (
          <Agents focusAgentRef={focusAgentRef} onFocusConsumed={() => setFocusAgentRef(null)} />
        ) : view === "events" ? (
          <Events
            connected={connected}
            focusStatus={focusEventStatus}
            onFocusConsumed={() => setFocusEventStatus(null)}
          />
        ) : (
          <Overview
            connected={connected}
            onJumpRun={jumpToRun}
            onJumpProposal={jumpToProposal}
            onJumpEvents={jumpToEvents}
            onNavigate={navigate}
          />
        )}
      </main>

      <CommandPalette actions={paletteActions} onJumpRun={jumpToRun} onJumpProposal={jumpToProposal} />
      {injectOpen && <InjectDialog onClose={() => setInjectOpen(false)} />}
      <ToastContainer />
    </div>
  );
}
