import { Fragment, useMemo, useState, type ReactNode } from "react";
import { hashPath, hashProject, withProject } from "../hash";
import {
  formatValue,
  TONE_HUES,
  toneFor,
  type Formatted,
} from "../lib/artifactView";
import { resolveRefs, validatePresentation } from "../lib/presentation";
import type {
  ArtifactFormat,
  ArtifactTone,
  Presentation,
  PresentationBlock,
} from "../types";
import {
  Button as PrimitiveButton,
  JsonBlock,
  JumpLink,
  StateBadge,
  Table,
  Th,
} from "./ui";

export const PRESENTATION_RAW_KEY = "evrt-presentation-raw";

function PresentationRawToggle({
  raw,
  onChange,
}: {
  raw: boolean;
  onChange: (raw: boolean) => void;
}) {
  const option = (value: boolean, label: string) => (
    <PrimitiveButton
      bare
      type="button"
      aria-pressed={raw === value}
      onClick={() => onChange(value)}
      className={`cursor-pointer rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
        raw === value
          ? "bg-(--surface-3) text-(--text)"
          : "text-(--text-faint) hover:text-(--text-dim)"
      }`}
    >
      {label}
    </PrimitiveButton>
  );
  return (
    <span
      role="group"
      aria-label="Presentation rendering"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-(--border) bg-(--surface-1) p-0.5"
    >
      {option(false, "View")}
      {option(true, "Raw")}
    </span>
  );
}

const sourceOf = (value: unknown): string | undefined =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  typeof (value as { ref?: unknown }).ref === "string" &&
  Object.prototype.hasOwnProperty.call(value, "value")
    ? (value as { ref: string }).ref
    : undefined;
const unwrapped = (value: unknown): unknown =>
  sourceOf(value) ? (value as { value: unknown }).value : value;

function runHref(runId: string): string {
  return `#/${withProject(hashPath("runs", runId), hashProject(window.location.hash))}`;
}

function TonePill({ text, tone }: { text: string; tone: ArtifactTone }) {
  const hue = TONE_HUES[tone];
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        color: hue,
        background: `color-mix(in oklch, ${hue} 12%, transparent)`,
      }}
    >
      {text}
    </span>
  );
}

function FormattedValue({
  value,
  tone,
}: {
  value: Formatted;
  tone?: ArtifactTone;
}) {
  switch (value.kind) {
    case "empty":
      return <span className="text-(--text-faint)">—</span>;
    case "state":
      return <StateBadge state={value.state} />;
    case "link":
      return (
        <a
          href={value.href}
          target="_blank"
          rel="noreferrer"
          className="break-all text-(--accent) hover:underline"
        >
          {value.text}
        </a>
      );
    case "links":
      return (
        <ul className="m-0 list-none p-0">
          {value.items.map((item, index) => (
            <li key={`${item.text}:${index}`} className="break-all py-px">
              {item.href ? (
                <a href={item.href} className="text-(--accent) hover:underline">
                  {item.text}
                </a>
              ) : (
                <span>{item.text}</span>
              )}
            </li>
          ))}
        </ul>
      );
    case "chip": {
      const href = value.chip === "run" ? runHref(value.id) : value.href;
      if (!href) return <span className="mono">{value.text}</span>;
      return (
        <JumpLink
          href={href}
          title={`Open ${value.chip} ${value.id}`}
          className="mono text-(--accent) hover:underline"
        >
          {value.text}
        </JumpLink>
      );
    }
    case "json":
      return <JsonBlock value={value.value} />;
    case "text":
      if (tone && tone !== "muted")
        return <TonePill text={value.text} tone={tone} />;
      return (
        <span
          className={`${value.mono ? "mono" : ""} ${tone === "muted" ? "text-(--text-faint)" : ""}`}
          title={value.title}
        >
          {value.text}
        </span>
      );
  }
}

function Value({
  value,
  format,
  tone,
  github,
}: {
  value: unknown;
  format?: ArtifactFormat;
  tone?: ArtifactTone;
  github?: string | null;
}) {
  const source = sourceOf(value);
  const body = (
    <FormattedValue
      value={formatValue(unwrapped(value), format, { github })}
      tone={tone}
    />
  );
  return (
    <span
      title={source ? `Source: ${source}` : undefined}
      data-presentation-source={source}
      className="min-w-0"
      style={tone ? { color: TONE_HUES[tone] } : undefined}
    >
      {body}
    </span>
  );
}

const glyph: Record<ArtifactTone, string> = {
  ok: "✓",
  warn: "!",
  error: "×",
  muted: "·",
  neutral: "•",
};

function label(text: string | undefined, count?: number) {
  if (!text) return null;
  return (
    <div className="mb-1 flex items-baseline gap-2 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
      <span>{text}</span>
      {count !== undefined && (
        <span className="tabular-nums normal-case">{count}</span>
      )}
    </div>
  );
}

function Block({
  block,
  github,
}: {
  block: PresentationBlock;
  github?: string | null;
}) {
  switch (block.type) {
    case "heading":
      return (
        <h3 className="display m-0 text-[15px] font-semibold text-(--text)">
          {block.text}
        </h3>
      );
    case "markdown":
      return (
        <p className="m-0 text-[12.5px] leading-relaxed whitespace-pre-wrap text-(--text-dim)">
          {block.text}
        </p>
      );
    case "keyvalue":
      return (
        <div className="text-[12px]">
          {block.items.map((item, index) => (
            <div
              key={`${item.label}:${index}`}
              className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] items-baseline gap-3 py-[3px]"
            >
              <span className="truncate text-(--text-faint)" title={item.label}>
                {item.label}
              </span>
              <Value
                value={item.value}
                format={item.format}
                tone={item.tone}
                github={github}
              />
            </div>
          ))}
        </div>
      );
    case "list":
      return (
        <section aria-label={block.label ?? "list"}>
          {label(block.label, block.items.length)}
          <ul className="m-0 list-none p-0 text-[12px]">
            {block.items.map((item, index) => {
              const tone = item.tone ?? "neutral";
              return (
                <li
                  key={index}
                  title={item.ref ? `Source: ${item.ref}` : undefined}
                  className="flex gap-2 py-[3px] text-(--text-dim)"
                >
                  <span aria-hidden style={{ color: TONE_HUES[tone] }}>
                    {glyph[tone]}
                  </span>
                  <span>{item.text}</span>
                </li>
              );
            })}
          </ul>
        </section>
      );
    case "badge":
      return (
        <span
          className="inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium"
          style={{
            color: TONE_HUES[block.tone],
            background: `color-mix(in oklch, ${TONE_HUES[block.tone]} 12%, transparent)`,
          }}
        >
          {block.text}
        </span>
      );
    case "code":
      return (
        <pre
          data-language={block.language}
          className="mono m-0 overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-2.5 text-sm leading-relaxed whitespace-pre-wrap"
        >
          {block.text}
        </pre>
      );
    case "table":
      return (
        <section aria-label={block.label ?? "table"}>
          {label(block.label, block.rows.length)}
          <div className="overflow-x-auto rounded-md border border-(--border)">
            <Table className="w-full border-separate border-spacing-0">
              <thead>
                <tr className="text-left">
                  {block.columns.map((column) => (
                    <Th key={column} label={column} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => {
                      const toneMap =
                        typeof block.tone === "object" && block.tone !== null
                          ? (block.tone as Record<string, unknown>)[
                              block.columns[c]
                            ]
                          : undefined;
                      const tone =
                        typeof block.tone === "string"
                          ? block.tone
                          : toneFor(unwrapped(cell), toneMap);
                      return (
                        <td
                          key={c}
                          className="border-b border-(--border) px-3 py-1.5 align-top"
                        >
                          <Value
                            value={cell}
                            format={block.formats?.[c]}
                            tone={tone}
                            github={github}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </section>
      );
    case "section":
      return (
        <details
          className="rounded-md border border-(--border) bg-(--surface-0)"
          open={!block.collapsed}
        >
          <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-(--text)">
            {block.label}
          </summary>
          <div className="space-y-3 border-t border-(--border) px-3 py-3">
            {block.blocks.map((child, index) => (
              <Block key={index} block={child} github={github} />
            ))}
          </div>
        </details>
      );
    case "links":
      return (
        <div className="flex flex-wrap gap-1.5">
          {block.items.map((item, index) => {
            const target = (["issue", "pr", "run", "url"] as const).find(
              (key) => item[key] != null,
            );
            if (!target) return null;
            return (
              <Fragment key={`${item.label}:${index}`}>
                <span className="inline-flex items-center gap-1 rounded border border-(--border) bg-(--surface-1) px-1.5 py-0.5 text-[11px]">
                  <span className="text-(--text-faint)">{item.label}</span>
                  <Value value={item[target]} format={target} github={github} />
                </span>
              </Fragment>
            );
          })}
        </div>
      );
  }
}

export function BlockRenderer({
  presentation,
  artifact,
  actions,
}: {
  presentation: Presentation;
  artifact: unknown;
  actions?: ReactNode;
}) {
  const resolved = useMemo(
    () => resolveRefs(presentation, artifact),
    [presentation, artifact],
  );
  const github =
    artifact !== null &&
    typeof artifact === "object" &&
    !Array.isArray(artifact)
      ? String((artifact as Record<string, unknown>).github ?? "") || null
      : null;
  return (
    <div data-presentation-view className="space-y-3 text-[12px]">
      {actions && <div className="flex justify-end">{actions}</div>}
      {resolved.blocks.map((block, index) => (
        <Block key={`${block.type}:${index}`} block={block} github={github} />
      ))}
    </div>
  );
}

function loadRaw(): boolean {
  try {
    return localStorage.getItem(PRESENTATION_RAW_KEY) === "1";
  } catch {
    return false;
  }
}

export function PresentationPanel({
  presentation,
  artifact,
}: {
  presentation: Presentation;
  artifact: unknown;
}) {
  const [raw, setRawState] = useState(loadRaw);
  const validation = useMemo(
    () => validatePresentation(presentation, artifact),
    [presentation, artifact],
  );
  const setRaw = (next: boolean) => {
    setRawState(next);
    try {
      localStorage.setItem(PRESENTATION_RAW_KEY, next ? "1" : "0");
    } catch {
      /* local preference is best effort */
    }
  };
  if (!validation.valid)
    return (
      <div
        role="status"
        className="rounded-md border border-(--border) bg-(--surface-0) px-3 py-2 text-[12px] text-(--hue-warn)"
      >
        <div>
          the agent&apos;s summary was dropped: {validation.errors.length}{" "}
          errors
        </div>
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-(--text-dim)">
            presentation errors
          </summary>
          <ul className="mono m-0 list-disc space-y-1 pl-5 text-[11px] text-(--text-dim)">
            {validation.errors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </details>
      </div>
    );
  if (raw)
    return (
      <div>
        <div className="mb-2 flex justify-end">
          <PresentationRawToggle raw onChange={setRaw} />
        </div>
        <JsonBlock value={presentation} />
      </div>
    );
  return (
    <BlockRenderer
      presentation={presentation}
      artifact={artifact}
      actions={<PresentationRawToggle raw={false} onChange={setRaw} />}
    />
  );
}
