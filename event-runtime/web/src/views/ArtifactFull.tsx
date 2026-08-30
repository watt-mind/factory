import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, artifactUrl, fetchArtifacts } from "../api";
import {
  ArtifactView,
  loadArtifactRaw,
  RawToggle,
  saveArtifactRaw,
} from "../components/ArtifactView";
import {
  Ago,
  Button,
  CopyActions,
  FilterInput,
  JumpLink,
  copyLink,
  copyText,
  shortId,
} from "../components/ui";
import { formatBytes } from "../format";
import { keyGuard, refetchIntervals, useNow } from "../hooks";
import { viewApplies } from "../lib/artifactView";
import { setContextActions } from "../palette";
import type { AgentDef } from "../types";
import {
  downloadName,
  formattedContent,
  highlightedLine,
  KindBadge,
  kindsOf,
  looksBinary,
  parsedObject,
} from "./Artifacts";

/**
 * Full-page artifact reader view (`#/artifact/:digest`, WM-828) —
 * provides a wide, readable measure for long artifacts (reports, scans, plans)
 * with schema-derived view rendering and raw inspection toggle.
 */
export function ArtifactFull({
  digest,
  onBack,
  onJumpRun,
}: {
  digest: string;
  onBack: () => void;
  onJumpRun?: (runId: string) => void;
}) {
  const now = useNow();
  const [contentSearch, setContentSearch] = useState("");
  const [artifactRaw, setArtifactRaw] = useState(loadArtifactRaw);

  const artifactsQ = useQuery({
    queryKey: ["artifact", digest],
    queryFn: () => fetchArtifacts({ search: digest, limit: 1 }),
    enabled: Boolean(digest),
    ...refetchIntervals.primary,
  });
  const artifacts = artifactsQ.data?.artifacts ?? [];

  // The search endpoint matches broadly; only trust the row when it is the
  // requested digest rather than a positional hit.
  const selected = artifacts[0]?.sha256 === digest ? artifacts[0] : null;

  const contentQ = useQuery({
    queryKey: ["artifact-content", digest],
    queryFn: async () => {
      const response = await fetch(artifactUrl(digest));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    enabled: Boolean(digest),
  });

  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents(),
    staleTime: 30_000,
  });

  const selectedKinds = selected ? kindsOf(selected) : [];
  const selectedName = digest ? downloadName(digest, selectedKinds) : "";
  const shortDigest = digest.slice(0, 12);

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

  const canToggleView =
    parsedArtifact !== null &&
    viewApplies(producerAgent?.outputView, parsedArtifact);

  const viewShown = canToggleView && !artifactRaw;

  const previewLines = useMemo(
    () => (preview ? preview.split("\n") : []),
    [preview],
  );

  const matchCount = contentSearch.trim()
    ? previewLines.filter((line) =>
        line.toLowerCase().includes(contentSearch.trim().toLowerCase()),
      ).length
    : null;

  const toggleRaw = useCallback(() => {
    setArtifactRaw((prev) => {
      const next = !prev;
      saveArtifactRaw(next);
      return next;
    });
  }, []);

  const setRaw = useCallback((raw: boolean) => {
    saveArtifactRaw(raw);
    setArtifactRaw(raw);
  }, []);

  // Keyboard shortcuts: Esc -> onBack, r -> toggle raw, c / c l -> copy
  useEffect(() => {
    let pendingC = 0;
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const keyNow = Date.now();
      if (e.key === "Escape") {
        e.preventDefault();
        onBack();
        return;
      }
      if (e.key === "r" && canToggleView) {
        e.preventDefault();
        toggleRaw();
        return;
      }
      if (pendingC && keyNow - pendingC < 800) {
        if (e.key === "l") {
          e.preventDefault();
          pendingC = 0;
          copyLink();
          return;
        }
      }
      if (e.key === "c") {
        e.preventDefault();
        pendingC = keyNow;
        copyText(digest, "artifact digest");
      } else {
        pendingC = 0;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [digest, onBack, canToggleView, toggleRaw]);

  // Register palette actions
  useEffect(() => {
    setContextActions([
      { label: "Back to Artifacts", hint: "Esc", run: onBack },
      {
        label: `Copy digest ${shortDigest}`,
        hint: "c",
        run: () => copyText(digest, "artifact digest"),
      },
      { label: "Copy link to this artifact", hint: "c l", run: copyLink },
      ...(canToggleView
        ? [
            {
              label: artifactRaw
                ? "Switch to formatted view"
                : "Switch to raw content",
              hint: "r",
              run: toggleRaw,
            },
          ]
        : []),
    ]);
    return () => setContextActions([]);
  }, [digest, shortDigest, onBack, canToggleView, artifactRaw, toggleRaw]);

  return (
    <div className="fixed inset-0 z-20 flex h-full min-w-0 flex-col overflow-hidden bg-(--surface-0) sm:static sm:z-auto">
      <header className="sticky top-0 z-10 flex shrink-0 flex-col items-stretch gap-2 border-b border-(--border) bg-(--surface-1) px-6 py-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <nav aria-label="Breadcrumb" className="flex items-center gap-2">
            <ol className="flex min-w-0 flex-wrap items-center gap-2 list-none p-0 m-0 text-[13px]">
              <li className="shrink-0">
                <Button onClick={onBack}>
                  <span>← Artifacts</span>
                  <span
                    aria-hidden="true"
                    className="mono ml-1 text-(--text-faint) text-xs"
                  >
                    Esc
                  </span>
                </Button>
              </li>
              <li aria-hidden="true" className="text-(--text-faint) shrink-0">
                /
              </li>
              <li
                className="flex min-w-0 items-center gap-2"
                aria-current="page"
              >
                {selectedKinds.length > 0 && (
                  <div className="flex flex-nowrap gap-1">
                    {selectedKinds.map((kind) => (
                      <KindBadge key={kind} kind={kind} />
                    ))}
                  </div>
                )}
                <span
                  className="display mono min-w-0 truncate text-[15px] font-semibold text-(--text)"
                  title={digest}
                >
                  {shortDigest}
                </span>
              </li>
            </ol>
          </nav>

          <div className="flex items-center gap-2">
            <a
              href={artifactUrl(digest, selectedName)}
              download={selectedName}
              className="inline-flex rounded-md border border-(--border-strong) px-2.5 py-1 text-[12px] font-medium hover:bg-(--surface-2)"
            >
              Download
            </a>
            {canToggleView && (
              <div className="flex items-center gap-1">
                <RawToggle raw={artifactRaw} onChange={setRaw} />
                <span
                  aria-hidden="true"
                  className="mono text-(--text-faint) text-xs"
                >
                  r
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-(--text-faint)">
          {selected && (
            <>
              <span className="mono">{formatBytes(selected.sizeBytes)}</span>
              <span aria-hidden="true">·</span>
              <span>
                <Ago iso={selected.mtime} now={now} />
              </span>
              {selected.references && selected.references.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="flex items-center gap-1">
                    <span>produced by</span>
                    {selected.references.map((reference) => (
                      <JumpLink
                        key={`${reference.runId}:${reference.kind ?? "unknown"}`}
                        onClick={() => onJumpRun?.(reference.runId)}
                        title={reference.runId}
                      >
                        {shortId(reference.runId)}
                      </JumpLink>
                    ))}
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
            </>
          )}
          <CopyActions id={digest} idLabel="artifact digest" variant="quiet" />
        </div>
      </header>

      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[1000px]">
          {contentQ.isPending && (
            <div className="text-[13px] text-(--text-faint)">
              Loading artifact content…
            </div>
          )}
          {contentQ.isError && (
            <div className="text-[13px] text-(--hue-err)">
              Could not load artifact content:{" "}
              {(contentQ.error as Error).message}
            </div>
          )}
          {binary && (
            <div className="rounded-md border border-(--border) bg-(--surface-0) p-6 text-[13px]">
              <h2 className="display text-[15px] font-semibold text-(--text)">
                Binary artifact
              </h2>
              <p className="mt-1 text-(--text-dim)">
                These bytes cannot be previewed as text. Download the file to
                open it in a local viewer.
              </p>
              <dl className="mono mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-(--text-faint)">File</dt>
                <dd className="break-all">{selectedName}</dd>
                <dt className="text-(--text-faint)">Size</dt>
                <dd>
                  {selected ? formatBytes(selected.sizeBytes) : "unknown"}
                </dd>
                <dt className="text-(--text-faint)">Kinds</dt>
                <dd>
                  {selectedKinds.length ? selectedKinds.join(", ") : "unknown"}
                </dd>
              </dl>
              <a
                href={artifactUrl(digest, selectedName)}
                download={selectedName}
                className="mt-4 inline-flex rounded-md bg-(--accent) px-3 py-1.5 text-[12px] font-medium text-(--on-accent) hover:opacity-90"
              >
                Download file
              </a>
            </div>
          )}
          {preview !== null && (
            <div>
              {viewShown && producerAgent?.outputView ? (
                <div className="rounded-md border border-(--border) bg-(--surface-0) p-6">
                  <ArtifactView
                    artifact={parsedArtifact}
                    schema={producerAgent.outputSchema}
                    view={producerAgent.outputView}
                    onJumpRun={onJumpRun}
                  />
                </div>
              ) : (
                <div>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="text-[12px] text-(--text-faint)">
                      {matchCount === null
                        ? `${previewLines.length.toLocaleString()} lines`
                        : `${matchCount.toLocaleString()} matching lines`}
                    </div>
                    <FilterInput
                      value={contentSearch}
                      onChange={setContentSearch}
                      placeholder="Find in content…"
                      label="Search artifact content"
                    />
                  </div>
                  <div
                    role="region"
                    aria-label="Artifact content"
                    className="mono overflow-auto rounded-md border border-(--border) bg-(--surface-0) py-3 text-sm leading-relaxed"
                  >
                    {previewLines.map((line, index) => (
                      <div
                        key={index}
                        className={`grid grid-cols-[4rem_minmax(0,1fr)] px-3 ${
                          contentSearch.trim() &&
                          line
                            .toLowerCase()
                            .includes(contentSearch.trim().toLowerCase())
                            ? "bg-(--surface-2)"
                            : ""
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className="select-none border-r border-(--border) pr-3 text-right text-(--text-faint)"
                        >
                          {index + 1}
                        </span>
                        <span className="min-w-0 whitespace-pre-wrap break-words pl-3">
                          {highlightedLine(line, contentSearch)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
