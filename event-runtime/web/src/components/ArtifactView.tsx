/**
 * ArtifactView — schema-derived rendering of a run artifact
 * (docs/event-runtime-artifact-views.md §2.4, WM-455).
 *
 * One generic component for every agent that ships a `.view.json`: it draws
 * whatever `lib/artifactView.ts` derived from the view + artifact and never
 * looks at the agent's name. `ArtifactPanel` is what the two artifact
 * positions mount — it owns the View / Raw toggle (persisted like the other
 * display options) and falls back to `JsonBlock` when no view applies.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { hashPath, hashProject, withProject } from "../hash";
import {
  headerFor,
  sectionsFor,
  TONE_HUES,
  viewApplies,
  type Cell,
  type Formatted,
  type RowGroup,
  type SectionModel,
  type TableRow,
} from "../lib/artifactView";
import type { ArtifactTone, ArtifactView as ArtifactViewDoc } from "../types";
import { DisclosureChevron, JsonBlock, JumpLink, StateBadge, Th } from "./ui";

// ---------------------------------------------------------------------------
// Raw toggle persistence
// ---------------------------------------------------------------------------

/** One key for both artifact positions: an operator who wants JSON wants it everywhere. */
export const ARTIFACT_RAW_KEY = "evrt-artifact-raw";

export function loadArtifactRaw(): boolean {
  try {
    return localStorage.getItem(ARTIFACT_RAW_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveArtifactRaw(raw: boolean): void {
  try {
    localStorage.setItem(ARTIFACT_RAW_KEY, raw ? "1" : "0");
  } catch {
    // Private mode / quota: the toggle still works for this page.
  }
}

/** Two-state segmented control, `aria-pressed` on the active half. */
export function RawToggle({ raw, onChange }: { raw: boolean; onChange: (raw: boolean) => void }) {
  const opt = (value: boolean, label: string) => (
    <button
      type="button"
      aria-pressed={raw === value}
      onClick={() => onChange(value)}
      className={`cursor-pointer rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
        raw === value ? "bg-(--surface-3) text-(--text)" : "text-(--text-faint) hover:text-(--text-dim)"
      }`}
    >
      {label}
    </button>
  );
  return (
    <span
      role="group"
      aria-label="Artifact rendering"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-(--border) bg-(--surface-1) p-0.5"
    >
      {opt(false, "View")}
      {opt(true, "Raw")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const toneStyle = (tone: ArtifactTone | undefined) =>
  tone && tone !== "neutral" ? { color: TONE_HUES[tone] } : undefined;

/** A tone-bearing value wears the same pill as a state badge — one shape for "this is a verdict". */
function TonePill({ text, tone }: { text: string; tone: ArtifactTone }) {
  const hue = TONE_HUES[tone];
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{ color: hue, background: `color-mix(in oklch, ${hue} 12%, transparent)` }}
    >
      {text}
    </span>
  );
}

const compactJson = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

function runHref(runId: string): string {
  return `#/${withProject(hashPath("runs", runId), hashProject(window.location.hash))}`;
}

/** Draw one formatted value. `block` is the expanded/keyvalue rendering, where nested JSON gets room. */
function Value({
  f,
  tone,
  block = false,
  onJumpRun,
}: {
  f: Formatted;
  tone?: ArtifactTone;
  block?: boolean;
  onJumpRun?: (runId: string) => void;
}) {
  switch (f.kind) {
    case "empty":
      return <span className="text-(--text-faint)">—</span>;
    case "chip": {
      const title =
        f.chip === "issue" ? `Open ${f.id} in Linear` : f.chip === "pr" ? (f.href ? `Open pull request ${f.text}` : `Pull request ${f.text}`) : f.id;
      if (f.chip === "run") {
        return (
          <JumpLink
            href={onJumpRun ? undefined : runHref(f.id)}
            onClick={onJumpRun ? () => onJumpRun(f.id) : undefined}
            title={title}
            className="text-(--accent)"
          >
            {f.text}
          </JumpLink>
        );
      }
      if (!f.href) return <span className="mono">{f.text}</span>;
      return (
        <a
          href={f.href}
          target="_blank"
          rel="noreferrer"
          title={title}
          onClick={(e) => e.stopPropagation()}
          className="mono text-(--accent) hover:underline"
        >
          {f.text}
        </a>
      );
    }
    case "state":
      return <StateBadge state={f.state} />;
    case "link":
      return (
        <a href={f.href} target="_blank" rel="noreferrer" className="break-all text-(--accent) hover:underline">
          {f.text}
        </a>
      );
    case "json":
      if (block) {
        if (Array.isArray(f.value) && f.value.every((v) => v === null || typeof v !== "object")) {
          return (
            <ul className="m-0 list-none p-0">
              {f.value.map((v, i) => (
                <li key={i} className="mono break-all py-px text-[11.5px] text-(--text-dim)">
                  {String(v)}
                </li>
              ))}
            </ul>
          );
        }
        return <JsonBlock value={f.value} />;
      }
      return (
        <span className="mono text-(--text-faint)" title={JSON.stringify(f.value)}>
          {compactJson(f.value)}
        </span>
      );
    case "text":
      if (tone && tone !== "muted") return <TonePill text={f.text} tone={tone} />;
      return (
        <span
          className={`${f.mono ? "mono" : ""} ${block ? "break-words whitespace-pre-wrap" : ""} ${
            tone === "muted" ? "text-(--text-faint)" : ""
          }`}
          style={toneStyle(tone)}
          title={f.title}
        >
          {f.text}
        </span>
      );
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function SectionHeading({ label, count }: { label: string | undefined; count?: number }) {
  if (!label) return null;
  return (
    <div className="mb-1 flex items-baseline gap-2 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
      <span>{label}</span>
      {count !== undefined && <span className="tabular-nums normal-case">{count}</span>}
    </div>
  );
}

const CELL = "border-b border-(--border) px-3 py-1.5 align-top";

function ExpandedRow({ row, colSpan, onJumpRun }: { row: TableRow; colSpan: number; onJumpRun?: (id: string) => void }) {
  return (
    <tr>
      {/* theme.css pins `table td` to nowrap for list tables; expanded detail is prose. */}
      <td colSpan={colSpan} className="border-b border-(--border) bg-(--surface-1) px-3 py-2 whitespace-normal">
        <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-[11.5px]">
          {row.expand.map((cell) => (
            <Fragment key={cell.key}>
              <span className="truncate text-(--text-faint)" title={cell.key}>
                {cell.key}
              </span>
              <div className="min-w-0 text-(--text-dim)">
                <Value f={cell.value} tone={cell.tone} block onJumpRun={onJumpRun} />
              </div>
            </Fragment>
          ))}
        </div>
      </td>
    </tr>
  );
}

function Rows({
  rows,
  columns,
  hasExpand,
  open,
  onToggle,
  onJumpRun,
}: {
  rows: TableRow[];
  columns: string[];
  hasExpand: boolean;
  open: Set<number>;
  onToggle: (index: number) => void;
  onJumpRun?: (id: string) => void;
}) {
  const colSpan = columns.length + (hasExpand ? 1 : 0);
  return (
    <>
      {rows.map((row) => {
        const expandable = row.expand.length > 0;
        const isOpen = open.has(row.index);
        return (
          <Fragment key={row.index}>
            <tr
              className={expandable ? "cursor-pointer hover:bg-(--surface-1)" : undefined}
              onClick={expandable ? () => onToggle(row.index) : undefined}
            >
              {hasExpand && (
                <td className={`${CELL} w-6 pr-0`}>
                  {expandable && (
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? "Collapse row" : "Expand row"}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle(row.index);
                      }}
                      className="inline-flex cursor-pointer items-center"
                    >
                      <DisclosureChevron open={isOpen} />
                    </button>
                  )}
                </td>
              )}
              {row.cells.map((cell) => (
                <td
                  key={cell.key}
                  className={`${CELL} ${wideColumn(cell) ? "min-w-[10rem] whitespace-normal [overflow-wrap:anywhere]" : "whitespace-nowrap"}`}
                >
                  <Value f={cell.value} tone={cell.tone} onJumpRun={onJumpRun} />
                </td>
              ))}
            </tr>
            {expandable && isOpen && <ExpandedRow row={row} colSpan={colSpan} onJumpRun={onJumpRun} />}
          </Fragment>
        );
      })}
    </>
  );
}

/** Prose cells (a `reason`) wrap; identifiers, chips and badges stay on one line. */
const wideColumn = (cell: Cell): boolean => cell.value.kind === "text" && !cell.value.mono && !cell.tone;

function GroupRow({
  group,
  colSpan,
  collapsed,
  onToggle,
}: {
  group: RowGroup;
  colSpan: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const hue = group.tone ? TONE_HUES[group.tone] : "var(--text-faint)";
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="flex h-7 w-full cursor-pointer items-center gap-2 border-b border-(--border) bg-(--surface-1) px-3 text-left transition-colors hover:bg-(--surface-2)"
        >
          <DisclosureChevron open={!collapsed} />
          <span
            aria-hidden
            className="size-2 rounded-full"
            style={{ background: hue, boxShadow: `0 0 0 3px color-mix(in oklch, ${hue} 18%, transparent)` }}
          />
          <span className="text-[11.5px] font-medium text-(--text)">{group.label}</span>
          <span className="tabular-nums text-[11px] text-(--text-faint)">{group.rows.length}</span>
          {collapsed && <span className="ml-auto pr-1 text-[10px] text-(--text-faint)">collapsed</span>}
        </button>
      </td>
    </tr>
  );
}

function TableSection({ s, onJumpRun }: { s: Extract<SectionModel, { as: "table" }>; onJumpRun?: (id: string) => void }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const toggleRow = (index: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const colSpan = s.columns.length + (s.hasExpand ? 1 : 0);
  return (
    <section aria-label={s.label ?? "table"} className="mb-4 last:mb-0">
      <SectionHeading label={s.label} count={s.rows.length} />
      {s.rows.length === 0 ? (
        <div className="text-[12px] text-(--text-faint)">None.</div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-(--border)">
          <table className="w-full border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-(--text-faint)">
                {s.hasExpand && <Th label="" />}
                {s.columns.map((c) => (
                  <Th key={c} label={c} />
                ))}
              </tr>
            </thead>
            <tbody>
              {s.groups
                ? s.groups.map((g) => (
                    <Fragment key={g.key}>
                      <GroupRow
                        group={g}
                        colSpan={colSpan}
                        collapsed={collapsedGroups.has(g.key)}
                        onToggle={() => toggleGroup(g.key)}
                      />
                      {!collapsedGroups.has(g.key) && (
                        <Rows
                          rows={g.rows}
                          columns={s.columns}
                          hasExpand={s.hasExpand}
                          open={open}
                          onToggle={toggleRow}
                          onJumpRun={onJumpRun}
                        />
                      )}
                    </Fragment>
                  ))
                : (
                    <Rows
                      rows={s.rows}
                      columns={s.columns}
                      hasExpand={s.hasExpand}
                      open={open}
                      onToggle={toggleRow}
                      onJumpRun={onJumpRun}
                    />
                  )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function KeyValueSection({ s, onJumpRun }: { s: Extract<SectionModel, { as: "keyvalue" }>; onJumpRun?: (id: string) => void }) {
  return (
    <section aria-label={s.label ?? "details"} className="mb-4 last:mb-0">
      <SectionHeading label={s.label} />
      <div className="text-[12px]">
        {s.entries.map((cell) => (
          <div key={cell.key} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] items-baseline gap-3 py-[3px]">
            <div className="truncate text-(--text-faint)" title={cell.key}>
              {cell.key}
            </div>
            <div className="min-w-0 text-(--text-dim)">
              <Value f={cell.value} tone={cell.tone} block onJumpRun={onJumpRun} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ListSection({ s, onJumpRun }: { s: Extract<SectionModel, { as: "list" }>; onJumpRun?: (id: string) => void }) {
  return (
    <section aria-label={s.label ?? "list"} className="mb-4 last:mb-0">
      <SectionHeading label={s.label} count={s.items.length} />
      {s.items.length === 0 ? (
        <div className="text-[12px] text-(--text-faint)">None.</div>
      ) : (
        <ul className="m-0 list-none p-0 text-[12px]">
          {s.items.map((cell) => (
            <li key={cell.key} className="flex items-baseline gap-2 py-[3px] text-(--text-dim)">
              <span aria-hidden className="text-(--text-faint)">·</span>
              <Value f={cell.value} tone={cell.tone} block onJumpRun={onJumpRun} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SectionBlock({ s, onJumpRun }: { s: SectionModel; onJumpRun?: (id: string) => void }) {
  switch (s.as) {
    case "table":
      return <TableSection s={s} onJumpRun={onJumpRun} />;
    case "keyvalue":
      return <KeyValueSection s={s} onJumpRun={onJumpRun} />;
    case "list":
      return <ListSection s={s} onJumpRun={onJumpRun} />;
    case "badge":
      return (
        <section aria-label={s.label ?? "badge"} className="mb-4 last:mb-0">
          <SectionHeading label={s.label} />
          <TonePill text={s.value} tone={s.tone ?? "neutral"} />
        </section>
      );
    case "code":
      return (
        <section aria-label={s.label ?? "code"} className="mb-4 last:mb-0">
          <SectionHeading label={s.label} />
          <pre
            data-language={s.language}
            className="mono overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-2.5 text-[11.5px] leading-relaxed whitespace-pre-wrap"
          >
            {s.text}
          </pre>
        </section>
      );
    case "prose":
      return (
        <section aria-label={s.label ?? "prose"} className="mb-4 last:mb-0">
          <SectionHeading label={s.label} />
          <p className="m-0 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-(--text-dim)">{s.text}</p>
        </section>
      );
  }
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function ArtifactView({
  artifact,
  schema,
  view,
  onJumpRun,
  actions,
}: {
  artifact: unknown;
  schema?: unknown;
  view: ArtifactViewDoc;
  /** Run chips jump here when the host has a selection callback; else they link to `#/runs/<id>`. */
  onJumpRun?: (runId: string) => void;
  /** Right-aligned header slot — the host's Raw toggle. */
  actions?: ReactNode;
}) {
  const header = useMemo(() => headerFor(view, artifact, schema), [view, artifact, schema]);
  const sections = useMemo(() => sectionsFor(view, artifact), [view, artifact]);
  const statusHues = header.status?.tone ? { [header.status.value]: TONE_HUES[header.status.tone] } : {};
  return (
    <div data-artifact-view className="text-[12px]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {header.title && <span className="font-medium text-(--text)">{header.title}</span>}
        {header.status && (
          <span title={`${header.status.label}: ${header.status.value}`}>
            <StateBadge state={header.status.value} hues={statusHues} dot={false} />
          </span>
        )}
        {actions && <span className="ml-auto">{actions}</span>}
      </div>
      {header.summary && (
        <p className="mb-3 mt-0 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-(--text-dim)">
          {header.summary}
        </p>
      )}
      {sections.map((s, i) => (
        <SectionBlock key={`${s.as}:${s.label ?? i}`} s={s} onJumpRun={onJumpRun} />
      ))}
    </div>
  );
}

/**
 * The artifact position: the view when one applies, `JsonBlock` otherwise,
 * and a View / Raw toggle whenever there is a choice. `view` is whatever the
 * `/agents` item for the run's agent carries — null/undefined keeps today's
 * JSON exactly.
 */
export function ArtifactPanel({
  artifact,
  schema,
  view,
  onJumpRun,
  raw: rawProp,
  onRawChange,
  rawFallback,
}: {
  artifact: unknown;
  schema?: unknown;
  view: ArtifactViewDoc | null | undefined;
  onJumpRun?: (runId: string) => void;
  /** Controlled Raw state (the Artifacts inspector keeps its own); uncontrolled + persisted when absent. */
  raw?: boolean;
  onRawChange?: (raw: boolean) => void;
  /** What Raw shows; defaults to `JsonBlock` over the artifact. */
  rawFallback?: ReactNode;
}) {
  const [rawState, setRawState] = useState(loadArtifactRaw);
  const raw = rawProp ?? rawState;
  const setRaw = (next: boolean) => {
    saveArtifactRaw(next);
    setRawState(next);
    onRawChange?.(next);
  };
  const applies = viewApplies(view, artifact);
  const fallback = rawFallback ?? <JsonBlock value={artifact} />;
  if (!applies) return <>{fallback}</>;
  if (raw) {
    return (
      <div>
        <div className="mb-2 flex justify-end">
          <RawToggle raw onChange={setRaw} />
        </div>
        {fallback}
      </div>
    );
  }
  return (
    <ArtifactView
      artifact={artifact}
      schema={schema}
      view={view}
      onJumpRun={onJumpRun}
      actions={<RawToggle raw={false} onChange={setRaw} />}
    />
  );
}
