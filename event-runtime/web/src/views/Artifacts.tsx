import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { artifactUrl, fetchArtifacts } from "../api";
import { Ago, FilterInput, JumpLink, ListEmpty, ListPane, humanSize } from "../components/ui";
import { useNow } from "../hooks";
import type { ArtifactInventoryItem, StatusView } from "../types";

export type ArtifactFilters = {
  kind: string | null;
  orphan: boolean | null;
  search: string;
};

const COMMON_KINDS = ["report", "log", "transcript", "ci-log"];

function kindsOf(artifact: ArtifactInventoryItem): string[] {
  return [...new Set(artifact.references.flatMap((reference) => reference.kind ?? []))];
}

function matchesSearch(artifact: ArtifactInventoryItem, search: string): boolean {
  const term = search.trim().toLowerCase();
  if (!term) return true;
  return [
    artifact.sha256,
    ...artifact.references.flatMap((reference) => [
      reference.runId,
      reference.kind,
      reference.agent,
      reference.state,
    ]),
  ].some((value) => String(value ?? "").toLowerCase().includes(term));
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className="mono inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        color: "var(--hue-info)",
        background: "color-mix(in oklch, var(--hue-info) 12%, transparent)",
      }}
    >
      {kind}
    </span>
  );
}

function Metric({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return (
    <div className="min-w-36 rounded-lg border border-(--border) bg-(--surface-1) px-3.5 py-3">
      <div className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">{label}</div>
      <div
        className="display mt-1 text-xl font-semibold tabular-nums"
        style={warning ? { color: "var(--hue-warn)" } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

/** Content-addressed store inventory, with URL-backed kind/orphan/search facets. */
export function Artifacts({
  metrics,
  filters,
  onFiltersChange,
  onJumpRun,
}: {
  metrics?: StatusView["artifacts"];
  filters: ArtifactFilters;
  onFiltersChange: (filters: ArtifactFilters) => void;
  onJumpRun: (runId: string) => void;
}) {
  const now = useNow();
  const artifactsQ = useQuery({
    queryKey: ["artifacts"],
    queryFn: () => fetchArtifacts(),
    refetchInterval: 10_000,
  });
  const artifacts = artifactsQ.data?.artifacts ?? [];
  const kinds = useMemo(
    () =>
      [...new Set([...COMMON_KINDS, ...artifacts.flatMap(kindsOf)])].sort((a, b) =>
        a.localeCompare(b),
      ),
    [artifacts],
  );
  const visible = useMemo(
    () =>
      artifacts.filter((artifact) => {
        if (filters.kind && !kindsOf(artifact).includes(filters.kind)) return false;
        if (filters.orphan != null && filters.orphan === artifact.referenced) return false;
        return matchesSearch(artifact, filters.search);
      }),
    [artifacts, filters],
  );

  const fallbackMetrics = useMemo(
    () => ({
      files: artifacts.length,
      bytes: artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
      orphans: artifacts.filter((artifact) => !artifact.referenced).length,
      orphanBytes: artifacts
        .filter((artifact) => !artifact.referenced)
        .reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
    }),
    [artifacts],
  );
  const summary: StatusView["artifacts"] = metrics ?? fallbackMetrics;
  const filtered = Boolean(filters.kind || filters.orphan != null || filters.search.trim());
  const set = (patch: Partial<ArtifactFilters>) => onFiltersChange({ ...filters, ...patch });

  return (
    <ListPane
      chrome={
        <>
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h1 className="display text-lg font-semibold">Artifacts</h1>
              <p className="mt-1 text-[12px] text-(--text-faint)">
                Physical files in the content-addressed store. Project context does not narrow this factory-wide inventory.
              </p>
            </div>
            {summary.at && (
              <span className="text-[11px] text-(--text-faint)" title={summary.at}>
                measured <Ago iso={summary.at} now={now} />
              </span>
            )}
          </div>

          <section aria-label="Artifact storage summary" className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Metric label="Stored files" value={summary.files.toLocaleString()} />
            <Metric label="Disk usage" value={humanSize(summary.bytes)} />
            <Metric
              label="Orphans"
              value={`${summary.orphans.toLocaleString()} · ${humanSize(summary.orphanBytes)}`}
              warning={summary.orphans > 0}
            />
          </section>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Artifact status facets">
              {([
                { label: "All", value: null },
                { label: "Referenced", value: false },
                { label: "Orphans", value: true },
              ] as const).map((facet) => (
                <button
                  key={facet.label}
                  type="button"
                  aria-pressed={filters.orphan === facet.value}
                  onClick={() => set({ orphan: facet.value })}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                    filters.orphan === facet.value
                      ? "bg-(--surface-3) text-(--text)"
                      : "text-(--text-faint) hover:bg-(--surface-1)"
                  }`}
                >
                  {facet.label}
                </button>
              ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1" role="group" aria-label="Artifact kind facets">
              <button
                type="button"
                aria-pressed={filters.kind === null}
                onClick={() => set({ kind: null })}
                className={`rounded-md px-2 py-1 text-[11px] ${
                  filters.kind === null ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
                }`}
              >
                Any kind
              </button>
              {kinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={filters.kind === kind}
                  onClick={() => set({ kind: filters.kind === kind ? null : kind })}
                  className={`mono rounded-md px-2 py-1 text-[11px] ${
                    filters.kind === kind ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:bg-(--surface-1)"
                  }`}
                >
                  {kind}
                </button>
              ))}
            </div>
            <FilterInput
              value={filters.search}
              onChange={(search) => set({ search })}
              placeholder="SHA, kind, run, agent…"
              label="Search artifacts"
            />
          </div>
        </>
      }
    >
      <table className="w-full border-separate border-spacing-0 text-[12px]">
        <thead>
          <tr className="text-left text-[11px] text-(--text-faint)">
            <th className="border-b border-(--border-strong) px-3 py-2 font-medium">SHA</th>
            <th className="border-b border-(--border-strong) px-3 py-2 font-medium">Kind</th>
            <th className="border-b border-(--border-strong) px-3 py-2 font-medium">File size</th>
            <th className="border-b border-(--border-strong) px-3 py-2 font-medium">Age / timestamp</th>
            <th className="border-b border-(--border-strong) px-3 py-2 font-medium">Referenced by</th>
            <th className="border-b border-(--border-strong) px-3 py-2 font-medium">Orphan</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((artifact) => {
            const artifactKinds = kindsOf(artifact);
            const name = `${artifact.sha256.slice(0, 12)}${artifactKinds[0] ? `.${artifactKinds[0]}` : ""}`;
            return (
              <tr key={artifact.sha256} className="hover:bg-(--surface-1)">
                <td className="mono max-w-40 border-b border-(--border) px-3 py-2" title={artifact.sha256}>
                  <a
                    href={artifactUrl(artifact.sha256, name)}
                    download={name}
                    className="text-(--accent) hover:underline"
                    aria-label={`Download artifact ${artifact.sha256}`}
                  >
                    {artifact.sha256.slice(0, 12)}
                  </a>
                </td>
                <td className="border-b border-(--border) px-3 py-2">
                  {artifactKinds.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {artifactKinds.map((kind) => <KindBadge key={kind} kind={kind} />)}
                    </div>
                  ) : (
                    <span className="text-(--text-faint)">—</span>
                  )}
                </td>
                <td className="mono whitespace-nowrap border-b border-(--border) px-3 py-2 text-(--text-dim)">
                  {humanSize(artifact.sizeBytes)}
                </td>
                <td className="whitespace-nowrap border-b border-(--border) px-3 py-2">
                  <div><Ago iso={artifact.mtime} now={now} /></div>
                  <time dateTime={artifact.mtime} className="mono text-[10px] text-(--text-faint)">
                    {new Date(artifact.mtime).toLocaleString()}
                  </time>
                </td>
                <td className="border-b border-(--border) px-3 py-2">
                  {artifact.references.length > 0 ? (
                    <div className="flex flex-wrap gap-x-2 gap-y-1">
                      {artifact.references.map((reference) => (
                        <JumpLink
                          key={`${reference.runId}:${reference.kind ?? "unknown"}`}
                          onClick={() => onJumpRun(reference.runId)}
                          title={`Open run ${reference.runId}`}
                        >
                          {reference.runId}
                        </JumpLink>
                      ))}
                    </div>
                  ) : (
                    <span className="text-(--text-faint)">—</span>
                  )}
                </td>
                <td className="border-b border-(--border) px-3 py-2">
                  {!artifact.referenced ? (
                    <span
                      className="rounded px-1.5 py-0.5 text-[11px] font-medium"
                      style={{
                        color: "var(--hue-warn)",
                        background: "color-mix(in oklch, var(--hue-warn) 12%, transparent)",
                      }}
                    >
                      orphan
                    </span>
                  ) : (
                    <span className="text-(--text-faint)">—</span>
                  )}
                </td>
              </tr>
            );
          })}
          {visible.length === 0 && (
            <ListEmpty
              colSpan={6}
              query={artifactsQ}
              filtered={filtered}
              noun="artifacts"
              empty="No artifacts are stored."
              onClear={() => onFiltersChange({ kind: null, orphan: null, search: "" })}
            />
          )}
        </tbody>
      </table>
    </ListPane>
  );
}
