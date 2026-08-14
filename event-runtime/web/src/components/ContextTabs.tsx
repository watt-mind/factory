import { useEffect, useMemo, useRef, useState } from "react";
import type { OperatorContext } from "../context";
import { INFLIGHT, toggleInflight } from "../context";
import { CONTEXT_TABS_ATTR } from "../hooks";
import type { RepoItem } from "../types";

export const PINNED_RUNS_STORAGE_KEY = "factory.pinnedRuns";

export const readPinnedRuns = (): string[] => {
  try {
    return JSON.parse(sessionStorage.getItem(PINNED_RUNS_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
};

export const savePinnedRuns = (runs: string[]) => {
  try {
    sessionStorage.setItem(PINNED_RUNS_STORAGE_KEY, JSON.stringify(runs));
  } catch {}
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("factory:pinnedRunsChanged", { detail: runs }));
  }
};

const getHashRunId = () => {
  const m = typeof window !== "undefined" ? window.location.hash.match(/^#\/runs?\/([^?&#]+)/) : null;
  return m ? decodeURIComponent(m[1]) : null;
};

export function ScopeCaption({
  context,
  surface,
}: {
  context: OperatorContext;
  surface: "fleet" | "registry" | "graph" | "overview";
}) {
  if (context.kind === "all") return null;
  const n = context.kind === "inflight" ? "In flight" : context.name;
  return (
    <p className="mb-3 text-[11px] text-(--text-faint)">
      {context.kind === "inflight"
        ? surface === "overview"
          ? "In flight scopes Runs list — counts are factory-wide."
          : "In flight scopes Runs list."
        : `${surface === "overview" ? "Overview counts are" : `${surface} is`} not scoped to ${n}.`}
    </p>
  );
}

/**
 * Linear-style context strip: All (pinned) · open repos · pinned run tabs · In flight (pinned) · +.
 * A tab is a filter, not a container. Closing a repo tab returns to All.
 */
export function ContextTabs({
  repos,
  reposError,
  openRepos,
  active,
  onSelect,
  onOpen,
  onClose,
  pinnedRuns: propPinnedRuns,
  onUnpinRun: propOnUnpinRun,
}: {
  repos: RepoItem[];
  reposError: boolean;
  openRepos: string[];
  active: OperatorContext;
  onSelect: (ctx: OperatorContext) => void;
  onOpen: (name: string) => void;
  onClose: (name: string) => void;
  pinnedRuns?: string[];
  onUnpinRun?: (runId: string) => void;
}) {
  const [picker, setPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [internalPinned, setInternalPinned] = useState<string[]>(readPinnedRuns);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => setInternalPinned(readPinnedRuns());
    window.addEventListener("factory:pinnedRunsChanged", handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("factory:pinnedRunsChanged", handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  const pinnedRuns = propPinnedRuns ?? internalPinned;
  const [activeRunId, setActiveRunId] = useState<string | null>(getHashRunId);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHash = () => setActiveRunId(getHashRunId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const unpinRun = (runId: string) => {
    if (propOnUnpinRun) propOnUnpinRun(runId);
    else {
      const next = pinnedRuns.filter((id) => id !== runId);
      setInternalPinned(next);
      savePinnedRuns(next);
    }
    if (activeRunId === runId && typeof window !== "undefined") {
      window.location.hash = "#/runs";
    }
  };

  const available = useMemo(
    () => repos.filter((r) => !openRepos.includes(r.name)),
    [repos, openRepos],
  );

  const activeId =
    activeRunId && pinnedRuns.includes(activeRunId)
      ? `run:${activeRunId}`
      : active.kind === "repo"
        ? active.name
        : active.kind;

  const activeTab = () =>
    stripRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null;

  const tabIds = useMemo(
    () => ["all", ...openRepos, ...pinnedRuns.map((id) => `run:${id}`), INFLIGHT],
    [openRepos, pinnedRuns],
  );
  const [tabStopId, setTabStopId] = useState<string | null>(null);

  const effectiveTabStop =
    tabStopId && tabIds.includes(tabStopId)
      ? tabStopId
      : tabIds.includes(activeId)
        ? activeId
        : "all";

  useEffect(() => {
    setTabStopId(tabIds.includes(activeId) ? activeId : "all");
  }, [activeId, tabIds]);

  useEffect(() => {
    activeTab()?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);

  const [closes, setCloses] = useState(0);
  useEffect(() => {
    if (!closes) return;
    const focused = document.activeElement;
    if (focused == null || focused === document.body) activeTab()?.focus();
  }, [closes]);

  useEffect(() => {
    if (!picker) return;
    function onDoc(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPicker(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setPicker(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picker]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const currentId = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-context-tab]")?.getAttribute("data-context-tab");
    if (!currentId) return;
    const currentIndex = tabIds.indexOf(currentId);
    if (currentIndex === -1) return;

    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      const nextId =
        e.key === "Home"
          ? tabIds[0]
          : e.key === "End"
            ? tabIds[tabIds.length - 1]
            : tabIds[(currentIndex + delta + tabIds.length) % tabIds.length];
      setTabStopId(nextId);
      stripRef.current?.querySelector<HTMLButtonElement>(`[data-context-tab="${nextId}"]`)?.focus();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      if (openRepos.includes(currentId)) onClose(currentId);
      else if (currentId.startsWith("run:")) unpinRun(currentId.slice(4));
      setCloses((n) => n + 1);
    }
  };

  // Active state uses the accent tokens (not --surface-3) so it stays visible
  // against --surface-1 in light theme, where the two grays sit too close (WM-91).
  const tabClass = (id: string) =>
    `flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium ${
      activeId === id
        ? "bg-(--accent-dim) text-(--text) ring-1 ring-inset ring-(--accent)"
        : "text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
    }`;

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-0.5 border-b border-(--border) bg-(--surface-1) px-2">
      <div
        ref={stripRef}
        className="flex min-w-0 flex-1 items-stretch gap-0.5"
        role="toolbar"
        aria-label="Context"
        onKeyDown={handleKeyDown}
        {...{ [CONTEXT_TABS_ATTR]: "" }}
      >
        <button
          type="button"
          data-context-tab="all"
          tabIndex={effectiveTabStop === "all" ? 0 : -1}
          aria-pressed={!activeRunId && active.kind === "all"}
          className={tabClass("all")}
          onClick={() => {
            if (activeRunId && typeof window !== "undefined") window.location.hash = "#/runs";
            onSelect({ kind: "all" });
          }}
          onFocus={() => setTabStopId("all")}
        >
          All
        </button>
        <div
          role="presentation"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {openRepos.map((name) => (
            <div key={name} role="presentation" className="flex shrink-0 items-center">
              <button
                type="button"
                data-context-tab={name}
                tabIndex={effectiveTabStop === name ? 0 : -1}
                aria-pressed={!activeRunId && active.kind === "repo" && active.name === name}
                className={tabClass(name)}
                onClick={() => {
                  if (activeRunId && typeof window !== "undefined") window.location.hash = `#/runs?project=${encodeURIComponent(name)}`;
                  onSelect({ kind: "repo", name });
                }}
                onFocus={() => setTabStopId(name)}
              >
                {name}
              </button>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Close ${name}`}
                title={`Close ${name}`}
                className="rounded px-1 text-[11px] text-(--text-faint) hover:text-(--text)"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(name);
                  setCloses((n) => n + 1);
                }}
              >
                ×
              </button>
            </div>
          ))}
          {pinnedRuns.map((runId) => {
            const isRunActive = activeRunId === runId;
            const tabKey = `run:${runId}`;
            return (
              <div key={tabKey} role="presentation" className="flex shrink-0 items-center">
                <button
                  type="button"
                  data-context-tab={tabKey}
                  tabIndex={effectiveTabStop === tabKey ? 0 : -1}
                  aria-pressed={isRunActive}
                  className={tabClass(tabKey)}
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      window.location.hash = `#/runs/${encodeURIComponent(runId)}`;
                    }
                  }}
                  onFocus={() => setTabStopId(tabKey)}
                  title={`Run ${runId}`}
                >
                  <span className="opacity-70 text-[10px]" aria-hidden="true">▶</span>
                  <span className="mono max-w-32 truncate">{runId}</span>
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Close ${runId}`}
                  title={`Close ${runId}`}
                  className="rounded px-1 text-[11px] text-(--text-faint) hover:text-(--text)"
                  onClick={(e) => {
                    e.stopPropagation();
                    unpinRun(runId);
                    setCloses((n) => n + 1);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          data-context-tab={INFLIGHT}
          tabIndex={effectiveTabStop === INFLIGHT ? 0 : -1}
          aria-pressed={!activeRunId && active.kind === "inflight"}
          className={tabClass(INFLIGHT)}
          onClick={() => {
            const next = toggleInflight(active);
            if (activeRunId && typeof window !== "undefined") {
              window.location.hash = next.kind === "inflight" ? "#/runs?project=inflight" : "#/runs";
            }
            onSelect(next);
          }}
          onFocus={() => setTabStopId(INFLIGHT)}
        >
          In flight
        </button>
      </div>
      <div className="relative flex shrink-0 items-center" ref={pickerRef}>
        <button
          type="button"
          aria-expanded={picker}
          aria-haspopup="listbox"
          aria-controls="repo-picker-listbox"
          aria-label="Open a repo tab"
          title="Open a repo"
          className="rounded-md px-2 py-1 text-[14px] text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
          onClick={() => setPicker((open) => !open)}
        >
          +
        </button>
        {picker && (
          <div
            id="repo-picker-listbox"
            role="listbox"
            aria-label="Factory repos"
            className="absolute top-full right-0 z-30 mt-1 max-h-72 min-w-48 overflow-auto rounded-md border border-(--border) bg-(--surface-1) py-1 shadow-lg"
          >
            {reposError ? (
              <div className="px-3 py-2 text-[12px] text-(--text-faint)">Cannot reach /repos.</div>
            ) : available.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-(--text-faint)">
                {repos.length === 0 ? "No repos in the registry." : "All repos are open."}
              </div>
            ) : (
              available.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  role="option"
                  className="block w-full px-3 py-1.5 text-left text-[12px] text-(--text) hover:bg-(--surface-2)"
                  onClick={() => {
                    onOpen(r.name);
                    setPicker(false);
                  }}
                >
                  {r.name}
                  {r.team ? <span className="ml-2 text-(--text-faint)">{r.team}</span> : null}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
