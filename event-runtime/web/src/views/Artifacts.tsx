import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, artifactUrl, fetchArtifacts } from "../api";
import { ArtifactPanel, loadArtifactRaw } from "../components/ArtifactView";
import { DisplayOptions } from "../components/DisplayOptions";
import { CustomCell } from "../components/CustomCell";
import {
  Ago,
  Button,
  DetailPane,
  FilterInput,
  JumpLink,
  ListEmpty,
  ListPane,
  StatCard,
  Th,
  copyText,
  shortId,
} from "../components/ui";
import {
  cycleColumnSort,
  removeCustomColumn,
  sortRows,
  visibleColumns,
  type DisplayConfig,
} from "../displayOptions";
import { useDisplayOptions, useNow } from "../hooks";
import { formatBytes, viewApplies } from "../lib/artifactView";
import type { AdmittedEvent, AgentDef, ArtifactInventoryItem, StatusView } from "../types";

export { formatBytes };

export type ArtifactFilters = {
  kind: string | null;
  orphan: boolean | null;
  search: string;
};

const COMMON_KINDS = ["report", "log", "transcript", "ci-log"];

function kindsOf(artifact: ArtifactInventoryItem): string[] {
  return [...new Set(artifact.references.flatMap((reference) => reference.kind ?? []))];
}

const ARTIFACTS_DISPLAY: DisplayConfig<ArtifactInventoryItem> = {
  view: "artifacts",
  groups: [],
  sorts: [
    { key: "sha", label: "SHA", get: (artifact) => artifact.sha256, column: "sha" },
    { key: "kind", label: "Kind", get: (artifact) => kindsOf(artifact).join(", "), column: "kind" },
    { key: "size", label: "File size", get: (artifact) => artifact.sizeBytes, column: "size" },
    { key: "age", label: "Age", get: (artifact) => Date.parse(artifact.mtime), defaultDir: "desc", column: "age" },
    {
      key: "references",
      label: "Referenced by",
      get: (artifact) => artifact.references.map((reference) => reference.runId).join(", "),
      column: "references",
    },
  ],
  columns: [
    { key: "sha", label: "SHA", always: true },
    { key: "kind", label: "Kind" },
    { key: "size", label: "File size" },
    { key: "age", label: "Age" },
    { key: "references", label: "Referenced by" },
  ],
  defaults: { sortBy: "age", sortDir: "desc" },
};

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

const ARTIFACT_HASH = /^[0-9a-f]{64}$/;

type LinkedEvent = AdmittedEvent & { causationId?: string | null };

function artifactShaFromHash(hash = window.location.hash): string | null {
  const path = hash.replace(/^#\/?/, "").split("?", 1)[0];
  const [, encoded] = path.split("/");
  if (!encoded) return null;
  try {
    const sha256 = decodeURIComponent(encoded);
    return ARTIFACT_HASH.test(sha256) ? sha256 : null;
  } catch {
    return null;
  }
}

function openArtifactInspector(sha256: string) {
  if (!ARTIFACT_HASH.test(sha256)) return;
  window.location.hash = `#/artifacts/${encodeURIComponent(sha256)}`;
}

function containsArtifactHash(value: unknown, sha256: string, seen = new Set<object>()): boolean {
  if (typeof value === "string") return value === sha256 || value === `sha256:${sha256}`;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Array.isArray(value)
    ? value.some((entry) => containsArtifactHash(entry, sha256, seen))
    : Object.values(value).some((entry) => containsArtifactHash(entry, sha256, seen));
}

/** The stored bytes as one JSON object, or null — the only shape a view can describe. */
function parsedObject(raw: string): Record<string, unknown> | null {
  if (!/^\s*\{/.test(raw)) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function formattedContent(raw: string, kinds: string[]): string {
  if (kinds.some((kind) => /json/i.test(kind)) || /^\s*[\[{]/.test(raw)) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      // NDJSON/log streams that start with JSON still belong in the text viewer.
    }
  }
  return raw;
}

function highlightedLine(line: string, search: string): ReactNode {
  const term = search.trim();
  if (!term) return line || " ";
  const lower = line.toLowerCase();
  const needle = term.toLowerCase();
  const chunks: ReactNode[] = [];
  let at = 0;
  let match = lower.indexOf(needle);
  while (match >= 0) {
    chunks.push(line.slice(at, match));
    chunks.push(<mark key={`${match}:${chunks.length}`} className="bg-(--hue-warn) text-inherit">{line.slice(match, match + term.length)}</mark>);
    at = match + term.length;
    match = lower.indexOf(needle, at);
  }
  chunks.push(line.slice(at));
  return chunks;
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
  const [selectedSha, setSelectedSha] = useState(() => artifactShaFromHash());
  const [contentSearch, setContentSearch] = useState("");

  useEffect(() => {
    const syncSelection = () => setSelectedSha(artifactShaFromHash());
    window.addEventListener("hashchange", syncSelection);
    return () => window.removeEventListener("hashchange", syncSelection);
  }, []);

  const selected = useMemo(
    () => artifacts.find((artifact) => artifact.sha256 === selectedSha) ?? null,
    [artifacts, selectedSha],
  );
  const contentQ = useQuery({
    queryKey: ["artifact-content", selectedSha],
    queryFn: async () => {
      const response = await fetch(artifactUrl(selectedSha as string));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    enabled: selectedSha !== null,
  });
  const eventsQ = useQuery({
    queryKey: ["events", "all-for-artifacts"],
    queryFn: () => api.events(),
    enabled: selectedSha !== null,
    refetchInterval: 10_000,
  });
  // The producing run's agent may ship a view sidecar (WM-454); when the
  // stored bytes are that agent's artifact, the inspector draws it (WM-455).
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents(),
    enabled: selectedSha !== null,
    staleTime: 30_000,
  });
  const [artifactRaw, setArtifactRaw] = useState(loadArtifactRaw);

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
  const [display, setDisplay] = useDisplayOptions(ARTIFACTS_DISPLAY);
  const ordered = useMemo(
    () => sortRows(visible, ARTIFACTS_DISPLAY, display),
    [visible, display],
  );
  const columns = visibleColumns(ARTIFACTS_DISPLAY, display);
  const shown = useMemo(() => new Set(columns.map((column) => column.key)), [columns]);

  const linkedEvents = (eventsQ.data?.events ?? []) as LinkedEvent[];
  const producerRunIds = useMemo(
    () => new Set(selected?.references.map((reference) => reference.runId) ?? []),
    [selected],
  );
  const consumers = useMemo(
    () =>
      selectedSha
        ? linkedEvents.filter(
            (event) =>
              event.runId &&
              !producerRunIds.has(event.runId) &&
              containsArtifactHash(event.envelope, selectedSha),
          )
        : [],
    [linkedEvents, producerRunIds, selectedSha],
  );
  const causation = useMemo(
    () => linkedEvents.filter((event) => event.causationId && producerRunIds.has(event.causationId)),
    [linkedEvents, producerRunIds],
  );
  const selectedKinds = selected ? kindsOf(selected) : [];
  const preview = contentQ.data === undefined ? null : formattedContent(contentQ.data, selectedKinds);
  const parsedArtifact = useMemo(
    () => (contentQ.data === undefined ? null : parsedObject(contentQ.data)),
    [contentQ.data],
  );
  const producerAgent: AgentDef | undefined = useMemo(() => {
    const refs = selected?.references.map((reference) => reference.agent).filter(Boolean) ?? [];
    const defs = agentsQ.data?.agents ?? [];
    for (const ref of refs) {
      const def = defs.find((a) => a.ref === ref || a.id === ref);
      if (def?.outputView) return def;
    }
    return undefined;
  }, [selected, agentsQ.data]);
  const viewShown =
    parsedArtifact !== null && viewApplies(producerAgent?.outputView, parsedArtifact) && !artifactRaw;
  const previewLines = preview?.split("\n") ?? [];
  const matchCount = contentSearch.trim()
    ? previewLines.filter((line) => line.toLowerCase().includes(contentSearch.trim().toLowerCase())).length
    : null;

  const selectArtifact = (sha256: string) => {
    setContentSearch("");
    setSelectedSha(sha256);
    openArtifactInspector(sha256);
  };
  const closeInspector = () => {
    setSelectedSha(null);
    setContentSearch("");
    window.location.hash = "#/artifacts";
  };

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
    <div className="flex h-full min-w-0">
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
            <StatCard label="Stored files" value={summary.files.toLocaleString()} />
            <StatCard label="Disk usage" value={formatBytes(summary.bytes)} />
            <StatCard
              label="Orphans"
              value={summary.orphans.toLocaleString()}
              caption={formatBytes(summary.orphanBytes)}
              hue={summary.orphans > 0 ? "var(--hue-warn)" : undefined}
            />
          </section>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Artifact reference state">
              {([
                { label: "All", value: null, count: summary.files },
                { label: "Referenced", value: false, count: summary.files - summary.orphans },
                { label: "Orphans", value: true, count: summary.orphans },
              ] as const).map((facet) => (
                <button
                  key={facet.label}
                  type="button"
                  role="tab"
                  aria-selected={filters.orphan === facet.value}
                  onClick={() => set({ orphan: facet.value })}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                    filters.orphan === facet.value
                      ? "bg-(--surface-3) text-(--text)"
                      : "text-(--text-faint) hover:bg-(--surface-1)"
                  }`}
                >
                  {facet.label}
                  <span className="ml-1.5 tabular-nums text-(--text-faint)">{facet.count.toLocaleString()}</span>
                </button>
              ))}
            </div>
            <span className="ml-auto">
              <DisplayOptions
                config={ARTIFACTS_DISPLAY}
                state={display}
                onChange={setDisplay}
                rows={artifacts}
              />
            </span>
            <label className="flex items-center gap-1.5 text-[11px] font-medium text-(--text-dim)">
              <span>Kind:</span>
              <select
                aria-label="Artifact kind"
                value={filters.kind ?? ""}
                onChange={(event) => set({ kind: event.target.value || null })}
                className="cursor-pointer rounded-md border border-(--border) bg-(--surface-0) px-2 py-1 text-[12px] text-(--text) outline-none hover:border-(--border-strong) focus:border-(--accent)"
              >
                <option value="">Any kind</option>
                {kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
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
            {columns.map((column) => {
              const sort = ARTIFACTS_DISPLAY.sorts.find((field) => field.column === column.key);
              const isCustom = column.isCustom || column.key.startsWith("custom:");
              const customPath = column.key.replace(/^custom:/, "");
              const current = isCustom ? display.sortBy === column.key : sort && display.sortBy === sort.key;
              return (
                <Th
                  key={column.key}
                  label={column.label}
                  dir={current ? display.sortDir : null}
                  naturalDir={sort?.defaultDir ?? "asc"}
                  onSort={sort || isCustom ? () => setDisplay((state) => cycleColumnSort(ARTIFACTS_DISPLAY, state, column.key)) : undefined}
                  onRemove={isCustom ? () => setDisplay((state) => removeCustomColumn(state, customPath)) : undefined}
                />
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered.map((artifact) => {
            const artifactKinds = kindsOf(artifact);
            const name = `${artifact.sha256.slice(0, 12)}${artifactKinds[0] ? `.${artifactKinds[0]}` : ""}`;
            return (
              <tr
                key={artifact.sha256}
                onClick={() => selectArtifact(artifact.sha256)}
                aria-selected={artifact.sha256 === selectedSha}
                className={`cursor-pointer hover:bg-(--surface-1) ${artifact.sha256 === selectedSha ? "row-selected" : ""}`}
              >
                <td className="mono max-w-48 border-b border-(--border) px-3 py-1.5 whitespace-nowrap" title={artifact.sha256}>
                  <span className="inline-flex items-center gap-2">
                    <a
                      href={artifactUrl(artifact.sha256, name)}
                      download={name}
                      onClick={(event) => event.stopPropagation()}
                      className="text-(--accent) hover:underline"
                      aria-label={`Download artifact ${artifact.sha256}`}
                    >
                      {artifact.sha256.slice(0, 12)}
                    </a>
                    {!artifact.referenced && (
                      <span
                        className="rounded px-1.5 py-0.5 font-sans text-[11px] font-medium"
                        style={{
                          color: "var(--hue-warn)",
                          background: "color-mix(in oklch, var(--hue-warn) 12%, transparent)",
                        }}
                      >
                        orphan
                      </span>
                    )}
                  </span>
                </td>
                {shown.has("kind") && (
                  <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap">
                    {artifactKinds.length > 0 ? (
                      <div className="flex flex-nowrap gap-1">
                        {artifactKinds.map((kind) => <KindBadge key={kind} kind={kind} />)}
                      </div>
                    ) : (
                      <span className="text-(--text-faint)">—</span>
                    )}
                  </td>
                )}
                {shown.has("size") && (
                  <td className="mono whitespace-nowrap border-b border-(--border) px-3 py-1.5 text-(--text-dim)">
                    {formatBytes(artifact.sizeBytes)}
                  </td>
                )}
                {shown.has("age") && (
                  <td className="whitespace-nowrap border-b border-(--border) px-3 py-1.5" title={new Date(artifact.mtime).toLocaleString()}>
                    <Ago iso={artifact.mtime} now={now} />
                  </td>
                )}
                {shown.has("references") && (
                  <td className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap">
                    {artifact.references.length > 0 ? (
                      <div className="flex flex-nowrap gap-2">
                        {artifact.references.map((reference) => (
                          <JumpLink
                            key={`${reference.runId}:${reference.kind ?? "unknown"}`}
                            onClick={() => onJumpRun(reference.runId)}
                            title={reference.runId}
                          >
                            {shortId(reference.runId)}
                          </JumpLink>
                        ))}
                      </div>
                    ) : (
                      <span className="text-(--text-faint)">—</span>
                    )}
                  </td>
                )}
                {columns.filter((column) => column.isCustom || column.key.startsWith("custom:")).map((column) => (
                  <CustomCell key={column.key} row={artifact} path={column.key} />
                ))}
              </tr>
            );
          })}
          {visible.length === 0 && (
            <ListEmpty
              colSpan={columns.length}
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

    {selectedSha && (
      <DetailPane
        widthClass="w-full sm:w-[560px]"
        title={
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px] font-normal">
            <button type="button" onClick={closeInspector} className="text-(--text-dim) hover:text-(--accent)">
              Artifacts
            </button>
            <span aria-hidden="true" className="text-(--text-faint)">/</span>
            <span className="mono truncate font-semibold text-(--text)" title={selectedSha} aria-current="page">
              {selectedSha.slice(0, 12)}
            </span>
          </nav>
        }
        actions={
          <>
            <a
              href={artifactUrl(selectedSha, `${selectedSha.slice(0, 12)}${selectedKinds[0] ? `.${selectedKinds[0]}` : ""}`)}
              download
              className="inline-flex rounded-md border border-(--border-strong) px-2.5 py-1.5 text-[12px] font-medium hover:bg-(--surface-2)"
            >
              Download
            </a>
            <Button disabled={contentQ.data === undefined} onClick={() => copyText(contentQ.data ?? "", "raw artifact content")}>
              Copy Raw Content
            </Button>
            <Button onClick={() => copyText(selectedSha, "SHA-256")}>Copy SHA-256</Button>
          </>
        }
        close={<Button onClick={closeInspector}>Close</Button>}
      >
        {!selected && artifactsQ.isPending && <div className="text-(--text-faint)">Loading artifact metadata…</div>}
        {!selected && !artifactsQ.isPending && (
          <div className="mb-4 rounded-md border border-(--border) p-3 text-(--text-faint)">
            Artifact metadata is unavailable. The content may have been pruned.
          </div>
        )}

        {selected && (
          <>
            <section aria-label="Artifact metadata" className="grid grid-cols-2 gap-2 text-[12px]">
              <div><span className="text-(--text-faint)">Size</span><div className="mono mt-0.5">{formatBytes(selected.sizeBytes)}</div></div>
              <div><span className="text-(--text-faint)">Modified</span><div className="mono mt-0.5">{new Date(selected.mtime).toLocaleString()}</div></div>
              <div className="col-span-2">
                <span className="text-(--text-faint)">Kinds</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {selectedKinds.length ? selectedKinds.map((kind) => <KindBadge key={kind} kind={kind} />) : <span>unknown</span>}
                </div>
              </div>
              <div className="col-span-2 min-w-0">
                <span className="text-(--text-faint)">SHA-256</span>
                <div className="mono mt-0.5 break-all">{selectedSha}</div>
              </div>
            </section>

            <section aria-label="Artifact run references" className="mt-5 border-t border-(--border) pt-4 text-[12px]">
              <h2 className="display font-semibold">Run references</h2>
              <div className="mt-3 grid gap-3">
                <div>
                  <div className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">Producing runs</div>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {selected.references.length ? selected.references.map((reference) => (
                      <JumpLink key={`${reference.runId}:${reference.kind ?? "unknown"}`} onClick={() => onJumpRun(reference.runId)} title={`Open producing run ${reference.runId}`}>
                        {shortId(reference.runId)}{reference.kind ? ` · ${reference.kind}` : ""}
                      </JumpLink>
                    )) : <span className="text-(--text-faint)">No accepted result references this artifact.</span>}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">Consuming runs</div>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {consumers.length ? consumers.map((event) => (
                      <JumpLink key={`${event.source}:${event.eventId}:${event.runId}`} onClick={() => onJumpRun(event.runId!)} title={`Open consuming run ${event.runId}`}>
                        {shortId(event.runId!)}
                      </JumpLink>
                    )) : <span className="text-(--text-faint)">{eventsQ.isPending ? "Resolving…" : "No consuming runs found."}</span>}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">Causation links</div>
                  <div className="mt-1.5 grid gap-1">
                    {causation.length ? causation.map((event) => (
                      <div key={`${event.source}:${event.eventId}`} className="flex flex-wrap items-center gap-1.5">
                        <span className="mono text-(--text-faint)">{event.source}:{shortId(event.eventId)}</span>
                        {event.runId && <><span aria-hidden="true">→</span><JumpLink onClick={() => onJumpRun(event.runId!)} title={`Open caused run ${event.runId}`}>{shortId(event.runId)}</JumpLink></>}
                      </div>
                    )) : <span className="text-(--text-faint)">{eventsQ.isPending ? "Resolving…" : "No caused events found."}</span>}
                  </div>
                </div>
              </div>
            </section>
          </>
        )}

        <section aria-label="Artifact preview" className="mt-5 border-t border-(--border) pt-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="display text-[12px] font-semibold">Preview</h2>
              <p className="mt-0.5 text-[11px] text-(--text-faint)">
                {viewShown
                  ? `${producerAgent?.outputView?.title ?? "view"} · ${producerAgent?.ref}`
                  : matchCount === null
                    ? `${previewLines.length.toLocaleString()} lines`
                    : `${matchCount.toLocaleString()} matching lines`}
              </p>
            </div>
            {!viewShown && (
              <FilterInput value={contentSearch} onChange={setContentSearch} placeholder="Find in content…" label="Search artifact content" />
            )}
          </div>
          {contentQ.isPending && <div className="mt-3 text-[12px] text-(--text-faint)">Loading artifact preview…</div>}
          {contentQ.isError && <div className="mt-3 text-[12px] text-(--hue-err)">Could not load artifact content: {(contentQ.error as Error).message}</div>}
          {preview !== null && (
            <div className="mt-3">
              <ArtifactPanel
                artifact={parsedArtifact ?? preview}
                schema={producerAgent?.outputSchema}
                view={parsedArtifact ? producerAgent?.outputView : null}
                onJumpRun={onJumpRun}
                raw={artifactRaw}
                onRawChange={setArtifactRaw}
                rawFallback={
                  <div role="region" aria-label="Artifact content" className="mono max-h-[60vh] overflow-auto rounded-md border border-(--border) bg-(--surface-0) py-2 text-[11.5px] leading-relaxed">
                    {previewLines.map((line, index) => (
                      <div key={index} className={`grid grid-cols-[4rem_minmax(0,1fr)] px-2 ${contentSearch.trim() && line.toLowerCase().includes(contentSearch.trim().toLowerCase()) ? "bg-(--surface-2)" : ""}`}>
                        <span aria-hidden="true" className="select-none border-r border-(--border) pr-2 text-right text-(--text-faint)">{index + 1}</span>
                        <span className="min-w-0 whitespace-pre-wrap break-words pl-3">{highlightedLine(line, contentSearch)}</span>
                      </div>
                    ))}
                  </div>
                }
              />
            </div>
          )}
        </section>
      </DetailPane>
    )}
    </div>
  );
}
