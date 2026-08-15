import { useQuery } from "@tanstack/react-query";
import { Fragment, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { RunState, TraceEntry, TracePayload } from "../types";
import { isCancellable } from "./RunDetailBlocks";
import { humanSize, JsonBlock, Section, notify } from "./ui";

function copyText(text: string, label: string = "text") {
  navigator.clipboard.writeText(text);
  notify(`Copied ${label} to clipboard`, "info");
}

/** States in which the trace is still being written — poll incrementally. */
const LIVE_STATES: RunState[] = ["LEASED", "RUNNING", "VERIFYING"];

/** Server page cap; the recorder's row cap (2000 + 1 marker) is ≤ 5 pages. */
const PAGE = 500;

/** Panel tail: triage shows the newest activity; reading happens full-page. */
const PANEL_TAIL = 20;

type TraceFilterKind = "all" | "tools" | "reasoning" | "errors" | "usage";

/**
 * Incremental trace feed, same pattern as the Overview journal feed: each
 * poll passes `since=<last received seq>` and appends only what is new. The
 * cursor is the last *received* seq — never the server head, which would
 * skip rows whenever a read filled a whole page. The accumulated array lives
 * in the query cache (keyed per run), so a re-mounted detail pane renders a
 * terminal run's full trace without refetching — and the panel and the
 * full-page view share one feed instead of polling twice.
 */
function useTraceFeed(runId: string, live: boolean) {
  const acc = useRef<TraceEntry[]>([]);
  const cursor = useRef(0);
  const query = useQuery<TraceEntry[]>({
    queryKey: ["trace", runId],
    queryFn: async () => {
      // Page forward until caught up — bounded by the recorder's row cap.
      for (;;) {
        const res = await api.trace(runId, cursor.current, PAGE);
        if (res.entries.length) {
          const seen = new Set(acc.current.map((e) => e.seq));
          acc.current = [...acc.current, ...res.entries.filter((e) => !seen.has(e.seq))];
          cursor.current = res.entries[res.entries.length - 1].seq;
        }
        if (res.entries.length < PAGE) break;
      }
      return acc.current;
    },
    // ~1.5 s while the agent runs; terminal/pre-execution runs fetch once on
    // mount (historical traces stay browsable) and stop polling.
    refetchInterval: live ? 1500 : false,
  });

  // One catch-up read when the run leaves the live states: the tail written
  // between the last poll and the terminal transition must not be lost.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) query.refetch();
    wasLive.current = live;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const entries = query.data ?? [];
  return {
    entries,
    isPending: query.isPending && entries.length === 0,
    isError: query.isError && entries.length === 0,
  };
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const tokenRegex = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)]+\))/g;
  const nodes: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(text.slice(lastIdx, match.index));
    }
    const full = match[0];
    if (match[1]) {
      nodes.push(
        <code key={match.index} className="mono rounded bg-(--surface-2) px-1 py-0.5 text-[11px] text-(--text)">
          {full.slice(1, -1)}
        </code>
      );
    } else if (match[2]) {
      nodes.push(<strong key={match.index} className="font-semibold text-(--text)">{full.slice(2, -2)}</strong>);
    } else if (match[3]) {
      nodes.push(<em key={match.index} className="italic text-(--text-dim)">{full.slice(1, -1)}</em>);
    } else if (match[4]) {
      nodes.push(<del key={match.index} className="line-through text-(--text-faint)">{full.slice(2, -2)}</del>);
    } else if (match[5]) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(full);
      if (linkMatch) {
        nodes.push(
          <a key={match.index} href={linkMatch[2]} target="_blank" rel="noreferrer" className="text-(--accent) underline hover:opacity-80">
            {linkMatch[1]}
          </a>
        );
      } else {
        nodes.push(full);
      }
    }
    lastIdx = tokenRegex.lastIndex;
  }
  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx));
  }
  return nodes.length ? nodes : [text];
}

export function MarkdownView({
  text,
  allowToggle = true,
  className = "",
}: {
  text: string;
  allowToggle?: boolean;
  className?: string;
}) {
  const [raw, setRaw] = useState(false);

  if (raw) {
    return (
      <div className={`relative ${className}`}>
        {allowToggle && (
          <div className="mb-1 flex justify-end gap-2 text-[11px]">
            <button type="button" onClick={() => copyText(text, "raw markdown")} className="text-(--text-faint) hover:text-(--text)">Copy</button>
            <button type="button" onClick={() => setRaw(false)} className="text-(--accent) hover:underline">Formatted view</button>
          </div>
        )}
        <pre className="mono overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-2.5 text-[11.5px] leading-relaxed whitespace-pre-wrap text-(--text-dim)">
          {text}
        </pre>
      </div>
    );
  }

  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeBuffer: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let listItems: string[] = [];

  const flushList = (key: number) => {
    if (!listType || !listItems.length) return;
    if (listType === "ul") {
      blocks.push(
        <ul key={`ul-${key}`} className="my-1 ml-4 list-disc space-y-0.5 text-[12px] text-(--text-dim)">
          {listItems.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      );
    } else {
      blocks.push(
        <ol key={`ol-${key}`} className="my-1 ml-4 list-decimal space-y-0.5 text-[12px] text-(--text-dim)">
          {listItems.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>
      );
    }
    listType = null;
    listItems = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      flushList(i);
      if (inCodeBlock) {
        inCodeBlock = false;
        const codeText = codeBuffer.join("\n");
        blocks.push(
          <div key={`code-${i}`} className="my-1.5 overflow-hidden rounded-md border border-(--border) bg-(--surface-0)">
            <div className="flex items-center justify-between border-b border-(--border) bg-(--surface-1) px-2.5 py-0.5 text-[11px] text-(--text-faint) mono">
              <span>{codeLang || "code"}</span>
              <button type="button" onClick={() => copyText(codeText, "code block")} className="hover:text-(--text)">Copy</button>
            </div>
            <pre className="mono overflow-auto p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-(--text)">
              {codeText}
            </pre>
          </div>
        );
        codeBuffer = [];
        codeLang = "";
      } else {
        inCodeBlock = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushList(i);
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      if (level === 1) {
        blocks.push(<h1 key={i} className="mb-1.5 mt-2 text-[14px] font-semibold text-(--text) border-b border-(--border) pb-0.5">{renderInlineMarkdown(content)}</h1>);
      } else if (level === 2) {
        blocks.push(<h2 key={i} className="mb-1 mt-2 text-[13px] font-semibold text-(--text) border-b border-(--border) pb-0.5">{renderInlineMarkdown(content)}</h2>);
      } else if (level === 3) {
        blocks.push(<h3 key={i} className="mb-0.5 mt-1.5 text-[12px] font-semibold text-(--text)">{renderInlineMarkdown(content)}</h3>);
      } else {
        blocks.push(<h4 key={i} className="mb-0.5 mt-1 text-[12px] font-semibold text-(--text)">{renderInlineMarkdown(content)}</h4>);
      }
      continue;
    }

    if (line.startsWith("> ")) {
      flushList(i);
      blocks.push(
        <blockquote key={i} className="my-1 border-l-2 border-(--accent) pl-2.5 italic text-(--text-dim) text-[12px]">
          {renderInlineMarkdown(line.slice(2))}
        </blockquote>
      );
      continue;
    }

    const ulMatch = /^[-*]\s+(.+)$/.exec(line);
    if (ulMatch) {
      if (listType !== "ul") flushList(i);
      listType = "ul";
      listItems.push(ulMatch[1]);
      continue;
    }

    const olMatch = /^(\d+)\.\s+(.+)$/.exec(line);
    if (olMatch) {
      if (listType !== "ol") flushList(i);
      listType = "ol";
      listItems.push(olMatch[2]);
      continue;
    }

    flushList(i);
    if (!line.trim()) {
      blocks.push(<div key={i} className="h-1" />);
    } else {
      blocks.push(
        <p key={i} className="my-0.5 text-[12px] leading-relaxed text-(--text-dim)">
          {renderInlineMarkdown(line)}
        </p>
      );
    }
  }
  flushList(lines.length);

  return (
    <div className={`relative ${className}`}>
      {allowToggle && text.length > 50 && (
        <div className="mb-1 flex justify-end gap-2 text-[11px]">
          <button type="button" onClick={() => copyText(text, "markdown text")} className="text-(--text-faint) hover:text-(--text)">Copy</button>
          <button type="button" onClick={() => setRaw(true)} className="text-(--text-faint) hover:text-(--accent)">Raw</button>
        </div>
      )}
      <div className="space-y-0.5">{blocks}</div>
    </div>
  );
}

function ContentBlock({ content }: { content: unknown }) {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return <JsonBlock value={parsed} />;
      } catch {
        // Fall back to plain text if not valid JSON
      }
    }
    return <MarkdownView text={content} />;
  }
  return <JsonBlock value={content ?? null} />;
}

function getEntryDuration(e: TraceEntry, next?: TraceEntry): number | null {
  if (e.payload?.durationMs != null) return e.payload.durationMs;
  if (!next) return null;
  const delta = Date.parse(next.ts) - Date.parse(e.ts);
  return Number.isNaN(delta) || delta < 0 ? null : delta;
}

function TimingWaterfall({ durationMs, maxMs }: { durationMs: number; maxMs: number }) {
  const pct = Math.min(100, Math.max(8, (durationMs / (maxMs || 1)) * 100));
  const durLabel = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
  return (
    <div className="flex items-center gap-1.5 mono text-[10px] text-(--text-faint)" title={`Execution time: ${durLabel}`}>
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-(--surface-2)">
        <div className="h-full rounded-full bg-(--accent) opacity-80" style={{ width: `${pct}%` }} />
      </div>
      <span>{durLabel}</span>
    </div>
  );
}

/**
 * Lazy disclosure for trace entries: does not mount or tokenize JSON payloads
 * until expanded. Supports forceOpen from expandAll without re-mounting the row.
 */
function Disclosure({
  label,
  children,
  defaultOpen,
  forceOpen,
}: {
  label: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
}) {
  const initialOpen = forceOpen ?? defaultOpen ?? false;
  const [open, setOpen] = useState(initialOpen);
  const [rendered, setRendered] = useState(initialOpen);

  useEffect(() => {
    if (forceOpen !== undefined) {
      setOpen(forceOpen);
      if (forceOpen) setRendered(true);
    }
  }, [forceOpen]);

  const onToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const isOpen = e.currentTarget.open;
    setOpen(isOpen);
    if (isOpen) setRendered(true);
  };

  return (
    <details open={open} onToggle={onToggle} className="mb-1.5">
      <summary className="cursor-pointer text-[11px] text-(--text-faint) select-none hover:text-(--text-dim)">
        {label}
      </summary>
      {rendered && <div className="mt-1.5">{children}</div>}
    </details>
  );
}

/** One trace row body, by kind. The recorder's truncation marker wins. */
function TraceBody({
  kind,
  p,
  forceOpen,
  durationMs,
  maxMs,
}: {
  kind: string;
  p: TracePayload;
  forceOpen?: boolean;
  durationMs?: number | null;
  maxMs?: number;
}) {
  // Oversize payload clipped in place: whatever the kind was, only the
  // preview survives — say so rather than rendering half a payload silently.
  if (p.truncated) {
    return (
      <div className="min-w-0 flex-1">
        <span className="text-[11px] text-(--hue-warn)">
          {kind} payload truncated · original {humanSize(p.originalBytes ?? 0)}
        </span>
        {p.preview && (
          <Disclosure label="preview" forceOpen={forceOpen}>
            <ContentBlock content={p.preview} />
          </Disclosure>
        )}
      </div>
    );
  }
  if (kind === "lifecycle" && p.note === "policy_denial") {
    return (
      <div className="min-w-0 flex-1" style={{ color: "var(--hue-err)" }}>
        <span className="font-medium">Denied: {p.tool ?? "tool"}</span>
        {p.rule ? <span className="ml-1 text-(--text-dim)">— {p.rule}</span> : null}
      </div>
    );
  }
  if (kind === "assistant_text") {
    return (
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1">
            <MarkdownView text={p.text ?? ""} />
          </div>
          {durationMs != null && maxMs != null && <TimingWaterfall durationMs={durationMs} maxMs={maxMs} />}
        </div>
      </div>
    );
  }
  if (kind === "tool_use") {
    return (
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="mono">tool · {p.name ?? "unknown tool"}</span>
          {durationMs != null && maxMs != null && <TimingWaterfall durationMs={durationMs} maxMs={maxMs} />}
        </div>
        {p.input !== undefined && (
          <Disclosure label="input" forceOpen={forceOpen}>
            <JsonBlock value={p.input} />
          </Disclosure>
        )}
      </div>
    );
  }
  if (kind === "tool_result") {
    return (
      <div className="min-w-0 flex-1">
        <Disclosure
          forceOpen={forceOpen}
          label={
            p.isError ? (
              <span style={{ color: "var(--hue-err)" }}>tool result — error</span>
            ) : (
              "tool result"
            )
          }
        >
          <ContentBlock content={p.content} />
        </Disclosure>
      </div>
    );
  }
  if (kind === "usage") {
    return (
      <div className="min-w-0 flex-1 text-(--text-faint)">
        {p.numTurns ?? "?"} turns · {p.durationMs != null ? `${(p.durationMs / 1000).toFixed(1)}s` : "?"} ·{" "}
        {p.costUSD != null ? `$${p.costUSD.toFixed(4)}` : "?"}
        {p.usage && Object.keys(p.usage).length > 0 && (
          <Disclosure label="tokens" forceOpen={forceOpen}>
            <JsonBlock value={p.usage} />
          </Disclosure>
        )}
      </div>
    );
  }
  if (kind === "lifecycle") {
    if (p.note === "trace_truncated") {
      return (
        <div className="min-w-0 flex-1" style={{ color: "var(--hue-warn)" }}>
          trace truncated — {p.dropped ?? "?"} event{p.dropped === 1 ? "" : "s"} dropped past the cap
        </div>
      );
    }
    return <div className="min-w-0 flex-1 text-(--text-faint)">{p.note ?? "lifecycle"}</div>;
  }
  // Unknown kind (future factory.trace versions): show, do not reinterpret.
  return (
    <div className="min-w-0 flex-1">
      <Disclosure label={kind} forceOpen={forceOpen}>
        <JsonBlock value={p} />
      </Disclosure>
    </div>
  );
}

const isToolKind = (k: string) => k === "tool_use" || k === "tool_result";
const isReasoningKind = (k: string) => k === "assistant_text";
const isErrorKind = (e: TraceEntry) =>
  (e.kind === "lifecycle" && e.payload?.note === "policy_denial") ||
  (e.kind === "tool_result" && Boolean(e.payload?.isError)) ||
  (e.kind === "lifecycle" && e.payload?.note === "trace_truncated");
const isUsageKind = (k: string) => k === "usage";

const FILTER_ORDER: TraceFilterKind[] = ["all", "tools", "reasoning", "errors", "usage"];

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=true]"));
}

/**
 * Trace (webui doc §10.10, §10.11, controls OPS-358) — the factory.trace/v1 stream:
 * what the model is saying and which tools it is calling, live while the run
 * executes, browsable afterwards. Mount with key={runId}.
 *
 * One component, two presentations (the poller is shared, never forked):
 * - `panel` (default): a Section in the run detail panel, tail-only past
 *   PANEL_TAIL entries with an "open full view" jump (`onExpand`).
 * - `full`: the main column of `#/run/:id` — everything, plus client-side
 *   kind filter chips, expand-all toggle, and syntax highlighting.
 */
export function RunTrace({
  runId,
  state,
  variant = "panel",
  onExpand,
  onCancelShortcut,
}: {
  runId: string;
  state: RunState;
  variant?: "panel" | "full";
  onExpand?: () => void;
  /** Opens the parent's cancel confirm. Search `x` calls this instead of typing. */
  onCancelShortcut?: () => void;
}) {
  const full = variant === "full";
  const live = LIVE_STATES.includes(state);
  const { entries, isPending, isError } = useTraceFeed(runId, live);
  const [filter, setFilter] = useState<TraceFilterKind>("all");
  const [expandAll, setExpandAll] = useState<boolean>(false);
  const [search, setSearch] = useState<string>("");
  const [activeMatch, setActiveMatch] = useState<number>(0);
  const [followLive, setFollowLive] = useState<boolean>(true);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const lastSeenSeqRef = useRef<number>(0);
  const [activeErrorIdx, setActiveErrorIdx] = useState<number | null>(null);
  const [jumpCount, setJumpCount] = useState<number>(0);
  const [expandedSeqs, setExpandedSeqs] = useState<Set<number>>(new Set());

  const counts = useMemo(() => {
    let tools = 0;
    let reasoning = 0;
    let errors = 0;
    let usage = 0;
    for (const e of entries) {
      if (isToolKind(e.kind)) tools++;
      if (isReasoningKind(e.kind)) reasoning++;
      if (isErrorKind(e)) errors++;
      if (isUsageKind(e.kind)) usage++;
    }
    return { all: entries.length, tools, reasoning, errors, usage };
  }, [entries]);

  const allErrorEntries = useMemo(() => entries.filter(isErrorKind), [entries]);

  const tokenStats = useMemo(() => {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalCost = 0;
    let hasTokens = false;
    for (const e of entries) {
      if (e.payload?.usage) {
        hasTokens = true;
        const u = e.payload.usage;
        promptTokens += u.input_tokens ?? u.prompt_tokens ?? u.inputTokens ?? 0;
        completionTokens += u.output_tokens ?? u.completion_tokens ?? u.outputTokens ?? 0;
      }
      if (e.payload?.costUSD) totalCost += e.payload.costUSD;
    }
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, totalCost, hasTokens };
  }, [entries]);

  const visibleEntries = useMemo(() => {
    if (filter === "all") return entries;
    if (filter === "tools") return entries.filter((e) => isToolKind(e.kind));
    if (filter === "reasoning") return entries.filter((e) => isReasoningKind(e.kind));
    if (filter === "errors") return entries.filter(isErrorKind);
    if (filter === "usage") return entries.filter((e) => isUsageKind(e.kind));
    return entries;
  }, [entries, filter]);

  const tailCut = !full && visibleEntries.length > PANEL_TAIL;
  const shown = tailCut ? visibleEntries.slice(-PANEL_TAIL) : visibleEntries;

  const handleJumpToError = () => {
    if (allErrorEntries.length === 0) return;
    const nextIdx = activeErrorIdx === null ? 0 : (activeErrorIdx + 1) % allErrorEntries.length;
    const target = allErrorEntries[nextIdx];
    setActiveErrorIdx(nextIdx);
    setJumpCount((c) => c + 1);
    if (target) {
      setExpandedSeqs((prev) => {
        const next = new Set(prev);
        next.add(target.seq);
        return next;
      });
      const inShown = shown.some((e) => e.seq === target.seq);
      if (!inShown) {
        setFilter(full ? "all" : "errors");
      }
    }
  };

  // Waterfall timing calculations:
  const { durations, maxDurationMs } = useMemo(() => {
    const map = new Map<number, number>();
    let max = 0;
    for (let i = 0; i < shown.length; i++) {
      const dur = getEntryDuration(shown[i], shown[i + 1]);
      if (dur != null) {
        map.set(shown[i].seq, dur);
        if (dur > max) max = dur;
      }
    }
    return { durations: map, maxDurationMs: max || 1000 };
  }, [shown]);

  // In-trace text search matches:
  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const matches: number[] = [];
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i];
      const text = [
        e.kind,
        e.payload?.text,
        e.payload?.name,
        e.payload?.note,
        typeof e.payload?.input === "object" ? JSON.stringify(e.payload.input) : String(e.payload?.input ?? ""),
        typeof e.payload?.content === "object" ? JSON.stringify(e.payload.content) : String(e.payload?.content ?? ""),
      ].join(" ").toLowerCase();
      if (text.includes(q)) matches.push(i);
    }
    return matches;
  }, [shown, search]);

  const scroller = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);

  const onTraceRegionKeyDown = (e: ReactKeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    const i = FILTER_ORDER.indexOf(filter);
    if (i < 0) return;
    let next: TraceFilterKind | null = null;
    if (e.key === "ArrowRight") next = FILTER_ORDER[(i + 1) % FILTER_ORDER.length];
    else if (e.key === "ArrowLeft") next = FILTER_ORDER[(i - 1 + FILTER_ORDER.length) % FILTER_ORDER.length];
    else if (e.key === "Home") next = FILTER_ORDER[0];
    else if (e.key === "End") next = FILTER_ORDER[FILTER_ORDER.length - 1];
    if (!next || next === filter) {
      if (next === filter) e.preventDefault();
      return;
    }
    e.preventDefault();
    setFilter(next);
    if ((e.target as HTMLElement).closest('[role="tab"]')) {
      const key = next;
      queueMicrotask(() => {
        regionRef.current?.querySelector<HTMLElement>(`[role="tab"][data-filter="${key}"]`)?.focus();
      });
    }
  };

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "x" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!isCancellable(state)) return;
    e.preventDefault();
    e.stopPropagation();
    if (onCancelShortcut) {
      onCancelShortcut();
      return;
    }
    e.currentTarget.blur();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
  };

  // Jump to active search match:
  useEffect(() => {
    if (searchMatches.length > 0 && scroller.current) {
      const idx = searchMatches[activeMatch % searchMatches.length];
      const el = scroller.current.querySelector(`[data-trace-idx="${idx}"]`);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeMatch, searchMatches]);

  // Track unread entries when paused or update lastSeenSeq when following live
  useEffect(() => {
    if (!live) {
      setUnreadCount(0);
      return;
    }
    if (followLive) {
      setUnreadCount(0);
      lastSeenSeqRef.current = entries.length > 0 ? entries[entries.length - 1].seq : 0;
    } else {
      const count = entries.filter((e) => e.seq > lastSeenSeqRef.current).length;
      setUnreadCount(count);
    }
  }, [entries, live, followLive]);

  // Jump to active error match:
  useEffect(() => {
    if (activeErrorIdx !== null && allErrorEntries.length > 0 && scroller.current) {
      const target = allErrorEntries[activeErrorIdx % allErrorEntries.length];
      if (!target) return;
      const targetIdx = shown.findIndex((e) => e.seq === target.seq);
      if (targetIdx !== -1) {
        const el = scroller.current.querySelector(`[data-trace-idx="${targetIdx}"]`);
        el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }, [activeErrorIdx, jumpCount, shown, allErrorEntries]);

  // Live auto-scroll:
  useEffect(() => {
    if (live && followLive && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  }, [shown.length, live, followLive]);

  const onScrollHandler = () => {
    if (!scroller.current || !live) return;
    const { scrollTop, scrollHeight, clientHeight } = scroller.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 30;
    if (atBottom) {
      if (!followLive) {
        setFollowLive(true);
      }
      setUnreadCount(0);
      lastSeenSeqRef.current = entries.length > 0 ? entries[entries.length - 1].seq : 0;
    } else {
      if (followLive) {
        setFollowLive(false);
        lastSeenSeqRef.current = entries.length > 0 ? entries[entries.length - 1].seq : 0;
      }
    }
  };

  const jumpToLatest = () => {
    setFollowLive(true);
    setUnreadCount(0);
    lastSeenSeqRef.current = entries.length > 0 ? entries[entries.length - 1].seq : 0;
    if (scroller.current) {
      scroller.current.scrollTo({
        top: scroller.current.scrollHeight,
        behavior: "smooth",
      });
    }
  };

  // Multi-attempt runs: divider per attempt (entries are seq-ascending, so
  // attempts are contiguous). A single attempt needs no labels.
  const multiAttempt = new Set(shown.map((e) => e.attempt)).size > 1;

  const filterTabs: { key: TraceFilterKind; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "tools", label: "Tools", count: counts.tools },
    { key: "reasoning", label: "Reasoning", count: counts.reasoning },
    { key: "errors", label: "Errors", count: counts.errors },
    { key: "usage", label: "Usage", count: counts.usage },
  ];

  const body = (
    <div ref={regionRef} onKeyDown={onTraceRegionKeyDown}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        {live ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (followLive) {
                  setFollowLive(false);
                  lastSeenSeqRef.current = entries.length > 0 ? entries[entries.length - 1].seq : 0;
                } else {
                  jumpToLatest();
                }
              }}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                followLive
                  ? "border-(--border-strong) bg-(--surface-2) text-(--text)"
                  : "border-(--border) bg-(--surface-0) text-(--text-faint) hover:bg-(--surface-1) hover:text-(--text-dim)"
              }`}
              title={followLive ? "Auto-scrolling live. Click to pause." : "Auto-scroll paused. Click to follow live."}
            >
              <span
                className={`size-1.5 rounded-full ${followLive ? "motion-safe:animate-pulse" : ""}`}
                style={{ background: followLive ? "var(--hue-warn)" : "var(--text-faint)" }}
              />
              <span>{followLive ? "Follow live" : "Follow live (paused)"}</span>
            </button>
            {unreadCount > 0 && !followLive ? (
              <span className="text-[11px] font-medium text-(--hue-warn)">
                {unreadCount} new {unreadCount === 1 ? "event" : "events"}
              </span>
            ) : null}
          </div>
        ) : <div />}

        {tokenStats.hasTokens && (
          <div className="flex items-center gap-1.5 rounded bg-(--surface-1) border border-(--border) px-2 py-0.5 text-[11px] mono text-(--text-dim)">
            <span title="Cumulative token burn across trace">{tokenStats.promptTokens.toLocaleString()} in · {tokenStats.completionTokens.toLocaleString()} out</span>
            {tokenStats.totalCost > 0 && <span className="text-(--text-faint)">(${tokenStats.totalCost.toFixed(4)})</span>}
          </div>
        )}
      </div>

      {entries.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Trace kind">
            {filterTabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                data-filter={t.key}
                aria-selected={filter === t.key}
                tabIndex={filter === t.key ? 0 : -1}
                onClick={() => setFilter(t.key)}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  filter === t.key
                    ? "bg-(--surface-3) text-(--text)"
                    : "text-(--text-faint) hover:bg-(--surface-2)"
                }`}
                style={t.key === "errors" && t.count > 0 ? { color: "var(--hue-err)" } : undefined}
              >
                {t.label}
                {t.count > 0 && <span className="ml-1 tabular-nums opacity-75">{t.count}</span>}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {counts.errors > 0 && (
              <button
                type="button"
                onClick={handleJumpToError}
                className="flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors hover:opacity-80"
                style={{
                  borderColor: "var(--hue-err)",
                  color: "var(--hue-err)",
                  background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
                }}
                title="Jump to next error entry"
              >
                <span>{counts.errors === 1 ? "1 error" : `${counts.errors} errors`}</span>
                {activeErrorIdx !== null && (
                  <span className="mono text-[10px] opacity-75">
                    ({(activeErrorIdx % counts.errors) + 1}/{counts.errors})
                  </span>
                )}
              </button>
            )}

            <div className="flex items-center gap-1 rounded border border-(--border) bg-(--surface-0) px-1.5 py-0.5 text-[11px]">
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setActiveMatch(0);
                }}
                onKeyDown={onSearchKeyDown}
                placeholder="Search trace…"
                aria-label="Search trace"
                className="w-24 bg-transparent outline-none text-(--text) placeholder:text-(--text-faint) sm:w-32"
              />
              {search && (
                <>
                  <span className="mono text-[10px] text-(--text-faint)">
                    {searchMatches.length ? `${(activeMatch % searchMatches.length) + 1}/${searchMatches.length}` : "0"}
                  </span>
                  {searchMatches.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setActiveMatch((m) => (m - 1 + searchMatches.length) % searchMatches.length)}
                        className="text-(--text-faint) hover:text-(--text)"
                        title="Previous match"
                        aria-label="Previous match"
                      >
                        <span aria-hidden="true">↑</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveMatch((m) => (m + 1) % searchMatches.length)}
                        className="text-(--text-faint) hover:text-(--text)"
                        title="Next match"
                        aria-label="Next match"
                      >
                        <span aria-hidden="true">↓</span>
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="text-(--text-faint) hover:text-(--text)"
                    title="Clear search"
                    aria-label="Clear search"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setExpandAll((v) => !v);
                if (expandAll) setExpandedSeqs(new Set());
              }}
              className="text-[11px] text-(--text-faint) hover:text-(--text-dim)"
            >
              {expandAll ? "Collapse details" : "Expand details"}
            </button>
          </div>
        </div>
      )}

      {visibleEntries.length === 0 ? (
        <div className="text-(--text-faint)">
          {isPending
            ? "Loading trace…"
            : isError
              ? "Could not load the trace."
              : entries.length > 0
                ? `No entries match "${filter}".`
                : live
                  ? "No trace yet — events appear here as the agent works."
                  : "No trace — this adapter does not stream events."}
        </div>
      ) : (
        <div className="relative">
          <div
            ref={scroller}
            onScroll={onScrollHandler}
            className={`${
              full ? "max-h-[70vh]" : "max-h-96"
            } overflow-auto rounded-md border border-(--border) px-3 py-1`}
          >
            {shown.map((e, i) => {
              const isMatch = searchMatches.includes(i);
              const isActiveMatch = searchMatches.length > 0 && searchMatches[activeMatch % searchMatches.length] === i;
              const isActiveError =
                activeErrorIdx !== null &&
                allErrorEntries.length > 0 &&
                allErrorEntries[activeErrorIdx % allErrorEntries.length]?.seq === e.seq;
              return (
                <Fragment key={e.seq}>
                  {multiAttempt && (i === 0 || shown[i - 1].attempt !== e.attempt) && (
                    <div className="border-b border-(--border) py-1 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
                      Attempt #{e.attempt}
                    </div>
                  )}
                  <div
                    data-trace-idx={i}
                    className={`flex items-baseline gap-2 border-b border-(--border) py-1.5 last:border-0 transition-colors ${
                      isActiveError
                        ? "bg-(--surface-2) -mx-2 px-2 rounded ring-1 ring-(--hue-err)"
                        : isActiveMatch
                          ? "bg-(--surface-2) -mx-2 px-2 rounded"
                          : isMatch
                            ? "bg-(--surface-1) -mx-2 px-2 rounded"
                            : ""
                    }`}
                  >
                    <span className="mono w-[64px] shrink-0 text-(--text-faint)" title={e.ts}>
                      {new Date(e.ts).toLocaleTimeString([], { hour12: false })}
                    </span>
                    <TraceBody
                      kind={e.kind}
                      p={e.payload ?? {}}
                      forceOpen={expandAll || expandedSeqs.has(e.seq)}
                      durationMs={durations.get(e.seq)}
                      maxMs={maxDurationMs}
                    />
                  </div>
                </Fragment>
              );
            })}
          </div>

          {live && !followLive && (
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10">
              <button
                type="button"
                onClick={jumpToLatest}
                className="flex items-center gap-1.5 rounded-full bg-(--accent) px-3 py-1 text-[11px] font-medium text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
              >
                <span>
                  {unreadCount > 0
                    ? `New activity (${unreadCount}) — Jump to latest`
                    : "Jump to latest"}
                </span>
              </button>
            </div>
          )}
        </div>
      )}

      {tailCut && (
        <div className="mt-1.5 text-[11px] text-(--text-faint)">
          showing last {PANEL_TAIL} of {visibleEntries.length} entries
          {onExpand && (
            <>
              {" — "}
              <button type="button" onClick={onExpand} className="text-(--accent) hover:underline">
                open full view
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );

  if (full) {
    return (
      <div>
        <div className="display mb-2 text-[15px] font-semibold">
          Trace{entries.length ? <span className="ml-2 text-(--text-faint)">· {entries.length}</span> : null}
        </div>
        {body}
      </div>
    );
  }
  return <Section title={`Trace${entries.length ? ` · ${entries.length}` : ""}`}>{body}</Section>;
}
