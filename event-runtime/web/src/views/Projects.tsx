import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { contextFromProject, type OperatorContext } from "../context";
import { hashProject } from "../hash";
import { keyGuard, useListKeys, useTabKeys } from "../hooks";
import {
  cycleColumnSort,
  defaultDisplayState,
  sortRows,
  type DisplayConfig,
} from "../displayOptions";
import { goPrefixActive } from "../goSequence";
import { setContextActions } from "../palette";
import type { JanitorResult, RepoItem } from "../types";
import { ScopeCaption } from "../components/ContextTabs";

const PROJECT_MODES = ["ALL", "DISPATCHABLE", "REPORT_ONLY"] as const;
type ProjectMode = (typeof PROJECT_MODES)[number];

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=true]"));
}
import {
  Button,
  CopyActions,
  DetailPane,
  Dialog,
  FilterInput,
  KV,
  ListEmpty,
  ListPane,
  Section,
  Th,
  VerbError,
  copyLink,
  copyText,
  notify,
} from "../components/ui";

const projectTarget = (repo: RepoItem) => repo.project || repo.github || repo.path;
const worktreeScripts = (repo: RepoItem) =>
  [repo.hasWorktreeUp && "up", repo.hasWorktreeDown && "down", repo.hasWorktreeWarm && "warm"]
    .filter(Boolean)
    .join(" · ") || "—";

const PROJECTS_SORT: DisplayConfig<RepoItem> = {
  view: "projects-table-sort",
  groups: [],
  sorts: [
    { key: "name", label: "Name", get: (repo) => repo.name, column: "name" },
    { key: "team", label: "Team", get: (repo) => repo.team ?? "", column: "team" },
    { key: "target", label: "Project / GitHub", get: projectTarget, column: "target" },
    { key: "mode", label: "Mode", get: (repo) => Number(repo.reportOnly), column: "mode" },
    {
      key: "base",
      label: "Base",
      get: (repo) => `${repo.base}:${repo.deployBranch ?? ""}`,
      column: "base",
    },
    { key: "scripts", label: "Worktree Scripts", get: worktreeScripts, column: "scripts" },
  ],
  columns: [
    { key: "name", label: "Name" },
    { key: "team", label: "Team" },
    { key: "target", label: "Project / GitHub" },
    { key: "mode", label: "Mode" },
    { key: "base", label: "Base" },
    { key: "scripts", label: "Worktree Scripts" },
  ],
};

/** Live operator context from the hash — same source App uses. Read on every render: context-tab switches replaceState and do not fire hashchange. Do not read sessionStorage: stale `active` must not caption All. */
function operatorContext(): OperatorContext {
  return contextFromProject(hashProject(typeof window === "undefined" ? "" : window.location.hash));
}

/** Projects view (OPS-300 + OPS-362): configured factory repositories and janitor maintenance. */
export function Projects({
  connected,
  focusRepoName,
  onSelectRepo,
}: {
  connected: boolean;
  focusRepoName: string | null;
  onSelectRepo: (name: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const context = operatorContext();
  const [filter, setFilter] = useState("");
  const [filterMode, setFilterMode] = useState<ProjectMode>("ALL");
  useTabKeys(PROJECT_MODES, filterMode, setFilterMode);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (goPrefixActive()) return;
      if (isTypingTarget(e.target)) return;
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= PROJECT_MODES.length) {
        e.preventDefault();
        setFilterMode(PROJECT_MODES[num - 1]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Janitor state per selected repo
  const [dryResult, setDryResult] = useState<JanitorResult | null>(null);
  const [applyResult, setApplyResult] = useState<JanitorResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [dispatchConfirm, setDispatchConfirm] = useState<{
    type: string;
    payload: Record<string, unknown>;
    label: string;
    repo: string;
  } | null>(null);

  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
  });
  const env = health.data?.env;

  const query = useQuery({
    queryKey: ["repos"],
    queryFn: api.repos,
    refetchInterval: 5000,
  });

  const repos = query.data?.repos ?? [];

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return repos.filter((r) => {
      if (filterMode === "DISPATCHABLE" && r.reportOnly) return false;
      if (filterMode === "REPORT_ONLY" && !r.reportOnly) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        (r.project && r.project.toLowerCase().includes(q)) ||
        (r.team && r.team.toLowerCase().includes(q)) ||
        (r.github && r.github.toLowerCase().includes(q))
      );
    });
  }, [repos, filter, filterMode]);
  const [sort, setSort] = useState(() => defaultDisplayState(PROJECTS_SORT));
  const visible = useMemo(() => sortRows(filtered, PROJECTS_SORT, sort), [filtered, sort]);

  const selectedName = focusRepoName;
  const selectedIndex = useMemo(() => visible.findIndex((r) => r.name === selectedName), [visible, selectedName]);
  const sel = selectedIndex >= 0 ? visible[selectedIndex] : null;

  // Reset janitor results when selected repo changes
  useEffect(() => {
    setDryResult(null);
    setApplyResult(null);
    setConfirmOpen(false);
    setConfirmInput("");
    setDispatchConfirm(null);
  }, [selectedName]);

  useEffect(() => {
    document.querySelector("tr.row-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    if (focusRepoName) setFilter("");
  }, [focusRepoName]);

  const pendingC = useRef<number>(0);

  useListKeys({
    count: visible.length,
    selected: selectedIndex,
    onSelect: (i) => onSelectRepo(visible[i]?.name ?? null),
    onClose: () => {
      if (selectedName) onSelectRepo(null);
      else if (filter) setFilter("");
    },
    keys: {
      c: () => {
        if (!sel) return;
        copyText(sel.name, "repo name");
        pendingC.current = Date.now();
      },
      p: () => {
        if (sel && pendingC.current > 0 && Date.now() - pendingC.current < 800) {
          copyText(sel.path, "repo path");
          pendingC.current = 0;
        }
      },
      l: () => {
        if (sel && pendingC.current > 0 && Date.now() - pendingC.current < 800) {
          copyLink();
          pendingC.current = 0;
        }
      },
    },
  });

  // Janitor dry run mutation
  const dryMutation = useMutation({
    mutationFn: (name: string) => api.janitor(name, false),
    onSuccess: (res) => {
      setDryResult(res);
      setApplyResult(null);
      notify(`Dry run complete: ${res.reclaimable.length} reclaimable worktrees found`);
    },
    onError: (err: ApiError) => {
      notify(`Dry run failed: ${err.message}`, "err");
    },
  });

  // Janitor apply mutation
  const applyMutation = useMutation({
    mutationFn: (name: string) => api.janitor(name, true),
    onSuccess: (res) => {
      setApplyResult(res);
      setConfirmOpen(false);
      setConfirmInput("");
      queryClient.invalidateQueries({ queryKey: ["repos"] });
      notify(`Cleaned ${res.removed.length} worktrees for ${res.repo}`);
    },
    onError: (err: ApiError) => {
      notify(`Janitor apply failed: ${err.message}`, "err");
    },
  });

  // Quick Dispatch mutation for factory agent events
  const quickDispatchMutation = useMutation({
    mutationFn: async ({ type, payload, label }: { type: string; payload: Record<string, unknown>; label: string }) => {
      return { label, res: await api.injectEvent(type, payload) };
    },
    onSuccess: (data) => {
      notify(`Dispatched ${data.label}`);
      setDispatchConfirm(null);
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["proposals"] });
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (err: ApiError) => {
      notify(`Dispatch failed: ${err.message}`, "err");
    },
  });

  // Context actions for ⌘K palette
  useEffect(() => {
    if (!sel) {
      setContextActions([]);
      return;
    }
    const r = sel;
    setContextActions([
      {
        label: `Dispatch Triage Scan on ${r.name}`,
        hint: "triage",
        run: () =>
          setDispatchConfirm({
            type: "factory.triage.requested",
            payload: { repo: r.name },
            label: `Triage Scan on ${r.name}`,
            repo: r.name,
          }),
      },
      {
        label: `Dispatch Status Report for ${r.name}`,
        hint: "status",
        run: () =>
          setDispatchConfirm({
            type: "factory.status-report.requested",
            payload: { repos: [r.name] },
            label: `Status Report for ${r.name}`,
            repo: r.name,
          }),
      },
      {
        label: `Dispatch Janitor Scan on ${r.name}`,
        hint: "janitor",
        run: () =>
          setDispatchConfirm({
            type: "factory.janitor-scan.requested",
            payload: { repo: r.name },
            label: `Janitor Scan on ${r.name}`,
            repo: r.name,
          }),
      },
      {
        label: `Copy ${r.name}`,
        hint: "c",
        run: () => copyText(r.name, "repo name"),
      },
      {
        label: `Copy path for ${r.name}`,
        hint: "c p",
        run: () => copyText(r.path, "repo path"),
      },
      {
        label: `Copy link to ${r.name}`,
        hint: "c l",
        run: copyLink,
      },
      {
        label: `Run Janitor dry-run on ${r.name}`,
        hint: "dry",
        run: () => dryMutation.mutate(r.name),
      },
      ...(r.github
        ? [
            {
              label: `Open ${r.name} on GitHub`,
              run: () => window.open(`https://github.com/${r.github}`, "_blank"),
            },
          ]
        : []),
    ]);
    return () => setContextActions([]);
  }, [sel, dryMutation]);

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
            <h1 className="display mb-4 text-lg font-semibold">Projects</h1>
            <ScopeCaption
              context={context}
              surface="registry"
              subject={{ label: "registry", plural: false }}
            />
            <div className="mb-3">
              <FilterInput
                value={filter}
                onChange={setFilter}
                placeholder="Filter repo, project, team, github… (/)"
                label="Filter repositories"
              />
            </div>
            <div className="mb-3 flex gap-1 text-[12px]" role="tablist" aria-label="Project mode">
              {PROJECT_MODES.map((mode, idx) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={filterMode === mode}
                  onClick={() => setFilterMode(mode)}
                  className={`rounded px-2 py-0.5 font-medium transition-colors ${
                    filterMode === mode
                      ? "bg-(--surface-3) text-(--text)"
                      : "text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
                  }`}
                >
                  {mode === "ALL" ? "All" : mode === "DISPATCHABLE" ? "Dispatchable" : "Report-Only"}
                  <span aria-hidden="true" className="mono ml-1 text-(--text-faint) text-[10px] opacity-70">
                    {idx + 1}
                  </span>
                </button>
              ))}
            </div>
          </>
        }
      >
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] text-(--text-faint)">
              {PROJECTS_SORT.columns.map((column) => {
                const field = PROJECTS_SORT.sorts.find((candidate) => candidate.column === column.key)!;
                return (
                  <Th
                    key={column.key}
                    label={column.label}
                    dir={sort.sortBy === field.key ? sort.sortDir : null}
                    onSort={() => setSort((state) => cycleColumnSort(PROJECTS_SORT, state, column.key))}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => {
              return (
                <tr
                  key={r.name}
                  onClick={() => onSelectRepo(r.name)}
                  aria-selected={i === selectedIndex}
                  className={`cursor-pointer hover:bg-(--surface-1) ${i === selectedIndex ? "row-selected" : ""}`}
                >
                  <td className="mono border-b border-(--border) px-3 py-1.5 font-semibold text-(--text)">{r.name}</td>
                  <td className="border-b border-(--border) px-3 py-1.5">
                    {r.team ? (
                      <span className="rounded bg-(--surface-2) px-1.5 py-0.5 mono text-[11px] font-medium text-(--text-dim)">
                        {r.team}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="max-w-64 truncate border-b border-(--border) px-3 py-1.5 text-(--text-dim)">
                    {projectTarget(r)}
                  </td>
                  <td className="border-b border-(--border) px-3 py-1.5">
                    <span
                      className="rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                      style={
                        r.reportOnly
                          ? {
                              color: "var(--text-faint)",
                              background: "color-mix(in oklch, var(--text-faint) 12%, transparent)",
                            }
                          : {
                              color: "var(--hue-ok)",
                              background: "color-mix(in oklch, var(--hue-ok) 12%, transparent)",
                            }
                      }
                    >
                      {r.reportOnly ? "Report Only" : "Dispatchable"}
                    </span>
                  </td>
                  <td className="mono border-b border-(--border) px-3 py-1.5 text-[11px] text-(--text-dim)">
                    {r.base}
                    {r.deployBranch ? ` → ${r.deployBranch}` : ""}
                  </td>
                  <td className="border-b border-(--border) px-3 py-1.5 text-[11px] text-(--text-faint)">
                    {worktreeScripts(r)}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <ListEmpty
                colSpan={6}
                query={query}
                filtered={repos.length > 0}
                noun="repositories"
                empty="No configured repositories in config/repos.yaml."
              />
            )}
          </tbody>
        </table>
      </ListPane>

      {sel && (
        <DetailPane
          widthClass="w-[540px]"
          title={
            <div className="flex items-center gap-2">
              <span className="mono font-semibold" title={sel.name}>
                {sel.name}
              </span>
              {sel.team && (
                <span className="rounded bg-(--surface-2) px-1.5 py-0.5 mono text-[11px] font-medium text-(--text-dim)">
                  {sel.team}
                </span>
              )}
            </div>
          }
          actions={
            sel.github ? (
              <a
                href={`https://github.com/${sel.github}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-(--border-strong) bg-(--surface-2) px-2.5 py-1 text-[12px] font-medium text-(--text) transition-colors hover:bg-(--surface-3)"
              >
                GitHub
              </a>
            ) : null
          }
          utility={<CopyActions id={sel.path} idLabel="repo path" idChord="c p" />}
          close={<Button onClick={() => onSelectRepo(null)}>Close</Button>}
        >
          <div className="space-y-4">
            <Section title="Quick Dispatch (Agent Tasks)">
              {env?.name === "live" && (
                <div
                  className="mb-2 inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                  style={{
                    color: "var(--hue-warn)",
                    background: "color-mix(in oklch, var(--hue-warn) 12%, transparent)",
                  }}
                >
                  <span className="size-1.5 rounded-full bg-(--hue-warn)" />
                  Live Environment
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!connected || quickDispatchMutation.isPending}
                  onClick={() =>
                    setDispatchConfirm({
                      type: "factory.triage.requested",
                      payload: { repo: sel.name },
                      label: `Triage Scan on ${sel.name}`,
                      repo: sel.name,
                    })
                  }
                >
                  Triage Scan
                </Button>
                <Button
                  disabled={!connected || quickDispatchMutation.isPending}
                  onClick={() =>
                    setDispatchConfirm({
                      type: "factory.status-report.requested",
                      payload: { repos: [sel.name] },
                      label: `Status Report for ${sel.name}`,
                      repo: sel.name,
                    })
                  }
                >
                  Status Report
                </Button>
                <Button
                  disabled={!connected || quickDispatchMutation.isPending}
                  onClick={() =>
                    setDispatchConfirm({
                      type: "factory.janitor-scan.requested",
                      payload: { repo: sel.name },
                      label: `Janitor Scan on ${sel.name}`,
                      repo: sel.name,
                    })
                  }
                >
                  Janitor Scan
                </Button>
              </div>
              <div className="mt-1.5 text-[11px] text-(--text-faint)">
                Injects an event into the queue for worker lease with live trace streaming.
              </div>
            </Section>

            <Section id="project-configuration" title="Configuration">
              <KV k="Name" v={sel.name} />
              {sel.project && <KV k="Project" v={sel.project} />}
              {sel.team && <KV k="Team" v={sel.team} />}
              <KV
                k="Path"
                v={
                  <span
                    onClick={() => copyText(sel.path, "path")}
                    className="cursor-pointer hover:underline"
                    title="Click to copy path"
                  >
                    {sel.path}
                  </span>
                }
              />
              {sel.github && (
                <KV
                  k="GitHub"
                  v={
                    <a
                      href={`https://github.com/${sel.github}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-(--accent) hover:underline"
                    >
                      {sel.github}
                    </a>
                  }
                />
              )}
              <KV k="Base branch" v={sel.base} />
              {sel.deployBranch && <KV k="Deploy branch" v={sel.deployBranch} />}
              <KV
                k="Execution mode"
                v={
                  <span
                    className="font-medium"
                    style={{ color: sel.reportOnly ? "var(--text-faint)" : "var(--hue-ok)" }}
                  >
                    {sel.reportOnly ? "Report Only (Watched)" : "Autonomous Dispatchable"}
                  </span>
                }
              />
              {sel.maxInFlight !== null && <KV k="Max in flight" v={sel.maxInFlight} />}
              {sel.worktreeRoot && <KV k="Worktrees root" v={sel.worktreeRoot} />}
              {sel.verify && (
                <div className="mt-2">
                  <div className="text-[11px] text-(--text-faint)">Verification Command</div>
                  <pre className="mono mt-1 overflow-auto rounded bg-(--surface-0) p-2 text-[11px] text-(--text-dim)">
                    {sel.verify}
                  </pre>
                </div>
              )}
            </Section>

            <Section title="Worktree Automation Scripts">
              <div className="grid grid-cols-3 gap-2 text-center text-[12px]">
                <div
                  className="rounded border border-(--border) p-2"
                  style={{ opacity: sel.hasWorktreeUp ? 1 : 0.4 }}
                >
                  <div className="text-[11px] text-(--text-faint) uppercase">Up Script</div>
                  <div className="font-semibold">{sel.hasWorktreeUp ? "Present" : "None"}</div>
                </div>
                <div
                  className="rounded border border-(--border) p-2"
                  style={{ opacity: sel.hasWorktreeDown ? 1 : 0.4 }}
                >
                  <div className="text-[11px] text-(--text-faint) uppercase">Down Script</div>
                  <div className="font-semibold">{sel.hasWorktreeDown ? "Present" : "None"}</div>
                </div>
                <div
                  className="rounded border border-(--border) p-2"
                  style={{ opacity: sel.hasWorktreeWarm ? 1 : 0.4 }}
                >
                  <div className="text-[11px] text-(--text-faint) uppercase">Warm Script</div>
                  <div className="font-semibold">{sel.hasWorktreeWarm ? "Present" : "None"}</div>
                </div>
              </div>
            </Section>

            <Section title="Worktree Janitor & Maintenance (OPS-362)" card={false}>
              <div className="rounded-md border border-(--border) bg-(--surface-0) p-3">
                <div className="text-[12px] text-(--text-dim)">
                  Janitor inspects worktrees in <code className="mono">{sel.worktreeRoot ?? "repo worktrees"}</code>,
                  checks their Linear ticket states, and reclaims finished ticket checkouts.
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    disabled={!connected || dryMutation.isPending || applyMutation.isPending}
                    onClick={() => dryMutation.mutate(sel.name)}
                  >
                    {dryMutation.isPending ? "Scanning…" : "Run Dry Janitor"}
                  </Button>

                  <Button
                    variant="danger"
                    disabled={
                      !connected ||
                      dryMutation.isPending ||
                      applyMutation.isPending ||
                      !dryResult ||
                      dryResult.reclaimable.length === 0 ||
                      (sel.reportOnly && !sel.hasWorktreeDown)
                    }
                    onClick={() => {
                      if (!dryResult?.reclaimable.length) return;
                      setConfirmInput("");
                      setConfirmOpen(true);
                    }}
                  >
                    Clean Reclaimable Worktrees…
                  </Button>
                  {dryResult && dryResult.reclaimable.length === 0 && (
                    <span className="text-[11px] text-(--text-faint)">Nothing to reclaim</span>
                  )}

                  <Button
                    disabled={!connected || quickDispatchMutation.isPending}
                    onClick={() =>
                      setDispatchConfirm({
                        type: "factory.janitor-scan.requested",
                        payload: { repo: sel.name },
                        label: `Janitor Scan on ${sel.name}`,
                        repo: sel.name,
                      })
                    }
                  >
                    {quickDispatchMutation.isPending ? "Dispatching…" : "Dispatch Scan Event"}
                  </Button>
                </div>

                <div className="mt-2 text-[11px] text-(--text-faint)">
                  Supports direct execution or asynchronous placement dispatch via <code>janitor-scan@1</code> & <code>janitor-apply@1</code> events.
                </div>

                {sel.reportOnly && !sel.hasWorktreeDown && (
                  <div className="mt-2 text-[11px]" style={{ color: "var(--hue-warn)" }}>
                    Apply is disabled: report-only repo "{sel.name}" has no worktree_down script.
                  </div>
                )}

                <VerbError error={dryMutation.error ?? applyMutation.error} />

                {dryResult && (
                  <div className="mt-3 space-y-2 border-t border-(--border) pt-3 text-[12px]">
                    <div className="flex items-center justify-between font-medium">
                      <span>Dry Scan Results</span>
                      <div className="flex items-center gap-1.5">
                        {dryResult.held && dryResult.held.length > 0 && (
                          <span
                            className="rounded px-1.5 py-0.2 text-[11px]"
                            style={{
                              color: "var(--hue-warn)",
                              background: "color-mix(in oklch, var(--hue-warn) 14%, transparent)",
                            }}
                          >
                            {dryResult.held.length} held
                          </span>
                        )}
                        <span
                          className="rounded px-1.5 py-0.2 text-[11px]"
                          style={{
                            color: dryResult.reclaimable.length > 0 ? "var(--hue-ok)" : "var(--text-faint)",
                            background: `color-mix(in oklch, ${
                              dryResult.reclaimable.length > 0 ? "var(--hue-ok)" : "var(--text-faint)"
                            } 14%, transparent)`,
                          }}
                        >
                          {dryResult.reclaimable.length} reclaimable
                        </span>
                      </div>
                    </div>

                    {dryResult.reclaimable.length > 0 ? (
                      <div>
                        <div className="text-[11px] text-(--text-faint)">Reclaimable (Completed/Canceled):</div>
                        <div className="mono mt-1 flex flex-wrap gap-1.5">
                          {dryResult.reclaimable.map((t) => (
                            <span
                              key={t.id}
                              className="rounded border border-(--border) bg-(--surface-1) px-1.5 py-0.5 text-[11px]"
                            >
                              {t.id} <span className="opacity-60">({t.state})</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="text-[11px] text-(--text-faint)">No finished worktrees to reclaim.</div>
                    )}

                    {dryResult.held && dryResult.held.length > 0 && (
                      <div>
                        <div className="text-[11px] text-(--hue-warn)">
                          Held by Open PR (Finished ticket, active PR):
                        </div>
                        <div className="mono mt-1 space-y-1">
                          {dryResult.held.map((h) => (
                            <div
                              key={h.id}
                              className="rounded border border-(--border) bg-(--surface-1) p-1.5 text-[11px]"
                            >
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-(--text)">{h.id}</span>
                                {h.state && <span className="text-(--text-dim)">({h.state})</span>}
                                {h.branch && (
                                  <span className="rounded bg-(--surface-2) px-1 py-0.2 text-[11px] text-(--text-faint)">
                                    {h.branch}
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 text-[11px] text-(--text-dim)">{h.reason}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {dryResult.kept.length > 0 && (
                      <div>
                        <div className="text-[11px] text-(--text-faint)">Kept (In Progress/Active):</div>
                        <div className="mono mt-1 flex flex-wrap gap-1.5">
                          {dryResult.kept.map((t) => (
                            <span
                              key={t.id}
                              className="rounded border border-(--border) bg-(--surface-1) px-1.5 py-0.5 text-[11px] text-(--text-dim)"
                            >
                              {t.id} <span className="opacity-60">({t.state})</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {dryResult.named.length > 0 && (
                      <div className="text-[11px] text-(--text-faint)">
                        Named/custom worktrees (kept safe): {dryResult.named.join(", ")}
                      </div>
                    )}

                    {dryResult.unknown.length > 0 && (
                      <div className="text-[11px] text-(--text-faint)">
                        Unknown tickets (kept safe): {dryResult.unknown.join(", ")}
                      </div>
                    )}
                  </div>
                )}

                {applyResult && (
                  <div className="mt-3 space-y-2 border-t border-(--border) pt-3 text-[12px]">
                    <div className="font-semibold text-(--hue-ok)">Janitor Apply Execution Finished</div>
                    {applyResult.removed.length > 0 && (
                      <div>
                        <div className="text-[11px] text-(--text-faint)">Removed Worktrees:</div>
                        <div className="mono mt-1 flex flex-wrap gap-1.5">
                          {applyResult.removed.map((id) => (
                            <span
                              key={id}
                              className="rounded border border-(--border) bg-(--surface-1) px-1.5 py-0.5 text-[11px] text-(--hue-ok)"
                            >
                              {id}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {applyResult.held && applyResult.held.length > 0 && (
                      <div>
                        <div className="text-[11px] text-(--hue-warn)">
                          Held by Open PR (Left in Place):
                        </div>
                        <div className="mono mt-1 space-y-1">
                          {applyResult.held.map((h) => (
                            <div
                              key={h.id}
                              className="rounded border border-(--border) bg-(--surface-1) p-1.5 text-[11px]"
                            >
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-(--text)">{h.id}</span>
                                {h.state && <span className="text-(--text-dim)">({h.state})</span>}
                                {h.branch && (
                                  <span className="rounded bg-(--surface-2) px-1 py-0.2 text-[11px] text-(--text-faint)">
                                    {h.branch}
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 text-[11px] text-(--text-dim)">{h.reason}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {applyResult.refused.length > 0 && (
                      <div>
                        <div className="text-[11px] text-(--hue-err)">
                          Refused (Uncommitted or Unpushed Work):
                        </div>
                        <div className="mono mt-1 space-y-1">
                          {applyResult.refused.map((r) => (
                            <div
                              key={r.id}
                              className="rounded border border-(--border) bg-(--surface-1) p-1.5 text-[11px]"
                            >
                              <span className="font-semibold">{r.id}:</span> {r.reason}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {applyResult.skippedApplyReason && (
                      <div className="text-[11px] text-(--hue-warn)">
                        {applyResult.skippedApplyReason}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Section>
          </div>
        </DetailPane>
      )}

      {confirmOpen && sel && (dryResult?.reclaimable.length ?? 0) > 0 && (
        <Dialog
          title={`Clean Worktrees for ${sel.name}`}
          onClose={() => {
            setConfirmOpen(false);
            applyMutation.reset();
          }}
        >
          <div className="space-y-3">
            <div className="text-[13px] text-(--text-dim)">
              This will run <code className="mono">{sel.hasWorktreeDown ? "worktree_down" : "janitor"}</code> on{" "}
              <strong>{dryResult?.reclaimable.length ?? 0} reclaimable worktrees</strong>. Worktrees with uncommitted
              changes will be safely refused.
            </div>

            <div>
              <label className="text-[11px] font-medium text-(--text-faint)">
                Type <span className="mono font-semibold text-(--text)">{sel.name}</span> to confirm:
              </label>
              <input
                type="text"
                autoFocus
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder={sel.name}
                className="mono mt-1 w-full rounded border border-(--border) bg-(--surface-0) px-3 py-1.5 text-[13px] text-(--text) outline-none focus:border-(--accent)"
              />
            </div>

            <VerbError error={applyMutation.error} />

            <div className="flex justify-end gap-2 pt-2">
              <Button
                onClick={() => {
                  setConfirmOpen(false);
                  applyMutation.reset();
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={confirmInput.trim() !== sel.name || applyMutation.isPending}
                onClick={() => applyMutation.mutate(sel.name)}
              >
                {applyMutation.isPending ? "Tearing down…" : "Confirm & Clean"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {dispatchConfirm && (
        <Dialog
          title={`Dispatch ${dispatchConfirm.label}?`}
          onClose={() => {
            setDispatchConfirm(null);
            quickDispatchMutation.reset();
          }}
        >
          <div className="space-y-3">
            <div className="text-[13px] text-(--text-dim)">
              Injects an event into the queue for worker lease with live trace streaming.
            </div>

            {env?.name === "live" && (
              <div
                className="flex items-center gap-2 rounded-md border p-2.5 text-[12px] font-medium"
                style={{
                  borderColor: "var(--hue-warn)",
                  color: "var(--hue-warn)",
                  background: "color-mix(in oklch, var(--hue-warn) 8%, var(--surface-1))",
                }}
              >
                <span className="font-semibold">LIVE ENVIRONMENT</span>
                <span className="text-(--text-dim)">— dispatches trigger real agent runs in production.</span>
              </div>
            )}

            <div className="rounded border border-(--border) bg-(--surface-0) p-2 text-[12px]">
              <KV k="Event Type" v={<span className="mono text-(--text)">{dispatchConfirm.type}</span>} />
              <KV k="Repository" v={<span className="mono text-(--text)">{dispatchConfirm.repo}</span>} />
              <KV
                k="Environment"
                v={
                  <span
                    className="rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase"
                    style={{
                      color: env?.name === "live" ? "var(--hue-warn)" : "var(--hue-info)",
                      background: `color-mix(in oklch, ${
                        env?.name === "live" ? "var(--hue-warn)" : "var(--hue-info)"
                      } 16%, transparent)`,
                    }}
                  >
                    {env?.name ?? "unknown"}
                  </span>
                }
              />
            </div>

            <VerbError error={quickDispatchMutation.error} />

            <div className="flex justify-end gap-2 pt-2">
              <Button
                onClick={() => {
                  setDispatchConfirm(null);
                  quickDispatchMutation.reset();
                }}
              >
                Cancel
              </Button>
              <Button
                variant={env?.name === "live" ? "danger" : "primary"}
                autoFocus
                disabled={!connected || quickDispatchMutation.isPending}
                onClick={() => quickDispatchMutation.mutate(dispatchConfirm)}
              >
                {quickDispatchMutation.isPending ? "Dispatching…" : "Confirm & Dispatch"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
