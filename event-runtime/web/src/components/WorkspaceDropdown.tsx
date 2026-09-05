import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type RepoItem } from "../api";
import { refetchIntervals } from "../hooks";
import type { RunListItem, Worker } from "../types";
import { Button, notify, shortId } from "./ui";

export type ActiveWorkspace = {
  worker: Worker;
  run: RunListItem;
  repo: string;
  subject: string;
};

/**
 * A workspace occupies a tenant slot while its worker has a current run. The
 * worker endpoint is the authority for that relationship; the run list only
 * supplies the operator-facing repository and subject labels.
 */
export function activeWorkspaces(
  workers: Worker[],
  runs: RunListItem[],
): ActiveWorkspace[] {
  const byId = new Map(runs.map((run) => [run.runId, run]));
  return workers.flatMap((worker) => {
    if (worker.state === "stopped" || !worker.currentRun) return [];
    const run = byId.get(worker.currentRun);
    if (!run) return [];
    return [
      {
        worker,
        run,
        repo: run.repos[0] ?? "Unassigned",
        subject: run.eventId ?? run.runId,
      },
    ];
  });
}

type WorkspaceGroup = {
  repo: string;
  limit: number | null;
  workspaces: ActiveWorkspace[];
};

export function groupActiveWorkspaces(
  workspaces: ActiveWorkspace[],
  repos: RepoItem[],
): WorkspaceGroup[] {
  const limits = new Map(
    repos.map((repo) => [repo.name, repo.effective?.maxInFlight ?? null]),
  );
  const groups = new Map<string, ActiveWorkspace[]>();
  for (const workspace of workspaces) {
    const group = groups.get(workspace.repo) ?? [];
    group.push(workspace);
    groups.set(workspace.repo, group);
  }
  return [...groups.entries()]
    .map(([repo, entries]) => ({
      repo,
      limit: limits.get(repo) ?? null,
      workspaces: entries,
    }))
    .sort((left, right) => left.repo.localeCompare(right.repo));
}

/** A compact, always-available view of tenant workspaces in the app chrome. */
export function WorkspaceDropdown() {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<ActiveWorkspace | null>(null);
  const queryClient = useQueryClient();
  const workersQuery = useQuery({
    queryKey: ["workers"],
    queryFn: api.workers,
    ...refetchIntervals.primary,
  });
  const runsQuery = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.runs(),
    ...refetchIntervals.secondary,
  });
  const reposQuery = useQuery({
    queryKey: ["repos"],
    queryFn: api.repos,
    ...refetchIntervals.secondary,
  });
  const workspaces = useMemo(
    () =>
      activeWorkspaces(
        workersQuery.data?.workers ?? [],
        runsQuery.data?.runs ?? [],
      ),
    [workersQuery.data, runsQuery.data],
  );
  const groups = useMemo(
    () => groupActiveWorkspaces(workspaces, reposQuery.data?.repos ?? []),
    [workspaces, reposQuery.data],
  );

  const release = useMutation({
    mutationFn: (workspace: ActiveWorkspace) =>
      api.releaseWorker(workspace.worker.workerId, workspace.run.runId),
    onSuccess: (_, workspace) => {
      void queryClient.invalidateQueries({ queryKey: ["workers"] });
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      setConfirming(null);
      notify(`Terminated workspace ${workspace.subject}`, "ok");
    },
    onError: (error: Error, workspace) => {
      notify(
        `Could not terminate ${workspace.subject}: ${error.message}`,
        "err",
      );
    },
  });

  const total = workspaces.length;
  return (
    <section className="relative mb-2" aria-label="Active workspaces">
      <Button
        type="button"
        size="sm"
        aria-expanded={open}
        aria-controls="active-workspaces-menu"
        onClick={() => setOpen((value) => !value)}
        className="w-full justify-between"
      >
        <span>Munkaterületek</span>
        <span className="mono text-(--text-faint)">{total}</span>
      </Button>
      {open && (
        <div
          id="active-workspaces-menu"
          role="region"
          aria-label="Running workspaces"
          className="mt-1 max-h-80 overflow-y-auto rounded-md border border-(--border) bg-(--surface-1) p-2 shadow-lg"
        >
          {groups.length === 0 ? (
            <p className="px-1 py-2 text-[12px] text-(--text-faint)">
              No running workspaces.
            </p>
          ) : (
            groups.map((group) => (
              <div
                key={group.repo}
                className="py-1 not-last:border-b not-last:border-(--border)"
              >
                <div className="flex items-center justify-between gap-2 px-1 py-1 text-[11px] font-semibold text-(--text-dim)">
                  <span className="truncate">{group.repo}</span>
                  <span
                    className="mono shrink-0"
                    aria-label={`${group.workspaces.length}${group.limit === null ? " active workspaces" : ` of ${group.limit} workspace limit`}`}
                  >
                    {group.workspaces.length}
                    {group.limit === null ? "" : ` / ${group.limit}`}
                  </span>
                </div>
                {group.workspaces.map((workspace) => {
                  const isConfirming =
                    confirming?.run.runId === workspace.run.runId;
                  return (
                    <div
                      key={workspace.worker.workerId}
                      className="rounded px-1 py-1.5 hover:bg-(--surface-2)"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 text-[12px]">
                          <div
                            className="truncate text-(--text)"
                            title={workspace.subject}
                          >
                            {workspace.subject}
                          </div>
                          <div className="mono truncate text-[11px] text-(--text-faint)">
                            {shortId(workspace.run.runId)} ·{" "}
                            {workspace.worker.stale
                              ? "stale"
                              : workspace.worker.state}
                          </div>
                        </div>
                        {!isConfirming && (
                          <Button
                            type="button"
                            size="sm"
                            disabled={release.isPending}
                            aria-label={`Terminate workspace ${workspace.subject}`}
                            onClick={() => setConfirming(workspace)}
                          >
                            Terminate
                          </Button>
                        )}
                      </div>
                      {isConfirming && (
                        <div className="mt-2 flex items-center justify-between gap-2 rounded bg-(--surface-3) p-2 text-[11px] text-(--text-dim)">
                          <span>Stop this workspace?</span>
                          <span className="flex gap-1">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => setConfirming(null)}
                            >
                              Keep
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={release.isPending}
                              onClick={() => release.mutate(workspace)}
                            >
                              Confirm terminate
                            </Button>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
