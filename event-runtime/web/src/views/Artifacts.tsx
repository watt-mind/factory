import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, artifactUrl, fetchArtifacts } from "../api";
import { ArtifactPanel, loadArtifactRaw } from "../components/ArtifactView";
import { DisplayOptions } from "../components/DisplayOptions";
import { CustomCell } from "../components/CustomCell";
import {
  Button,
  DetailPane,
  FilterInput,
  JumpLink,
  ListEmpty,
  ListPane,
  ListToolbar,
  StatCard,
  Table,
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
import { EMPTY, formatBytes, formatRelative } from "../format";
import { hashSearch } from "../hash";
import {
  refetchIntervals,
  useDisplayOptions,
  useListKeys,
  useNow,
} from "../hooks";
import { viewApplies } from "../lib/artifactView";
import type {
  AdmittedEvent,
  AgentDef,
  ArtifactInventoryItem,
  StatusView,
} from "../types";
import { Button as PrimitiveButton } from "../components/ui";

export { formatBytes };

export type ArtifactFilters = {
  kind: string | null;
  orphan: boolean | null;
  search: string;
};

const COMMON_KINDS = ["result", "report", "log", "transcript", "ci-log"];

export function kindsOf(artifact: ArtifactInventoryItem): string[] {
  return [
    ...new Set(
      (artifact.references ?? []).flatMap((reference) => reference.kind ?? []),
    ),
  ];
}

const ARTIFACTS_DISPLAY: DisplayConfig<ArtifactInventoryItem> = {
  view: "artifacts",
  groups: [],
  sorts: [
    {
      key: "sha",
      label: "SHA",
      get: (artifact) => artifact.sha256,
      column: "sha",
    },
    {
      key: "kind",
      label: "Kind",
      get: (artifact) => kindsOf(artifact).join(", "),
      column: "kind",
    },
    {
      key: "size",
      label: "File size",
      get: (artifact) => artifact.sizeBytes,
      column: "size",
    },
    {
      key: "age",
      label: "Age",
      get: (artifact) => Date.parse(artifact.mtime),
      defaultDir: "desc",
      column: "age",
    },
    {
      key: "references",
      label: "Referenced by",
      get: (artifact) =>
        (artifact.references ?? [])
          .map((reference) => reference.runId)
          .join(", "),
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

function matchesSearch(
  artifact: ArtifactInventoryItem,
  search: string,
): boolean {
  const term = search.trim().toLowerCase();
  if (!term) return true;
  return [
    artifact.sha256,
    ...(artifact.references ?? []).flatMap((reference) => [
      reference.runId,
      reference.kind,
      reference.agent,
      reference.state,
    ]),
  ].some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(term),
  );
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

function withCurrentArtifactQuery(path: string): string {
  const query = hashSearch(window.location.hash).toString();
  return `#/${path}${query ? `?${query}` : ""}`;
}

function artifactInspectorHash(sha256: string): string {
  return withCurrentArtifactQuery(`artifacts/${encodeURIComponent(sha256)}`);
}

function openArtifactInspector(sha256: string) {
  if (!ARTIFACT_HASH.test(sha256)) return;
  window.location.hash = artifactInspectorHash(sha256);
}

/** The name a downloaded copy gets: short SHA plus the first kind as extension. */
export function downloadName(sha256: string, kinds: string[]): string {
  return `${sha256.slice(0, 12)}${kinds[0] ? `.${kinds[0]}` : ""}`;
}

/**
 * Bytes the text viewer cannot honestly draw. `Response.text()` decodes as
 * UTF-8, so a zip or an image comes back as NULs and U+FFFD replacements —
 * rendering that as numbered lines is noise the operator has to scroll past.
 */
export function looksBinary(raw: string): boolean {
  const sample = raw.slice(0, 4096);
  if (!sample) return false;
  if (sample.includes("\u0000")) return true;
  const undecodable = sample.replace(/[^\uFFFD]/g, "").length;
  return undecodable / Math.max(sample.length, 50) > 0.02;
}

function containsArtifactHash(
  value: unknown,
  sha256: string,
  seen = new Set<object>(),
): boolean {
  if (typeof value === "string")
    return value === sha256 || value === `sha256:${sha256}`;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Array.isArray(value)
    ? value.some((entry) => containsArtifactHash(entry, sha256, seen))
    : Object.values(value).some((entry) =>
        containsArtifactHash(entry, sha256, seen),
      );
}

/** The stored bytes as one JSON object, or null — the only shape a view can describe. */
export function parsedObject(raw: string): Record<string, unknown> | null {
  if (!/^\s*\{/.test(raw)) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function formattedContent(raw: string, kinds: string[]): string {
  if (kinds.some((kind) => /json/i.test(kind)) || /^\s*[\[{]/.test(raw)) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      // NDJSON/log streams that start with JSON still belong in the text viewer.
    }
  }
  return raw;
}

export function highlightedLine(line: string, search: string): ReactNode {
  const term = search.trim();
  if (!term) return line || " ";
  const lower = line.toLowerCase();
  const needle = term.toLowerCase();
  const chunks: ReactNode[] = [];
  let at = 0;
  let match = lower.indexOf(needle);
  while (match >= 0) {
    chunks.push(line.slice(at, match));
    chunks.push(
      <mark
        key={`${match}:${chunks.length}`}
        className="bg-(--hue-warn) text-inherit"
      >
        {line.slice(match, match + term.length)}
      </mark>,
    );
    at = match + term.length;
    match = lower.indexOf(needle, at);
  }
  chunks.push(line.slice(at));
  return chunks;
}

export function KindBadge({ kind }: { kind: string }) {
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
  onOpenFull,
}: {
  metrics?: StatusView["artifacts"];
  filters: ArtifactFilters;
  onFiltersChange: (filters: ArtifactFilters) => void;
  onJumpRun: (runId: string) => void;
  onOpenFull?: (digest: string) => void;
}) {
  const now = useNow();
  const artifactsQ = useQuery({
    queryKey: ["artifacts"],
    queryFn: () => fetchArtifacts(),
    ...refetchIntervals.primary,
  });
  const artifacts = artifactsQ.data?.artifacts ?? [];
  const [selectedSha, setSelectedSha] = useState(() => artifactShaFromHash());
  const [contentSearch, setContentSearch] = useState("");

  useEffect(() => {
    const syncSelection = () => {
      setContentSearch("");
      setSelectedSha(artifactShaFromHash());
    };
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
    ...refetchIntervals.secondary,
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
      [...new Set([...COMMON_KINDS, ...artifacts.flatMap(kindsOf)])].sort(
        (a, b) => a.localeCompare(b),
      ),
    [artifacts],
  );
  const visible = useMemo(
    () =>
      artifacts.filter((artifact) => {
        if (filters.kind && !kindsOf(artifact).includes(filters.kind))
          return false;
        if (filters.orphan != null && filters.orphan === artifact.referenced)
          return false;
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
  const shown = useMemo(
    () => new Set(columns.map((column) => column.key)),
    [columns],
  );

  const linkedEvents = (eventsQ.data?.events ?? []) as LinkedEvent[];
  const producerRunIds = useMemo(
    () =>
      new Set(selected?.references?.map((reference) => reference.runId) ?? []),
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
    () =>
      linkedEvents.filter(
        (event) => event.causationId && producerRunIds.has(event.causationId),
      ),
    [linkedEvents, producerRunIds],
  );
  const selectedKinds = selected ? kindsOf(selected) : [];
  const selectedName = selectedSha
    ? downloadName(selectedSha, selectedKinds)
    : "";
  const binary = contentQ.data !== undefined && looksBinary(contentQ.data);
  const preview =
    contentQ.data === undefined || binary
      ? null
      : formattedContent(contentQ.data, selectedKinds);
  const parsedArtifact = useMemo(
    () => (contentQ.data === undefined ? null : parsedObject(contentQ.data)),
    [contentQ.data],
  );
  const producerAgent: AgentDef | undefined = useMemo(() => {
    const references = [...(selected?.references ?? [])].sort(
      (a, b) => Number(b.kind === "result") - Number(a.kind === "result"),
    );
    const defs = agentsQ.data?.agents ?? [];
    for (const reference of references) {
      const def = defs.find(
        (agent) =>
          agent.ref === reference.agent || agent.id === reference.agent,
      );
      if (
        parsedArtifact !== null &&
        viewApplies(def?.outputView, parsedArtifact)
      )
        return def;
    }
    return undefined;
  }, [selected, agentsQ.data, parsedArtifact]);
  const viewShown =
    parsedArtifact !== null &&
    viewApplies(producerAgent?.outputView, parsedArtifact) &&
    !artifactRaw;
  const previewLines = preview?.split("\n") ?? [];
  const matchCount = contentSearch.trim()
    ? previewLines.filter((line) =>
        line.toLowerCase().includes(contentSearch.trim().toLowerCase()),
      ).length
    : null;

  const selectArtifact = (sha256: string) => {
    setContentSearch("");
    setSelectedSha(sha256);
    openArtifactInspector(sha256);
  };
  const closeInspector = () => {
    setSelectedSha(null);
    setContentSearch("");
    window.location.hash = withCurrentArtifactQuery("artifacts");
  };

  const openFull = useCallback(
    (sha256: string) => {
      if (onOpenFull) {
        onOpenFull(sha256);
      } else {
        window.location.hash = withCurrentArtifactQuery(
          `artifact/${encodeURIComponent(sha256)}`,
        );
      }
    },
    [onOpenFull],
  );

  const selectedIndex = useMemo(
    () => ordered.findIndex((artifact) => artifact.sha256 === selectedSha),
    [ordered, selectedSha],
  );

  useListKeys({
    count: ordered.length,
    selected: selectedIndex,
    onSelect: (index) => {
      const target = ordered[index];
      if (target) selectArtifact(target.sha256);
    },
    onOpen: () => {
      if (selectedSha) openFull(selectedSha);
    },
    onClose: () => {
      if (selectedSha) closeInspector();
      else if (filters.search) onFiltersChange({ ...filters, search: "" });
    },
  });

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
  const summary: StatusView["artifacts"] = {
    files: metrics?.files ?? fallbackMetrics.files,
    bytes: metrics?.bytes ?? fallbackMetrics.bytes,
    orphans: metrics?.orphans ?? fallbackMetrics.orphans,
    orphanBytes: metrics?.orphanBytes ?? fallbackMetrics.orphanBytes,
    at: metrics?.at,
  };
  const filtered = Boolean(
    filters.kind || filters.orphan != null || filters.search.trim(),
  );
  const set = (patch: Partial<ArtifactFilters>) =>
    onFiltersChange({ ...filters, ...patch });

  return (
    <div className="flex h-full min-w-0">
      <ListPane
        chrome={
          <>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h1 className="display text-h1 font-semibold">Artifacts</h1>
                <p className="mt-1 text-[12px] text-(--text-faint)">
                  Physical files in the content-addressed store. Project context
                  does not narrow this factory-wide inventory.
                </p>
              </div>
              {summary.at && (
                <span
                  className="text-[11px] text-(--text-faint)"
                  title={summary.at}
                >
                  measured {formatRelative(summary.at, now)}
                </span>
              )}
            </div>

            <section
              aria-label="Artifact storage summary"
              className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3"
            >
              <StatCard
                label="Stored files"
                value={summary.files.toLocaleString()}
              />
              <StatCard label="Disk usage" value={formatBytes(summary.bytes)} />
              <StatCard
                label="Orphans"
                value={summary.orphans.toLocaleString()}
                caption={formatBytes(summary.orphanBytes)}
                hue={summary.orphans > 0 ? "var(--hue-warn)" : undefined}
              />
            </section>

            <ListToolbar
              className="mt-3"
              tabs={
                <div
                  className="flex w-max flex-nowrap gap-1 whitespace-nowrap"
                  role="tablist"
                  aria-label="Artifact reference state"
                >
                  {(
                    [
                      { label: "All", value: null, count: summary.files },
                      {
                        label: "Referenced",
                        value: false,
                        count: summary.files - summary.orphans,
                      },
                      {
                        label: "Orphans",
                        value: true,
                        count: summary.orphans,
                      },
                    ] as const
                  ).map((facet) => (
                    <PrimitiveButton
                      bare
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
                      <span className="ml-1.5 tabular-nums text-(--text-faint)">
                        {facet.count.toLocaleString()}
                      </span>
                    </PrimitiveButton>
                  ))}
                </div>
              }
              tools={
                <>
                  <DisplayOptions
                    config={ARTIFACTS_DISPLAY}
                    state={display}
                    onChange={setDisplay}
                    rows={artifacts}
                  />
                  <label className="flex items-center gap-1.5 text-[11px] font-medium text-(--text-dim)">
                    <span>Kind:</span>
                    <select
                      aria-label="Artifact kind"
                      value={filters.kind ?? ""}
                      onChange={(event) =>
                        set({ kind: event.target.value || null })
                      }
                      className="cursor-pointer rounded-md border border-(--border) bg-(--surface-0) px-2 py-1 text-[12px] text-(--text) outline-none hover:border-(--border-strong) focus:border-(--accent)"
                    >
                      <option value="">Any kind</option>
                      {kinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </label>
                  <FilterInput
                    value={filters.search}
                    onChange={(search) => set({ search })}
                    placeholder="SHA, kind, run, agent…"
                    label="Search artifacts"
                  />
                </>
              }
            />
          </>
        }
      >
        <Table
          role="grid"
          aria-label="Artifacts inventory"
          className="w-full border-separate border-spacing-0"
        >
          <thead role="rowgroup">
            <tr role="row" className="text-left">
              {columns.map((column) => {
                const sort = ARTIFACTS_DISPLAY.sorts.find(
                  (field) => field.column === column.key,
                );
                const isCustom =
                  column.isCustom || column.key.startsWith("custom:");
                const customPath = column.key.replace(/^custom:/, "");
                const current = isCustom
                  ? display.sortBy === column.key
                  : sort && display.sortBy === sort.key;
                return (
                  <Th
                    key={column.key}
                    label={column.label}
                    dir={current ? display.sortDir : null}
                    naturalDir={sort?.defaultDir ?? "asc"}
                    onSort={
                      sort || isCustom
                        ? () =>
                            setDisplay((state) =>
                              cycleColumnSort(
                                ARTIFACTS_DISPLAY,
                                state,
                                column.key,
                              ),
                            )
                        : undefined
                    }
                    onRemove={
                      isCustom
                        ? () =>
                            setDisplay((state) =>
                              removeCustomColumn(state, customPath),
                            )
                        : undefined
                    }
                  />
                );
              })}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {ordered.map((artifact) => {
              const artifactKinds = kindsOf(artifact);
              const name = downloadName(artifact.sha256, artifactKinds);
              return (
                <tr
                  key={artifact.sha256}
                  role="row"
                  tabIndex={0}
                  // Link clicks are the browser's to handle. Assigning the
                  // hash here as well as through the SHA anchor's default
                  // navigation would add two history entries.
                  onClick={(event) => {
                    if (
                      event.target instanceof Element &&
                      event.target.closest("a")
                    )
                      return;
                    if (event.metaKey || event.ctrlKey || event.shiftKey)
                      return;
                    selectArtifact(artifact.sha256);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    if (event.target !== event.currentTarget) return;
                    event.preventDefault();
                    selectArtifact(artifact.sha256);
                  }}
                  aria-selected={artifact.sha256 === selectedSha}
                  className={`cursor-pointer hover:bg-(--surface-1) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent) ${artifact.sha256 === selectedSha ? "row-selected" : ""}`}
                >
                  <td
                    role="gridcell"
                    className="mono max-w-48 border-b border-(--border) px-3 py-1.5 whitespace-nowrap"
                    title={artifact.sha256}
                  >
                    <span className="inline-flex items-center gap-2">
                      <a
                        href={artifactInspectorHash(artifact.sha256)}
                        className="text-(--accent) hover:underline"
                        title={`Inspect ${artifact.sha256}`}
                      >
                        {artifact.sha256.slice(0, 12)}
                      </a>
                      <a
                        href={artifactUrl(artifact.sha256, name)}
                        download={name}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Download ${name}`}
                        title={`Download ${name}`}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-(--border) text-(--text-faint) hover:border-(--border-strong) hover:text-(--accent)"
                      >
                        <span aria-hidden="true">↓</span>
                      </a>
                      {!artifact.referenced && (
                        <span
                          className="rounded px-1.5 py-0.5 font-sans text-[11px] font-medium"
                          style={{
                            color: "var(--hue-warn)",
                            background:
                              "color-mix(in oklch, var(--hue-warn) 12%, transparent)",
                          }}
                        >
                          orphan
                        </span>
                      )}
                    </span>
                  </td>
                  {shown.has("kind") && (
                    <td
                      role="gridcell"
                      className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap"
                    >
                      {artifactKinds.length > 0 ? (
                        <div className="flex flex-nowrap gap-1">
                          {artifactKinds.map((kind) => (
                            <KindBadge key={kind} kind={kind} />
                          ))}
                        </div>
                      ) : (
                        <span className="text-(--text-faint)">{EMPTY}</span>
                      )}
                    </td>
                  )}
                  {shown.has("size") && (
                    <td
                      role="gridcell"
                      className="mono whitespace-nowrap border-b border-(--border) px-3 py-1.5 text-(--text-dim)"
                    >
                      {formatBytes(artifact.sizeBytes)}
                    </td>
                  )}
                  {shown.has("age") && (
                    <td
                      role="gridcell"
                      className="whitespace-nowrap border-b border-(--border) px-3 py-1.5"
                      title={new Date(artifact.mtime).toLocaleString()}
                    >
                      <span title={artifact.mtime}>
                        {formatRelative(artifact.mtime, now)}
                      </span>
                    </td>
                  )}
                  {shown.has("references") && (
                    <td
                      role="gridcell"
                      className="border-b border-(--border) px-3 py-1.5 whitespace-nowrap"
                    >
                      {(artifact.references?.length ?? 0) > 0 ? (
                        <div className="flex flex-nowrap gap-2">
                          {(artifact.references ?? []).map((reference) => (
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
                        <span className="text-(--text-faint)">{EMPTY}</span>
                      )}
                    </td>
                  )}
                  {columns
                    .filter(
                      (column) =>
                        column.isCustom || column.key.startsWith("custom:"),
                    )
                    .map((column) => (
                      <CustomCell
                        key={column.key}
                        row={artifact}
                        path={column.key}
                      />
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
                onClear={() =>
                  onFiltersChange({ kind: null, orphan: null, search: "" })
                }
              />
            )}
          </tbody>
        </Table>
      </ListPane>

      {selectedSha && (
        <DetailPane
          widthClass="w-full sm:w-[560px]"
          title={
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-1.5 text-[13px] font-normal"
            >
              <PrimitiveButton
                bare
                type="button"
                onClick={closeInspector}
                className="text-(--text-dim) hover:text-(--accent)"
              >
                Artifacts
              </PrimitiveButton>
              <span aria-hidden="true" className="text-(--text-faint)">
                /
              </span>
              <span
                className="mono truncate font-semibold text-(--text)"
                title={selectedSha}
                aria-current="page"
              >
                {selectedSha.slice(0, 12)}
              </span>
            </nav>
          }
          actions={
            <>
              <Button
                onClick={() => openFull(selectedSha)}
                title="Open in full page (o)"
              >
                <span>Open in full page</span>
                <span
                  aria-hidden="true"
                  className="mono ml-1 text-(--text-faint) text-xs"
                >
                  o
                </span>
              </Button>
              <a
                href={artifactUrl(selectedSha, selectedName)}
                download={selectedName}
                className="inline-flex rounded-md border border-(--border-strong) px-2.5 py-1.5 text-[12px] font-medium hover:bg-(--surface-2)"
              >
                Download
              </a>
              <Button
                disabled={contentQ.data === undefined || binary}
                onClick={() =>
                  copyText(contentQ.data ?? "", "raw artifact content")
                }
              >
                Copy Raw Content
              </Button>
              <Button onClick={() => copyText(selectedSha, "SHA-256")}>
                Copy SHA-256
              </Button>
            </>
          }
          close={<Button onClick={closeInspector}>Close</Button>}
        >
          {!selected && artifactsQ.isPending && (
            <div className="text-(--text-faint)">
              Loading artifact metadata…
            </div>
          )}
          {!selected && !artifactsQ.isPending && (
            <div className="mb-4 rounded-md border border-(--border) p-3 text-(--text-faint)">
              Artifact metadata is unavailable. The content may have been
              pruned.
            </div>
          )}

          {selected && (
            <>
              <section
                aria-label="Artifact metadata"
                className="grid grid-cols-2 gap-2 text-[12px]"
              >
                <div>
                  <span className="text-(--text-faint)">Size</span>
                  <div className="mono mt-0.5">
                    {formatBytes(selected.sizeBytes)}
                  </div>
                </div>
                <div>
                  <span className="text-(--text-faint)">Modified</span>
                  <div className="mono mt-0.5">
                    {new Date(selected.mtime).toLocaleString()}
                  </div>
                </div>
                <div className="col-span-2">
                  <span className="text-(--text-faint)">Kinds</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {selectedKinds.length ? (
                      selectedKinds.map((kind) => (
                        <KindBadge key={kind} kind={kind} />
                      ))
                    ) : (
                      <span>unknown</span>
                    )}
                  </div>
                </div>
                <div className="col-span-2 min-w-0">
                  <span className="text-(--text-faint)">SHA-256</span>
                  <div className="mono mt-0.5 break-all">{selectedSha}</div>
                </div>
              </section>

              <section
                aria-label="Artifact run references"
                className="mt-5 border-t border-(--border) pt-4 text-[12px]"
              >
                <h2 className="display font-semibold">Run references</h2>
                <div className="mt-3 grid gap-3">
                  <div>
                    <div className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
                      Producing runs
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {selected.references?.length ? (
                        selected.references.map((reference) => (
                          <JumpLink
                            key={`${reference.runId}:${reference.kind ?? "unknown"}`}
                            onClick={() => onJumpRun(reference.runId)}
                            title={`Open producing run ${reference.runId}`}
                          >
                            {shortId(reference.runId)}
                            {reference.kind ? ` · ${reference.kind}` : ""}
                          </JumpLink>
                        ))
                      ) : (
                        <span className="text-(--text-faint)">
                          No accepted result references this artifact.
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
                      Consuming runs
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {consumers.length ? (
                        consumers.map((event) => (
                          <JumpLink
                            key={`${event.source}:${event.eventId}:${event.runId}`}
                            onClick={() => onJumpRun(event.runId!)}
                            title={`Open consuming run ${event.runId}`}
                          >
                            {shortId(event.runId!)}
                          </JumpLink>
                        ))
                      ) : (
                        <span className="text-(--text-faint)">
                          {eventsQ.isPending
                            ? "Resolving…"
                            : "No consuming runs found."}
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
                      Causation links
                    </div>
                    <div className="mt-1.5 grid gap-1">
                      {causation.length ? (
                        causation.map((event) => (
                          <div
                            key={`${event.source}:${event.eventId}`}
                            className="flex flex-wrap items-center gap-1.5"
                          >
                            <span className="mono text-(--text-faint)">
                              {event.source}:{shortId(event.eventId)}
                            </span>
                            {event.runId && (
                              <>
                                <span aria-hidden="true">→</span>
                                <JumpLink
                                  onClick={() => onJumpRun(event.runId!)}
                                  title={`Open caused run ${event.runId}`}
                                >
                                  {shortId(event.runId)}
                                </JumpLink>
                              </>
                            )}
                          </div>
                        ))
                      ) : (
                        <span className="text-(--text-faint)">
                          {eventsQ.isPending
                            ? "Resolving…"
                            : "No caused events found."}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </>
          )}

          <section
            aria-label="Artifact preview"
            className="mt-5 border-t border-(--border) pt-4"
          >
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="display text-[12px] font-semibold">Preview</h2>
                <p className="mt-0.5 text-[11px] text-(--text-faint)">
                  {viewShown
                    ? `${producerAgent?.outputView?.title ?? "view"} · ${producerAgent?.ref}`
                    : binary
                      ? "not text"
                      : matchCount === null
                        ? `${previewLines.length.toLocaleString()} ${previewLines.length === 1 ? "line" : "lines"}`
                        : `${matchCount.toLocaleString()} matching lines`}
                </p>
              </div>
              {!viewShown && !binary && (
                <FilterInput
                  value={contentSearch}
                  onChange={setContentSearch}
                  placeholder="Find in content…"
                  label="Search artifact content"
                />
              )}
            </div>
            {contentQ.isPending && (
              <div className="mt-3 text-[12px] text-(--text-faint)">
                Loading artifact preview…
              </div>
            )}
            {contentQ.isError && (
              <div className="mt-3 text-[12px] text-(--hue-err)">
                Could not load artifact content:{" "}
                {(contentQ.error as Error).message}
              </div>
            )}
            {binary && (
              <div className="mt-3 rounded-md border border-(--border) bg-(--surface-0) p-4 text-[12px]">
                <p className="text-(--text-dim)">
                  These bytes cannot be previewed as text. Download the file to
                  open it in a local viewer.
                </p>
                <dl className="mono mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-(--text-faint)">File</dt>
                  <dd className="break-all">{selectedName}</dd>
                  <dt className="text-(--text-faint)">Size</dt>
                  <dd>
                    {selected ? formatBytes(selected.sizeBytes) : "unknown"}
                  </dd>
                  <dt className="text-(--text-faint)">Kinds</dt>
                  <dd>
                    {selectedKinds.length
                      ? selectedKinds.join(", ")
                      : "unknown"}
                  </dd>
                </dl>
                <a
                  href={artifactUrl(selectedSha, selectedName)}
                  download={selectedName}
                  aria-label="Download file"
                  className="mt-3 inline-flex rounded-md border border-transparent bg-(--accent) px-3 py-1.5 text-[12px] font-medium text-(--on-accent) hover:opacity-90"
                >
                  Download file
                </a>
              </div>
            )}
            {preview !== null && (
              <div className="mt-3">
                <ArtifactPanel
                  artifact={parsedArtifact ?? preview}
                  schema={producerAgent?.outputSchema}
                  view={parsedArtifact ? producerAgent?.outputView : null}
                  onJumpRun={onJumpRun}
                  onOpenFull={() => openFull(selectedSha)}
                  raw={artifactRaw}
                  onRawChange={setArtifactRaw}
                  rawFallback={
                    <div
                      role="region"
                      aria-label="Artifact content"
                      className="mono max-h-[60vh] overflow-auto rounded-md border border-(--border) bg-(--surface-0) py-2 text-sm leading-relaxed"
                    >
                      {previewLines.map((line, index) => (
                        <div
                          key={index}
                          className={`grid grid-cols-[4rem_minmax(0,1fr)] px-2 ${contentSearch.trim() && line.toLowerCase().includes(contentSearch.trim().toLowerCase()) ? "bg-(--surface-2)" : ""}`}
                        >
                          <span
                            aria-hidden="true"
                            className="select-none border-r border-(--border) pr-2 text-right text-(--text-faint)"
                          >
                            {index + 1}
                          </span>
                          <span className="min-w-0 whitespace-pre-wrap break-words pl-3">
                            {highlightedLine(line, contentSearch)}
                          </span>
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
