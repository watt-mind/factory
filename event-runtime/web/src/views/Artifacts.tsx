import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, artifactUrl, fetchArtifacts } from "../api";
import {
  Ago,
  Button,
  DetailPane,
  FilterInput,
  JumpLink,
  ListEmpty,
  ListPane,
  copyText,
  humanSize,
  shortId,
} from "../components/ui";
import { useNow } from "../hooks";
import type { AdmittedEvent, ArtifactInventoryItem, StatusView } from "../types";

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
              <tr
                key={artifact.sha256}
                onClick={() => selectArtifact(artifact.sha256)}
                aria-selected={artifact.sha256 === selectedSha}
                className={`cursor-pointer hover:bg-(--surface-1) ${artifact.sha256 === selectedSha ? "row-selected" : ""}`}
              >
                <td className="mono max-w-40 border-b border-(--border) px-3 py-2" title={artifact.sha256}>
                  <a
                    href={artifactUrl(artifact.sha256, name)}
                    download={name}
                    onClick={(event) => event.stopPropagation()}
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
              <div><span className="text-(--text-faint)">Size</span><div className="mono mt-0.5">{humanSize(selected.sizeBytes)}</div></div>
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
                {matchCount === null ? `${previewLines.length.toLocaleString()} lines` : `${matchCount.toLocaleString()} matching lines`}
              </p>
            </div>
            <FilterInput value={contentSearch} onChange={setContentSearch} placeholder="Find in content…" label="Search artifact content" />
          </div>
          {contentQ.isPending && <div className="mt-3 text-[12px] text-(--text-faint)">Loading artifact preview…</div>}
          {contentQ.isError && <div className="mt-3 text-[12px] text-(--hue-err)">Could not load artifact content: {(contentQ.error as Error).message}</div>}
          {preview !== null && (
            <div role="region" aria-label="Artifact content" className="mono mt-3 max-h-[60vh] overflow-auto rounded-md border border-(--border) bg-(--surface-0) py-2 text-[11.5px] leading-relaxed">
              {previewLines.map((line, index) => (
                <div key={index} className={`grid grid-cols-[4rem_minmax(0,1fr)] px-2 ${contentSearch.trim() && line.toLowerCase().includes(contentSearch.trim().toLowerCase()) ? "bg-(--surface-2)" : ""}`}>
                  <span aria-hidden="true" className="select-none border-r border-(--border) pr-2 text-right text-(--text-faint)">{index + 1}</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words pl-3">{highlightedLine(line, contentSearch)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </DetailPane>
    )}
    </div>
  );
}
