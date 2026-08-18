import {
  createContext,
  forwardRef,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { attrIcon } from "./attrIcons";
import { createPortal } from "react-dom";
import { ChevronRightIcon } from "@radix-ui/react-icons";
import { modal, useFocusReturn, useNow } from "../hooks";
import type { Section, SortDir } from "../displayOptions";
import { tokenizeJson, TOKEN_CLASSES } from "../highlight";
import { flushHash } from "../hash";
import {
  type FilterChipToken,
  type FilterFacets,
  type FilterQuery,
  type FilterSuggestion,
  chipHelp,
  chipLabel,
  filterHint,
  getActiveFilterToken,
  getFilterSuggestions,
  removeFilterToken,
} from "../filterQuery";

/** One fixed hue map for the closed §8 lifecycle — identical in every view. */
export const STATE_HUES: Record<string, string> = {
  PROPOSED: "var(--hue-idle)",
  APPROVED: "var(--hue-info)",
  QUEUED: "var(--hue-info)",
  LEASED: "var(--hue-warn)",
  RUNNING: "var(--hue-warn)",
  VERIFYING: "var(--hue-verify)",
  COMPLETED: "var(--hue-ok)",
  REFUSED: "var(--hue-warn)",
  FAILED: "var(--hue-err)",
  TIMED_OUT: "var(--hue-err)",
  CANCELLED: "var(--hue-idle)",
};

/** One hue map for the §5 event-inbox statuses — identical in every view. */
export const EVENT_STATUS_HUES: Record<string, string> = {
  admitted: "var(--hue-info)",
  planned: "var(--hue-ok)",
  noop: "var(--hue-idle)",
  human_needed: "var(--hue-warn)",
  dead_lettered: "var(--hue-err)",
};

/** One hue map for decided-proposal statuses — identical in list and panel. */
export const PROPOSAL_STATUS_HUES: Record<string, string> = {
  open: "var(--hue-info)",
  approved: "var(--hue-ok)",
  rejected: "var(--hue-err)",
  superseded: "var(--hue-idle)",
  resolved: "var(--hue-idle)",
};

export const DECISION_HUES: Record<string, string> = {
  run: "var(--hue-info)",
  human_needed: "var(--hue-warn)",
  noop: "var(--hue-idle)",
};

/** Four mutually exclusive worker health tokens (webui spec §5.2 + §10.9). */
export const WORKER_HUES: Record<string, string> = {
  idle: "var(--hue-ok)",
  busy: "var(--hue-warn)",
  stopped: "var(--hue-idle)",
  stale: "var(--hue-err)",
};

/**
 * Returns the matching theme hue for a facet value (states, statuses, decisions).
 */
export const getValueHue = (
  _field: string,
  value: string,
): string | undefined => {
  const norm = value.trim();
  return (
    STATE_HUES[norm.toUpperCase()] ??
    EVENT_STATUS_HUES[norm.toLowerCase()] ??
    PROPOSAL_STATUS_HUES[norm.toLowerCase()] ??
    DECISION_HUES[norm.toLowerCase()]
  );
};

/**
 * Short display form of a prefixed id: `run_ec9c87f9-…` → `run_ec9c87f9`
 * (WM-96). Keeps the type prefix up to the first `_` plus the first 8
 * characters of the body — enough to tell runs apart at a glance. Ids without
 * a prefix, or already at most 8 characters past it, come back unchanged, so
 * short human-written ids never lose information. Callers must carry the full
 * id in a `title` (and keep copy/open verbs on the full id).
 */
export function shortId(id: string): string {
  const sep = id.indexOf("_");
  if (sep === -1) return id;
  const body = id.slice(sep + 1);
  return body.length <= 8 ? id : id.slice(0, sep + 1) + body.slice(0, 8);
}

/**
 * A model id that keeps its distinguishing name visible in narrow columns.
 * The provider prefix is allowed to shrink away first; the full id remains in
 * the tooltip. Sentinel values such as `n/a` and `-` render unchanged.
 */
export function ModelCell({
  model,
  className = "",
  title = model,
}: {
  model: string;
  className?: string;
  title?: string;
}) {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return (
      <span
        className={`mono block max-w-full truncate ${className}`}
        title={title}
      >
        {model}
      </span>
    );
  }

  const provider = model.slice(0, slash + 1);
  const name = model.slice(slash + 1);
  return (
    <span
      className={`mono block min-w-0 max-w-full ${className}`}
      title={title}
    >
      <span className="sr-only">{model}</span>
      <span
        aria-hidden="true"
        className="flex min-w-0 max-w-full items-baseline"
      >
        <span className="min-w-0 truncate text-(--text-faint)">{provider}</span>
        <span className="max-w-full shrink-0 truncate">{name}</span>
      </span>
    </span>
  );
}

export function copyText(text: string, label: string) {
  navigator.clipboard.writeText(text);
  notify(`Copied ${label}`, "info");
}

/** Shareable hash of the current selection — the payoff of hash-as-source-of-truth. */
export function copyLink() {
  flushHash();
  copyText(window.location.href, "link");
}

type CopyActionButtonProps = {
  label: string;
  chord: string;
  onClick: () => void;
  quiet?: boolean;
  children: ReactNode;
};

function CopyActionButton({
  label,
  chord,
  onClick,
  quiet = false,
  children,
}: CopyActionButtonProps) {
  if (!quiet) {
    return (
      <IconButton
        aria-label={`${label} (${chord})`}
        tooltip={`${label} · ${chord}`}
        onClick={onClick}
      >
        {children}
      </IconButton>
    );
  }
  return (
    <Button
      bare
      type="button"
      title={`${label} · ${chord}`}
      aria-label={`${label} (${chord})`}
      onClick={onClick}
      className={
        quiet
          ? "mono cursor-pointer rounded-sm text-(--text-faint) transition-colors hover:text-(--text) focus-visible:text-(--text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
          : "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-(--text-faint) transition-colors hover:text-(--text) focus-visible:text-(--text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-1 focus-visible:ring-offset-(--surface-1)"
      }
    >
      {children}
    </Button>
  );
}

/** Compact, accessible copy/share actions shared by every detail surface. */
export function CopyActions({
  id,
  idLabel,
  idChord = "c",
  cli,
  cliLabel = "CLI command",
  variant = "icons",
}: {
  id: string;
  idLabel: string;
  idChord?: string;
  cli?: string;
  cliLabel?: string;
  /** Quiet text links suit the utility row below a detail header; icons remain
   *  the compact default for inline use on other surfaces. */
  variant?: "icons" | "quiet";
}) {
  if (variant === "quiet") {
    return (
      <div
        className="inline-flex items-center gap-1.5"
        role="group"
        aria-label="Copy actions"
      >
        <span>copy:</span>
        <CopyActionButton
          label={`Copy ${idLabel}`}
          chord={idChord}
          onClick={() => copyText(id, idLabel)}
          quiet
        >
          id
        </CopyActionButton>
        <span aria-hidden="true">·</span>
        {cli !== undefined && (
          <>
            <CopyActionButton
              label={`Copy ${cliLabel}`}
              chord="c i"
              onClick={() => copyText(cli, cliLabel)}
              quiet
            >
              CLI
            </CopyActionButton>
            <span aria-hidden="true">·</span>
          </>
        )}
        <CopyActionButton
          label="Copy link"
          chord="c l"
          onClick={copyLink}
          quiet
        >
          link
        </CopyActionButton>
      </div>
    );
  }

  return (
    <div
      className="inline-flex items-center gap-1"
      role="group"
      aria-label="Copy actions"
    >
      <CopyActionButton
        label={`Copy ${idLabel}`}
        chord={idChord}
        onClick={() => copyText(id, idLabel)}
      >
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
          className="size-3.5"
        >
          <path d="M5 2.5 4 11.5M10 2.5 9 11.5M2.5 5.5h9M2 8.5h9" />
        </svg>
      </CopyActionButton>
      {cli !== undefined && (
        <CopyActionButton
          label={`Copy ${cliLabel}`}
          chord="c i"
          onClick={() => copyText(cli, cliLabel)}
        >
          <svg
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="size-3.5"
          >
            <polyline points="2.5,3.5 5.5,6.5 2.5,9.5" />
            <line x1="7" y1="10" x2="11.5" y2="10" />
          </svg>
        </CopyActionButton>
      )}
      <CopyActionButton label="Copy link" chord="c l" onClick={copyLink}>
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="size-3.5"
        >
          <path d="M5.2 9.8 4 11a2.1 2.1 0 0 1-3-3l2.1-2.1a2.1 2.1 0 0 1 3-.1" />
          <path d="m8.8 4.2 1.2-1.2a2.1 2.1 0 1 1 3 3l-2.1 2.1a2.1 2.1 0 0 1-3 .1" />
          <line x1="5" y1="9" x2="9" y2="5" />
        </svg>
      </CopyActionButton>
    </div>
  );
}

/**
 * One active token, as a dismissible chip (UX doc Proposal 4). The whole chip
 * is the remove target: a token is one word in the query box, so there is
 * nothing else to click it for, and one tab stop per token keeps the bar
 * traversable when a query has four of them.
 */
function FilterToken({
  token,
  query,
  onRemove,
}: {
  token: FilterChipToken;
  query: FilterQuery;
  onRemove: () => void;
}) {
  const label = chipLabel(token);
  const help = chipHelp(token, query);
  return (
    <Button
      bare
      type="button"
      onClick={onRemove}
      title={help}
      aria-label={`Remove ${label}. ${help}`}
      className={`group inline-flex cursor-pointer items-center gap-1 rounded-md border bg-(--surface-2) px-1.5 py-0.5 text-[11px] hover:bg-(--surface-3) ${
        token.supported
          ? "border-(--border) hover:border-(--border-strong)"
          : "border-dashed text-(--hue-warn)"
      }`}
    >
      <span className={`mono ${token.supported ? "" : "line-through"}`}>
        {label}
      </span>
      <span
        aria-hidden
        className="text-(--text-faint) group-hover:text-(--text)"
      >
        ×
      </span>
    </Button>
  );
}

/**
 * The list filter box with facet autocomplete dropdown. Pass `query` or `facets`
 * to get keyed syntax autocompletion and chip management.
 */
export function FilterInput<T = unknown, C = unknown>({
  value,
  onChange,
  placeholder,
  label,
  query,
  facets,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  query?: FilterQuery;
  facets?: FilterFacets<T, C>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const hintId = useId();
  const listboxId = useId();
  const [hint, setHint] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const chips = query?.chips ?? [];
  const hintText = query ? filterHint(query) : "";

  const safeCursor = Math.min(cursorPos, value.length);
  const activeToken = useMemo(() => {
    return getActiveFilterToken(value, safeCursor);
  }, [value, safeCursor]);

  const suggestions = useMemo(() => {
    if (!facets && !query) return [];
    return getFilterSuggestions(activeToken.raw, facets, query, getValueHue);
  }, [activeToken.raw, facets, query]);

  const showPopover =
    isFocused &&
    !isDismissed &&
    (facets != null || query != null) &&
    suggestions.length > 0;

  useEffect(() => {
    setSelectedIndex(0);
  }, [suggestions]);

  useEffect(() => {
    if (showPopover && listRef.current) {
      const activeEl = listRef.current.querySelector<HTMLElement>(
        `[aria-selected="true"]`,
      );
      activeEl?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, showPopover]);

  const updateCursor = () => {
    if (inputRef.current) {
      setCursorPos(inputRef.current.selectionStart ?? 0);
    }
  };

  const applySuggestion = (s: FilterSuggestion) => {
    const token = getActiveFilterToken(value, safeCursor);
    const before = value.slice(0, token.start);
    const after = value.slice(token.end);
    const nextValue = before + s.insertText + after;
    const nextCursor = token.start + s.insertText.length;
    onChange(nextValue);
    setCursorPos(nextCursor);
    setIsDismissed(false);
    setSelectedIndex(0);
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(nextCursor, nextCursor);
      }
    });
  };

  // Dismissal rewrites the query text, so focus returns to the box: the next
  // keystroke — or Esc — lands where the operator thinks it is.
  const rewrite = (next: string) => {
    onChange(next);
    inputRef.current?.focus();
  };

  return (
    <>
      <span className="relative inline-flex w-56 shrink-0">
        <input
          ref={inputRef}
          data-view-filter
          role="combobox"
          aria-expanded={showPopover}
          aria-autocomplete="list"
          aria-controls={showPopover ? listboxId : undefined}
          aria-activedescendant={
            showPopover && suggestions[selectedIndex]
              ? `${listboxId}-opt-${selectedIndex}`
              : undefined
          }
          aria-describedby={query ? hintId : undefined}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCursorPos(e.target.selectionStart ?? 0);
            setIsDismissed(false);
          }}
          onFocus={(e) => {
            setIsFocused(true);
            setHint(true);
            setCursorPos(e.target.selectionStart ?? 0);
            setIsDismissed(false);
          }}
          onBlur={() => {
            setIsFocused(false);
            setHint(false);
          }}
          onClick={updateCursor}
          onKeyUp={updateCursor}
          onSelect={updateCursor}
          onKeyDown={(e) => {
            if (showPopover) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex((prev) => (prev + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex(
                  (prev) =>
                    (prev - 1 + suggestions.length) % suggestions.length,
                );
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                if (suggestions[selectedIndex]) {
                  e.preventDefault();
                  e.stopPropagation();
                  applySuggestion(suggestions[selectedIndex]);
                  return;
                }
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setIsDismissed(true);
                return;
              }
            } else if (
              e.key === "ArrowDown" &&
              suggestions.length > 0 &&
              isDismissed
            ) {
              e.preventDefault();
              setIsDismissed(false);
              return;
            }

            if (e.key === "Escape") {
              e.preventDefault();
              if (value) onChange("");
              else e.currentTarget.blur();
            }
          }}
          placeholder={placeholder}
          aria-label={label}
          className="w-full rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-1 pr-7 text-[12px] text-(--text) outline-none placeholder:text-(--text-faint) focus:border-(--accent)"
        />
        {!value && (
          <kbd
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border border-(--border) px-1 font-sans text-xs text-(--text-faint)"
          >
            /
          </kbd>
        )}
        {showPopover && (
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Filter suggestions"
            className="absolute top-full left-0 z-30 mt-1 max-h-60 w-64 overflow-auto rounded-md border border-(--border-strong) bg-(--surface-1) p-1 text-[12px] shadow-xl outline-none"
          >
            {suggestions.map((s, idx) => (
              <li
                key={s.id}
                id={`${listboxId}-opt-${idx}`}
                role="option"
                aria-selected={idx === selectedIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySuggestion(s);
                }}
                className={`flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 select-none ${
                  idx === selectedIndex
                    ? "bg-(--surface-3) text-(--text)"
                    : "text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  {s.hue && (
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: s.hue }}
                    />
                  )}
                  <span
                    className={`mono truncate ${
                      s.kind === "facet" ? "font-semibold text-(--accent)" : ""
                    }`}
                  >
                    {s.label}
                  </span>
                </span>
                <span className="mono shrink-0 truncate text-xs text-(--text-faint)">
                  {s.kind === "facet" ? "facet" : s.field || s.description}
                </span>
              </li>
            ))}
          </ul>
        )}
        {query && (
          <span
            id={hintId}
            className={
              hint && !value && !showPopover
                ? "absolute top-full right-0 z-20 mt-1 w-72 rounded-md border border-(--border-strong) bg-(--surface-2) px-2 py-1 text-[11px] text-(--text-faint)"
                : "sr-only"
            }
          >
            {hintText}
          </span>
        )}
      </span>
      {query && chips.length > 0 && (
        <div
          role="group"
          aria-label={`${label} tokens`}
          // A focused chip is a button, and `keyGuard` (hooks.ts) only stands
          // the global list verbs down inside a text field — so Enter here
          // would open the selected row instead of dismissing the chip, and `x`
          // would open a cancel dialog. Contain those. Esc is the one list
          // verb that belongs here too, but list Esc deselects first: from
          // the chip bar it must clear the query, same as from the box.
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              rewrite("");
              return;
            }
            e.stopPropagation();
          }}
          className="flex basis-full flex-wrap items-center gap-1.5"
        >
          {chips.map((token) => (
            <FilterToken
              key={`${token.start}-${token.raw}`}
              token={token}
              query={query}
              onRemove={() => rewrite(removeFilterToken(value, token))}
            />
          ))}
          <Button
            bare
            type="button"
            onClick={() => rewrite("")}
            title="Clear query (Esc)"
            aria-label="Clear query"
            className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-(--text-faint) hover:bg-(--surface-1) hover:text-(--text)"
          >
            clear
          </Button>
        </div>
      )}
    </>
  );
}

/** Pinned title/tabs/filter; only the table (and anything below it) scrolls. */
export function ListPane({
  chrome,
  children,
}: {
  chrome: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pt-5 pb-3">{chrome}</div>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">{children}</div>
    </div>
  );
}

/**
 * Shared detail-pane chrome: identity and Close, then verbs, then copy/share.
 * Keeping these rows here prevents each view from inventing its own spacing or
 * moving a primary action above the selected record's identity (WM-552).
 */
export function PaneHeader({
  title,
  actions,
  utility,
  close,
}: {
  title: ReactNode;
  actions?: ReactNode;
  utility?: ReactNode;
  /** Escape hatch pinned at the top-right, outside the wrapping action row,
   *  so it stays visible and clickable no matter how many actions the view
   *  stacks up or how narrow the panel gets (WM-97). */
  close?: ReactNode;
}) {
  return (
    <div className="shrink-0 border-b border-(--border) px-4 py-3">
      {/* Row 1: Title & Close */}
      <div className="flex items-center justify-between gap-2">
        <div className="display min-w-0 flex-1 truncate text-[14px] font-semibold">
          {title}
        </div>
        {close != null && <div className="shrink-0">{close}</div>}
      </div>
      {/* Row 2: Verb Row (≤ 3 bordered buttons) */}
      {actions != null && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5">
          {actions}
        </div>
      )}
      {/* Row 3: Utility Row (copy/share quiet text line) */}
      {utility != null && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-(--text-faint)">
          {utility}
        </div>
      )}
    </div>
  );
}

/** The shared data-table type contract: caption headers, body copy, mono data. */
export function Table({ className = "", ...props }: ComponentProps<"table">) {
  return (
    <table
      {...props}
      className={`text-sm [&_thead]:text-xs [&_thead]:uppercase [&_thead]:text-(--text-faint) [&_td.mono]:text-sm ${className}`}
    />
  );
}

/** Pinned title, verb, and utility rows; the spec and payload scroll underneath (WM-209). */
export function DetailPane({
  widthClass,
  title,
  actions,
  utility,
  close,
  children,
}: {
  widthClass: string;
  title: ReactNode;
  actions?: ReactNode;
  utility?: ReactNode;
  close?: ReactNode;
  children: ReactNode;
}) {
  return (
    <aside
      className={`${widthClass} flex min-h-0 shrink-0 flex-col border-l border-(--border) bg-(--surface-1)`}
    >
      <PaneHeader
        title={title}
        actions={actions}
        utility={utility}
        close={close}
      />
      <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
    </aside>
  );
}

export const ESC_CLEARS_FILTER = "Esc clears the filter";

/** Previous/next controls for a 100-row table window. */
export function TableWindowFooter({
  colSpan,
  range,
  move,
}: {
  colSpan: number;
  range: readonly [number, number, number];
  move: (direction: number) => void;
}) {
  const [start, end, total] = range;
  if (total <= 100) return null;
  return (
    <tr>
      <td
        colSpan={colSpan}
        onKeyDown={(e) =>
          (e.key === "Enter" || e.key === " ") && e.stopPropagation()
        }
        align="right"
      >
        {start + 1}–{end}/{total}{" "}
        <Button disabled={!start} onClick={() => move(-1)}>
          Prev
        </Button>{" "}
        <Button disabled={end === total} onClick={() => move(1)}>
          Next
        </Button>
      </td>
    </tr>
  );
}

/** Empty / loading / error row for the dense lists. Never say "none" while pending. */
export function ListEmpty({
  colSpan,
  query,
  filtered,
  noun,
  empty,
  action,
  onClear,
  escHint,
}: {
  colSpan: number;
  query: { isPending: boolean; isError: boolean; data?: unknown };
  filtered?: boolean;
  noun: string;
  empty: string;
  action?: ReactNode;
  onClear?: () => void;
  escHint?: boolean;
}) {
  let msg = empty;
  if (query.isPending && !query.data) msg = `Loading ${noun}…`;
  else if (query.isError && !query.data) {
    msg = `Cannot reach the control API — ${noun} will appear when it is up.`;
  } else if (filtered) msg = `No ${noun} match this filter.`;
  const showEscHint =
    (filtered || escHint) && !query.isPending && !query.isError;
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-3 py-8 text-center text-(--text-faint)"
      >
        <div>{msg}</div>
        {showEscHint && (
          <div className="mt-2 text-[11px]">{ESC_CLEARS_FILTER}</div>
        )}
        {onClear && filtered && !query.isPending && !query.isError && (
          <div className="mt-3">
            <Button
              size="sm"
              variant="ghost"
              className="bg-(--surface-3) text-(--text)"
              onClick={onClear}
            >
              Clear filter
            </Button>
          </div>
        )}
        {action && !query.isPending && !query.isError && !filtered && (
          <div className="mt-3">{action}</div>
        )}
      </td>
    </tr>
  );
}

/**
 * One sticky header cell (OPS-493). All wired views share this so the group
 * header rows below can pin at exactly `top-7` — the cell is a fixed h-7 and
 * the hairline is a shadow, not a border, so the offset never drifts by 1px.
 * With `onSort` the label is a button cycling natural → reversed → API order.
 */
export function Th({
  label,
  align,
  title,
  dir,
  naturalDir,
  onSort,
  onRemove,
}: {
  label: string;
  align?: "right";
  title?: string;
  dir?: SortDir | null;
  /** What the first click will do — the hover hint must not promise "↑" on a newest-first column. */
  naturalDir?: SortDir;
  onSort?: () => void;
  onRemove?: () => void;
}) {
  const alignCls = align === "right" ? "text-right" : "text-left";
  const base = `sticky top-0 z-10 h-7 bg-(--surface-0) px-3 font-medium whitespace-nowrap shadow-[inset_0_-1px_0_var(--border)] ${alignCls}`;
  if (!onSort && !onRemove)
    return (
      <th className={base} title={title}>
        {label}
      </th>
    );
  return (
    <th
      aria-sort={
        dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"
      }
      className={`${base} p-0`}
    >
      <div
        className={`group/th flex h-7 w-full items-center justify-between gap-1 px-3 ${align === "right" ? "justify-end" : ""}`}
      >
        {onSort ? (
          <Button
            bare
            type="button"
            onClick={onSort}
            onKeyDown={(e) =>
              (e.key === "Enter" || e.key === " ") && e.stopPropagation()
            }
            title={title ?? `Sort by ${label.toLowerCase()}`}
            className={`inline-flex h-7 items-center gap-1 cursor-pointer font-medium transition-colors hover:text-(--text) ${dir ? "text-(--text)" : ""}`}
          >
            {label}
            <span
              aria-hidden
              className={`text-xs transition-opacity ${dir ? "opacity-100" : "opacity-0 group-hover/th:opacity-50"}`}
            >
              {(dir ?? naturalDir ?? "asc") === "desc" ? "↓" : "↑"}
            </span>
          </Button>
        ) : (
          <span>{label}</span>
        )}
        {onRemove && (
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            aria-label={`Remove column ${label}`}
            className="ml-1 text-[11px] text-(--text-faint) opacity-0 transition-opacity group-hover/th:opacity-100"
          >
            ×
          </IconButton>
        )}
      </div>
    </th>
  );
}

/** One disclosure marker everywhere: Radix weight, aligned box, 150ms rotation. */
export function DisclosureChevron({
  open,
  className = "",
}: {
  open: boolean;
  className?: string;
}) {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={`size-3 shrink-0 text-(--text-faint) transition-transform duration-150 ${open ? "rotate-90" : ""} ${className}`}
    />
  );
}

/**
 * A Linear-style section header row: chevron, state dot, label, count. The
 * whole band is one button (Enter/Space toggle for free, `aria-expanded` for
 * screen readers); it pins just under the `Th` row while its section scrolls.
 * Sub-group headers indent and give up stickiness — two pinned tiers fight.
 */
export function GroupHeaderRow({
  colSpan,
  section,
  collapsed,
  onToggle,
  sub,
}: {
  colSpan: number;
  section: Section<unknown>;
  collapsed: boolean;
  onToggle: () => void;
  sub?: boolean;
}) {
  const hue = section.hue ?? "var(--text-faint)";
  return (
    <tr>
      <td
        colSpan={colSpan}
        className={`p-0 ${sub ? "" : "sticky top-7 z-[5]"}`}
      >
        <Button
          bare
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
          onKeyDown={(e) =>
            (e.key === "Enter" || e.key === " ") && e.stopPropagation()
          }
          className={`flex w-full cursor-pointer items-center gap-2 border-b border-(--border) bg-(--surface-1) px-3 text-left transition-colors hover:bg-(--surface-2) ${
            sub ? "h-7 pl-8" : "h-8"
          }`}
        >
          <DisclosureChevron open={!collapsed} />
          {!sub && (
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{
                background: hue,
                boxShadow: `0 0 0 3px color-mix(in oklch, ${hue} 18%, transparent)`,
              }}
            />
          )}
          <span
            className={`font-medium ${sub ? "text-sm text-(--text-dim)" : "text-sm text-(--text)"}`}
          >
            {section.label}
          </span>
          <span className="tabular-nums text-[11px] text-(--text-faint)">
            {section.count}
          </span>
          {collapsed && section.count > 0 && (
            <span className="ml-auto pr-1 text-xs text-(--text-faint)">
              collapsed
            </span>
          )}
        </Button>
      </td>
    </tr>
  );
}

/**
 * 14px viewBox, 1.5px stroke state icons per OPS-498 / §5.2.
 * Shape is redundancy for color-blind and peripheral reading.
 */
export function StateIcon({
  state,
  className = "size-3.5 shrink-0",
}: {
  state: string;
  className?: string;
}) {
  const norm = state.toLowerCase();
  switch (norm) {
    case "admitted":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="currentColor"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="3" />
        </svg>
      );
    case "planned":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={className}
          aria-hidden="true"
        >
          <polygon
            points="5,3.5 10.5,7 5,10.5"
            fill="currentColor"
            fillOpacity="0.2"
          />
        </svg>
      );
    case "noop":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={className}
          aria-hidden="true"
        >
          <line x1="4" y1="7" x2="10" y2="7" />
        </svg>
      );
    case "human_needed":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-hidden="true"
        >
          <path
            d="M7 2.5 L12 11.5 L2 11.5 Z"
            fill="currentColor"
            fillOpacity="0.18"
          />
          <line x1="7" y1="5.5" x2="7" y2="8" />
          <circle cx="7" cy="9.8" r="0.5" fill="currentColor" />
        </svg>
      );
    case "dead_lettered":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" />
          <line x1="3.8" y1="10.2" x2="10.2" y2="3.8" />
        </svg>
      );
    case "queued":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 2"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" />
        </svg>
      );
    case "leased":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" />
          <circle cx="7" cy="7" r="1.8" fill="currentColor" />
        </svg>
      );
    case "running":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M7 2.5 A4.5 4.5 0 0 1 7 11.5 Z" fill="currentColor" />
        </svg>
      );
    case "verifying":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={className}
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="3.5" />
          <line x1="8.5" y1="8.5" x2="11.5" y2="11.5" />
        </svg>
      );
    case "completed":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r="4.5"
            fill="currentColor"
            fillOpacity="0.18"
          />
          <polyline points="4.8,7.2 6.3,8.7 9.3,5.3" />
        </svg>
      );
    case "failed":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={className}
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r="4.5"
            fill="currentColor"
            fillOpacity="0.18"
          />
          <line x1="5" y1="5" x2="9" y2="9" />
          <line x1="9" y1="5" x2="5" y2="9" />
        </svg>
      );
    case "timed_out":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" />
          <polyline points="7,4.5 7,7 9,7" />
        </svg>
      );
    case "cancelled":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" />
          <line x1="4" y1="7" x2="10" y2="7" />
        </svg>
      );
    case "refused":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" />
          <line x1="10" y1="4" x2="4" y2="10" />
        </svg>
      );
    case "open":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" strokeDasharray="3 2" />
        </svg>
      );
    case "expired":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={className}
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r="4.5"
            fill="currentColor"
            fillOpacity="0.18"
          />
          <line x1="7" y1="4" x2="7" y2="7.5" />
          <circle cx="7" cy="9.5" r="0.5" fill="currentColor" />
        </svg>
      );
    case "live":
    case "idle":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="currentColor"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="3.5" />
        </svg>
      );
    case "busy":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M7 2.5 A4.5 4.5 0 0 1 7 11.5 Z" fill="currentColor" />
        </svg>
      );
    case "stale":
      return (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={className}
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r="4.5"
            fill="currentColor"
            fillOpacity="0.18"
          />
          <line x1="7" y1="4" x2="7" y2="7.5" />
          <circle cx="7" cy="9.5" r="0.5" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg
          viewBox="0 0 14 14"
          fill="currentColor"
          className={className}
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="2.5" />
        </svg>
      );
  }
}

export function StateBadge({
  state,
  hues = STATE_HUES,
  dot = true,
}: {
  state: string;
  hues?: Record<string, string>;
  /** Off wherever the caller already draws its own dot for this state (the
   *  Lifecycle timeline's rail beads) — two dots for one state read as a
   *  mistake, not emphasis (WM-136). */
  dot?: boolean;
}) {
  const hue = hues[state] ?? "var(--hue-idle)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        color: hue,
        background: `color-mix(in oklch, ${hue} 12%, transparent)`,
      }}
    >
      {dot && <StateIcon state={state} className="size-3 shrink-0" />}
      {state}
    </span>
  );
}

export function StatCard({
  label,
  value,
  suffix,
  caption,
  hue,
  compact = false,
}: {
  label: string;
  value: ReactNode;
  suffix?: ReactNode;
  caption?: ReactNode;
  hue?: string;
  compact?: boolean;
}) {
  return (
    <div
      data-stat-card
      className={`${compact ? "min-w-0 rounded-md px-3 py-2" : "min-w-36 rounded-lg px-3.5 py-3"} border border-(--border) bg-(--surface-1)`}
    >
      <div className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
        {label}
      </div>
      <div
        className={`display font-semibold tabular-nums ${compact ? "mt-0.5 text-h1" : "mt-1 text-h1"}`}
      >
        <span data-stat-value style={hue ? { color: hue } : undefined}>
          {value}
        </span>
        {suffix}
      </div>
      {caption != null && (
        <div className="mt-0.5 text-xs text-(--text-faint)">{caption}</div>
      )}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hue,
  onClick,
}: {
  label: string;
  value: ReactNode;
  hue?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className="text-[11px] text-(--text-faint)">{label}</div>
      <div
        className="display text-h1 tabular-nums"
        style={hue ? { color: hue } : undefined}
      >
        {value}
      </div>
    </>
  );
  const cls =
    "rounded-md border border-(--border) bg-(--surface-1) px-3 py-2 text-left";
  if (!onClick) return <div className={cls}>{inner}</div>;
  return (
    <Button
      bare
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${value}`}
      className={`${cls} cursor-pointer hover:bg-(--surface-2)`}
    >
      {inner}
    </Button>
  );
}

/** In-table / KV jump that does not select the parent row. */
export function JumpLink({
  children,
  onClick,
  href,
  title,
  className,
}: {
  children: ReactNode;
  onClick?: (e?: React.MouseEvent) => void;
  href?: string;
  title?: string;
  className?: string;
}) {
  const cls = `mono cursor-pointer text-left hover:text-(--accent) ${className ?? ""}`;
  if (href != null) {
    return (
      <a
        href={href}
        className={cls}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          onClick?.(e);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <Button
      bare
      type="button"
      className={cls}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
    >
      {children}
    </Button>
  );
}

/**
 * Live countdown to `createdAt + ttlSeconds`. Always carries a unit/qualifier
 * so it can't be misread as a wall-clock time, and exposes the absolute
 * expiry as a `title` tooltip. Once past expiry it switches to relative age
 * ("expired 2h ago") instead of a bare "expired" — callers that already show
 * an expired badge elsewhere (e.g. the Proposals Decision column) should not
 * also repeat the word "expired" next to this.
 */
export function Countdown({
  createdAt,
  ttlSeconds,
}: {
  createdAt: string;
  ttlSeconds: number;
}) {
  const now = useNow();
  const expiryMs = new Date(createdAt).getTime() + ttlSeconds * 1000;
  const expiryIso = new Date(expiryMs).toISOString();
  const left = Math.floor((expiryMs - now) / 1000);
  if (left <= 0) {
    return (
      <span
        className="tabular-nums"
        style={{ color: "var(--hue-err)" }}
        title={expiryIso}
      >
        expired {ago(expiryIso, now)}
      </span>
    );
  }
  const m = Math.floor(left / 60);
  const s = left % 60;
  const low = left < 300;
  return (
    <span
      className="tabular-nums"
      style={low ? { color: "var(--hue-warn)" } : undefined}
      title={expiryIso}
    >
      {m}:{String(s).padStart(2, "0")} left
    </span>
  );
}

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Relative time with the absolute ISO on hover — operators check both. */
export function Ago({
  iso,
  now,
  className,
}: {
  iso: string | null | undefined;
  now: number;
  className?: string;
}) {
  if (!iso) return <span className={className}>-</span>;
  return (
    <span className={className} title={iso}>
      {ago(iso, now)}
    </span>
  );
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ToastMessage {
  id: string;
  type: "ok" | "err" | "info";
  message: string;
}

const toastListeners = new Set<(toasts: ToastMessage[]) => void>();
let activeToasts: ToastMessage[] = [];

export function notify(message: string, type: "ok" | "err" | "info" = "ok") {
  const id = Math.random().toString(36).slice(2);
  activeToasts = [...activeToasts, { id, type, message }].slice(-5);
  toastListeners.forEach((l) => l(activeToasts));
  setTimeout(() => dismissToast(id), 3000);
}

function dismissToast(id: string) {
  const next = activeToasts.filter((t) => t.id !== id);
  if (next.length === activeToasts.length) return;
  activeToasts = next;
  toastListeners.forEach((l) => l(activeToasts));
}

export function clearToasts() {
  activeToasts = [];
  toastListeners.forEach((l) => l(activeToasts));
}

/**
 * Both regions stay mounted even while empty: a screen reader only announces
 * nodes inserted into a live region that already existed, so mounting the
 * region together with its first toast would swallow that toast.
 */
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  useEffect(() => {
    toastListeners.add(setToasts);
    return () => {
      toastListeners.delete(setToasts);
    };
  }, []);

  const polite = toasts.filter((t) => t.type !== "err");
  const assertive = toasts.filter((t) => t.type === "err");
  // An empty region is still a zero-height flex item, so a constant gap would
  // reserve 8px under the last visible toast and lift the stack off the bottom
  // inset. Space the two regions apart only while both hold a toast.
  const gap = polite.length > 0 && assertive.length > 0 ? "gap-2" : "";

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 flex flex-col pointer-events-none ${gap}`}
    >
      <ToastRegion role="status" live="polite" toasts={polite} />
      <ToastRegion role="alert" live="assertive" toasts={assertive} />
    </div>
  );
}

function ToastRegion({
  role,
  live,
  toasts,
}: {
  role: "status" | "alert";
  live: "polite" | "assertive";
  toasts: ToastMessage[];
}) {
  return (
    // aria-atomic="false" — both roles default to atomic, which re-reads every
    // surviving toast whenever one is added or dismissed.
    <div
      role={role}
      aria-live={live}
      aria-atomic="false"
      className="flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <Button
          bare
          key={t.id}
          type="button"
          title="Dismiss"
          onClick={() => dismissToast(t.id)}
          className="pointer-events-auto flex cursor-pointer items-center gap-2 rounded-md border bg-(--surface-1) px-3 py-2 text-left text-[12px] shadow-xl transition-all hover:bg-(--surface-2) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
          style={{
            borderColor:
              t.type === "err"
                ? "var(--hue-err)"
                : t.type === "ok"
                  ? "var(--hue-ok)"
                  : "var(--accent)",
          }}
        >
          <span
            className="size-2 shrink-0 rounded-full"
            style={{
              background:
                t.type === "err"
                  ? "var(--hue-err)"
                  : t.type === "ok"
                    ? "var(--hue-ok)"
                    : "var(--accent)",
            }}
          />
          <span className="text-(--text) font-medium">{t.message}</span>
        </Button>
      ))}
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => {
    if (typeof value === "string") {
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        return value;
      }
    }
    return JSON.stringify(value, null, 2);
  }, [value]);

  const tokens = useMemo(() => tokenizeJson(text), [text]);

  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    notify("Copied JSON to clipboard", "info");
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="relative group">
      <pre className="mono overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-3 pr-16 leading-relaxed whitespace-pre-wrap">
        {tokens.map((t, i) =>
          TOKEN_CLASSES[t.kind] ? (
            <span key={i} className={TOKEN_CLASSES[t.kind]}>
              {t.text}
            </span>
          ) : (
            t.text
          ),
        )}
      </pre>
      <Button
        bare
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 rounded border border-(--border) bg-(--surface-1) px-2 py-0.5 text-xs font-medium text-(--text-dim) opacity-0 transition-opacity group-hover:opacity-100 hover:bg-(--surface-2) hover:text-(--text)"
      >
        {copied ? "Copied!" : "Copy"}
      </Button>
    </div>
  );
}

/** Collapsible block for secondary payloads (result artifact, evidence). */
export function Disclosure({
  label,
  children,
  defaultOpen,
}: {
  label: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="group mb-1.5 list-none"
    >
      <summary
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1.5 text-[11px] text-(--text-faint) select-none hover:text-(--text-dim) [&::-webkit-details-marker]:hidden list-none"
      >
        <DisclosureChevron open={open} />
        <span>{label}</span>
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

const SECTIONS_KEY = "evrt-sections-collapsed";

/** Collapsed section ids, shared by every Section on the page (WM-136). */
function loadCollapsedSections(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(SECTIONS_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    // Private mode / stale value: sections simply start expanded.
    return [];
  }
}

/**
 * Read-modify-write against storage rather than against a cached copy — every
 * Section on the page shares this one key, so a toggle must not stomp the
 * collapse state of its siblings mounted at the same time.
 */
function saveCollapsedSection(id: string, collapsed: boolean): void {
  try {
    const next = new Set(loadCollapsedSections());
    if (collapsed) next.add(id);
    else next.delete(id);
    localStorage.setItem(SECTIONS_KEY, JSON.stringify([...next]));
  } catch {
    // Quota / private mode: collapse still works, it just does not persist.
  }
}

/**
 * A titled group of detail rows, rendered as one card (WM-136). The card
 * boundary is what separates concerns, so rows inside it carry no dividers of
 * their own — a hairline under every row read as a ledger dump rather than a
 * panel. Collapsing persists across reloads, keyed by `id` (pass one whenever
 * the title interpolates live data, or the key changes with the run).
 *
 * `card={false}` is for sections whose children already draw their own
 * bordered containers — nesting a card inside a card doubles the border.
 */
/**
 * "This section carries attribute icons" (§5.2 tier 4, WM-483). Set by
 * `<Section icons>`; every `KV` beneath it resolves its glyph from the
 * registry by label and reserves the slot when the label is unmapped, so
 * label text starts at one x down the whole section.
 */
const KVIconsContext = createContext(false);

export function Section({
  title,
  id,
  children,
  card = true,
  collapsible = true,
  icons = false,
}: {
  title: string;
  id?: string;
  children: ReactNode;
  card?: boolean;
  collapsible?: boolean;
  /** Resolve attribute icons for every `KV` in this section (see `attrIcons.tsx`). */
  icons?: boolean;
}) {
  const key = id ?? title;
  const [collapsed, setCollapsed] = useState(
    () => collapsible && loadCollapsedSections().includes(key),
  );
  const toggle = () =>
    setCollapsed((prev) => {
      const next = !prev;
      saveCollapsedSection(key, next);
      return next;
    });

  const heading = (
    <span className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
      {title}
    </span>
  );

  return (
    <KVIconsContext.Provider value={icons}>
      <div className="mb-5">
        {collapsible ? (
          <Button
            bare
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            className="mb-1.5 flex w-full cursor-pointer items-center gap-1.5 text-left hover:text-(--text-dim)"
          >
            <DisclosureChevron open={!collapsed} />
            {heading}
          </Button>
        ) : (
          <div className="mb-1.5">{heading}</div>
        )}
        {!collapsed &&
          (card ? (
            <div className="rounded-md border border-(--border) bg-(--surface-0) px-3 py-1.5">
              {children}
            </div>
          ) : (
            children
          ))}
      </div>
    </KVIconsContext.Provider>
  );
}

/**
 * Monospace is for identifiers, not for prose. A string value with whitespace
 * in it reads as language ("any worker", "not started"); everything else is an
 * id, hash, ref, or path where character alignment actually helps. ReactNode
 * values opt themselves in — `JumpLink` carries mono, `Ago` does not.
 */
const looksLikeIdentifier = (text: string) => !/\s/.test(text);

/**
 * `-` is the app-wide "unset" value. It is not copyable and it is not
 * information; render it fainter than the label so a panel with five unset
 * rows still lets the eye land on the five that are set (WM-482).
 */
const isUnset = (v: ReactNode) => v == null || v === "-";

export function KV({
  k,
  v,
  mono,
  icon,
}: {
  k: string;
  v: ReactNode;
  mono?: boolean;
  /**
   * Attribute icon per §5.2 tier 4 (WM-482): a Radix icon at 14px,
   * `currentColor`, leading the label at `gap-1.5`. Normally left unset —
   * inside `<Section icons>` the glyph resolves from `attrIcons.tsx` by
   * label (WM-483) so the same attribute wears the same icon everywhere.
   * `null` reserves an empty slot; an explicit node overrides the registry.
   */
  icon?: ReactNode;
}) {
  const autoIcons = useContext(KVIconsContext);
  const resolvedIcon =
    icon !== undefined ? icon : autoIcons ? attrIcon(k) : undefined;
  const text = typeof v === "string" ? v : null;
  const copyable = !!text && text !== "-";
  const isMono = mono ?? (text !== null && looksLikeIdentifier(text));
  const unset = isUnset(v);
  // Fixed label column with the value left-aligned beside it: right-aligning
  // values left a ragged edge (`1/1` next to `multi-dispatch-WM-127`) that the
  // eye had to re-find on every row (WM-136).
  return (
    <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] items-baseline gap-3 py-[3px]">
      <div
        className="flex min-w-0 items-center gap-1.5 text-(--text-faint)"
        title={k}
      >
        {resolvedIcon !== undefined && (
          <i
            className="inline-flex size-3.5 shrink-0 items-center justify-center not-italic [&>svg]:size-3.5"
            aria-hidden="true"
          >
            {resolvedIcon}
          </i>
        )}
        <span className="truncate">{k}</span>
      </div>
      {copyable ? (
        <Button
          bare
          type="button"
          // The row truncates long values; the tooltip is the only place the
          // full string is readable without copying (WM-129 critique).
          title={text}
          onClick={() => copyText(text, k)}
          className={`truncate text-left text-(--text-dim) hover:text-(--accent) ${isMono ? "mono" : ""}`}
        >
          {text}
        </Button>
      ) : (
        <span
          className={`truncate text-left ${unset ? "text-(--text-faint)" : "text-(--text-dim)"} ${isMono ? "mono" : ""}`}
          title={text ?? undefined}
        >
          {v ?? "-"}
        </span>
      )}
    </div>
  );
}

/**
 * Sub-grouping inside a `Section` of `KV` rows (WM-482). A flat run of
 * fifteen rows has no landmarks; a faint title plus a hairline every four or
 * five rows gives the eye somewhere to land without adding a second card.
 */
export function KVGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="not-first:mt-2 not-first:border-t not-first:border-(--border) not-first:pt-2">
      <div className="pb-0.5 text-[11px] font-medium text-(--text-faint)">
        {title}
      </div>
      {children}
    </div>
  );
}

export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: ButtonSize;
  variant?: "default" | "primary" | "danger" | "ghost";
  /** Preserve a bespoke non-control surface while still routing it through the
   * shared primitive. Keep this to structural rows and row-inline text verbs. */
  bare?: boolean;
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-6 gap-1 px-2 [&>svg]:size-3",
  md: "h-7 gap-1.5 px-2.5 [&>svg]:size-3.5",
  lg: "h-8 gap-2 px-3 [&>svg]:size-4",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      children,
      variant = "default",
      size = "md",
      bare = false,
      className = "",
      type = "button",
      ...props
    },
    ref,
  ) {
    const styles = {
      default:
        "border-(--border-strong) bg-(--surface-2) text-(--text) hover:bg-(--surface-3)",
      primary:
        "border-transparent bg-(--accent) text-(--on-accent) hover:opacity-90",
      danger:
        "border-(--border-strong) bg-(--surface-2) hover:bg-(--surface-3) text-(--hue-err)",
      ghost:
        "border-transparent bg-transparent text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)",
    }[variant];
    return (
      <button
        ref={ref}
        type={type}
        data-control-size={bare ? undefined : size}
        className={
          bare
            ? className
            : `inline-flex shrink-0 items-center justify-center rounded-md border text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_SIZES[size]} ${styles} ${className}`
        }
        {...props}
      >
        {children}
      </button>
    );
  },
);

interface TooltipRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
}

export interface TooltipPosition {
  top: number;
  left: number;
}

/**
 * Clamp/flip a tooltip so it stays fully inside the viewport (WM-589
 * follow-up). Prefers opening below and centered under the trigger — the
 * previous CSS-only default — but flips above when there isn't room below
 * (e.g. a trigger pinned to the bottom edge), and always clamps
 * horizontally so a right- or left-aligned trigger never clips off-screen.
 */
export function clampTooltipPosition(
  trigger: TooltipRect,
  tooltip: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): TooltipPosition {
  const gap = 6;
  let top = trigger.bottom + gap;
  if (top + tooltip.height + margin > viewport.height) {
    const above = trigger.top - tooltip.height - gap;
    top =
      above >= margin
        ? above
        : Math.max(margin, viewport.height - tooltip.height - margin);
  }
  const maxLeft = Math.max(margin, viewport.width - tooltip.width - margin);
  const left = Math.min(
    Math.max(trigger.left + trigger.width / 2 - tooltip.width / 2, margin),
    maxLeft,
  );
  return { top, left };
}

/**
 * A real hover/focus tooltip shared by icon-only controls. Position is
 * fixed and JS-computed (see `clampTooltipPosition`) rather than pure CSS
 * placement, so it never opens off-screen for edge-pinned triggers (bottom
 * status bar, right-aligned toolbar buttons, …).
 */
export function Tooltip({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<TooltipPosition | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);

  // Kept mounted (opacity-0 while closed) rather than conditionally rendered,
  // so callers/tests can find the tooltip by role without simulating hover,
  // and so there is no mount flash the first time it opens. Depends on
  // `label` too (not just `open`): a tooltip can stay open across a click
  // that changes its own text (e.g. the theme toggle's label flips on
  // click without the pointer/focus leaving the button) — without this,
  // the position goes stale for the new (often wider) label and can clip
  // off the edge it was just clamped away from.
  useLayoutEffect(() => {
    const position = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const tooltip = tooltipRef.current?.getBoundingClientRect();
      if (!trigger || !tooltip) return;
      setPos(
        clampTooltipPosition(
          trigger,
          { width: tooltip.width, height: tooltip.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, label]);

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      <span
        ref={tooltipRef}
        role="tooltip"
        style={pos ? { top: pos.top, left: pos.left } : undefined}
        className={`pointer-events-none fixed z-50 rounded border border-(--border-strong) bg-(--surface-2) px-2 py-1 text-[11px] font-normal whitespace-nowrap text-(--text) shadow-lg transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
      >
        {label}
      </span>
    </span>
  );
}

export type IconButtonProps = Omit<
  ButtonProps,
  "aria-label" | "children" | "size"
> & {
  "aria-label": string;
  children: ReactNode;
  tooltip?: ReactNode;
};

/** Square 28px icon control with a mandatory accessible name and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      "aria-label": ariaLabel,
      tooltip,
      className = "",
      variant = "ghost",
      ...props
    },
    ref,
  ) {
    if (!ariaLabel?.trim()) {
      throw new Error("IconButton requires a non-empty aria-label");
    }
    return (
      <Tooltip label={tooltip ?? ariaLabel}>
        <Button
          ref={ref}
          aria-label={ariaLabel}
          size="md"
          variant={variant}
          className={`w-7 !px-0 ${className}`}
          {...props}
        />
      </Tooltip>
    );
  },
);

const FOCUSABLE =
  "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Whether a candidate is rendered without relying on offsetParent layout semantics. */
function isTabCycleNodeVisible(el: HTMLElement, root: HTMLElement): boolean {
  if (!el.isConnected) return false;

  // `offsetParent` is also null for visible fixed-position elements and for
  // descendants of `display: contents`. Walk the rendered ancestor chain
  // instead, while checking visibility on the candidate because descendants
  // can override an ancestor's `visibility` value.
  let current: HTMLElement | null = el;
  while (current) {
    if (current.hidden) return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === "none") return false;
    if (current === root) break;
    current = current.parentElement;
  }

  const visibility =
    el.ownerDocument.defaultView?.getComputedStyle(el).visibility;
  return visibility !== "hidden" && visibility !== "collapse";
}

/** Keep Tab focus inside a modal while ignoring controls hidden by layout. */
export function tabCycle(root: HTMLElement, e: KeyboardEvent) {
  const nodes = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => isTabCycleNodeVisible(el, root),
  );
  if (nodes.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !root.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !root.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

export function Dialog({
  title,
  onClose,
  children,
  wide,
  extraWide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  extraWide?: boolean;
}) {
  useFocusReturn();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    modal.depth += 1;
    const depth = modal.depth;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && depth === modal.depth) onCloseRef.current();
      else if (e.key === "Tab" && panelRef.current)
        tabCycle(panelRef.current, e);
    };
    window.addEventListener("keydown", onKey);
    const root = panelRef.current;
    const pref = root?.querySelector<HTMLElement>("[autofocus]");
    (pref ?? root)?.focus();
    return () => {
      modal.depth -= 1;
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4 sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onCloseRef.current()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${extraWide ? "w-[920px] max-w-[95vw]" : wide ? "w-[720px]" : "w-[480px]"} max-h-[85vh] overflow-y-auto rounded-lg border border-(--border-strong) bg-(--surface-1) p-4 sm:p-5 shadow-2xl outline-none`}
      >
        <div id={titleId} className="display mb-3 text-[15px] font-semibold">
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Segmented tab strip (WM-76). Disabled tabs stay clickable so the owner can state why. */
export function Tabs({
  tabs,
  active,
  onSelect,
  label,
}: {
  tabs: { id: string; label: ReactNode; disabled?: boolean; title?: string }[];
  active: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-md border border-(--border) bg-(--surface-0) p-0.5"
    >
      {tabs.map((t) => (
        <Button
          bare
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          aria-disabled={t.disabled || undefined}
          title={t.title}
          onClick={() => onSelect(t.id)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            active === t.id
              ? "bg-(--surface-3) text-(--text)"
              : t.disabled
                ? "text-(--text-faint) opacity-60"
                : "text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
          }`}
        >
          {t.label}
        </Button>
      ))}
    </div>
  );
}

/** Read-only value badge (schema `const` fields). */
export function Pill({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="mono inline-flex items-center rounded border border-(--border) bg-(--surface-2) px-1.5 py-0.5 text-[11px] text-(--text-dim)"
    >
      {children}
    </span>
  );
}

/** Text input with a token-styled suggestion popover and free write-in (WM-79). */
export function SuggestInput({
  id,
  value,
  onChange,
  suggestions,
  placeholder,
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  suggestions?: string[] | null;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const items = useMemo(() => {
    if (!suggestions || suggestions.length === 0) return [];
    const q = value.trim().toLowerCase();
    if (!q) return suggestions;
    const filtered = suggestions.filter((s) => s.toLowerCase().includes(q));
    return filtered.length > 0 ? filtered : suggestions;
  }, [suggestions, value]);

  const show = open && items.length > 0;

  useEffect(() => {
    setHighlight(0);
  }, [items]);

  useEffect(() => {
    if (!show || !listRef.current) return;
    listRef.current
      .querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, show]);

  const pick = (s: string) => {
    onChange(s);
    setOpen(false);
  };

  return (
    <span className="relative block">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={show}
        aria-autocomplete="list"
        aria-controls={show ? listId : undefined}
        aria-activedescendant={
          show && items[highlight] ? `${listId}-opt-${highlight}` : undefined
        }
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            if (items.length === 0) return;
            e.preventDefault();
            setOpen(true);
            if (show) setHighlight((i) => (i + 1) % items.length);
            return;
          }
          if (e.key === "ArrowUp") {
            if (!show || items.length === 0) return;
            e.preventDefault();
            setHighlight((i) => (i - 1 + items.length) % items.length);
            return;
          }
          if (e.key === "Enter" && show && items[highlight]) {
            e.preventDefault();
            e.stopPropagation();
            pick(items[highlight]);
            return;
          }
          if (e.key === "Escape" && show) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        className="mono w-full rounded-md border border-(--border) bg-(--surface-0) px-2 py-1 text-[12px] text-(--text) outline-none focus:border-(--border-strong)"
      />
      {show && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Suggestions"
          className="absolute top-full left-0 z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border border-(--border-strong) bg-(--surface-1) p-1 text-[12px] shadow-xl outline-none"
        >
          {items.map((s, idx) => (
            <li
              key={s}
              id={`${listId}-opt-${idx}`}
              role="option"
              aria-selected={idx === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              className={`mono cursor-pointer truncate rounded px-2 py-1 select-none ${
                idx === highlight
                  ? "bg-(--surface-3) text-(--text)"
                  : "text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
              }`}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

/** Chip list editor for arrays of strings: add via input (Enter or +), remove per chip. */
export function ChipInput({
  id,
  values,
  onChange,
  suggestions,
  placeholder,
}: {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  suggestions?: string[] | null;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [popoverRect, setPopoverRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const listId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo(() => {
    if (!suggestions || suggestions.length === 0) return [];
    const q = draft.trim().toLowerCase();
    return suggestions.filter(
      (s) => !values.includes(s) && (!q || s.toLowerCase().includes(q)),
    );
  }, [draft, suggestions, values]);
  const show = open && items.length > 0;

  useEffect(() => {
    if (!show || !anchorRef.current) {
      setPopoverRect(null);
      return;
    }
    const position = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect)
        setPopoverRect({
          top: rect.bottom + 4,
          left: rect.left,
          width: rect.width,
        });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [show]);

  useEffect(() => {
    if (!show || !listRef.current) return;
    listRef.current
      .querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, show]);

  const add = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (!values.includes(v)) onChange([...values, v]);
    setDraft("");
    setOpen(false);
  };
  return (
    <div className="rounded-md border border-(--border) bg-(--surface-0) p-1.5">
      {values.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {values.map((v) => (
            <Button
              bare
              key={v}
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              title={`Remove ${v}`}
              aria-label={`Remove ${v}`}
              className="group inline-flex cursor-pointer items-center gap-1 rounded-md border border-(--border) bg-(--surface-2) px-1.5 py-0.5 text-[11px] hover:border-(--border-strong) hover:bg-(--surface-3)"
            >
              <span className="mono">{v}</span>
              <span
                aria-hidden
                className="text-(--text-faint) group-hover:text-(--text)"
              >
                ×
              </span>
            </Button>
          ))}
        </div>
      )}
      <div ref={anchorRef} className="relative flex items-center gap-1">
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={show}
          aria-autocomplete="list"
          aria-controls={show ? listId : undefined}
          aria-activedescendant={
            show && items[highlight] ? `${listId}-opt-${highlight}` : undefined
          }
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setHighlight(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              if (items.length === 0) return;
              e.preventDefault();
              setOpen(true);
              if (show) setHighlight((i) => (i + 1) % items.length);
              return;
            }
            if (e.key === "ArrowUp") {
              if (!show || items.length === 0) return;
              e.preventDefault();
              setHighlight((i) => (i - 1 + items.length) % items.length);
              return;
            }
            if (e.key === "Escape" && show) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              return;
            }
            if (e.key !== "Enter") return;
            e.preventDefault();
            e.stopPropagation();
            add(show && items[highlight] ? items[highlight] : draft);
          }}
          placeholder={placeholder ?? "add…"}
          spellCheck={false}
          className="mono w-full rounded border-0 bg-transparent px-1 py-0.5 text-[12px] text-(--text) outline-none placeholder:text-(--text-faint)"
        />
        {show &&
          popoverRect &&
          createPortal(
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Suggestions"
              style={popoverRect}
              className="fixed z-50 max-h-60 overflow-auto rounded-md border border-(--border-strong) bg-(--surface-1) p-1 text-[12px] shadow-xl outline-none"
            >
              {items.map((s, idx) => (
                <li
                  key={s}
                  id={`${listId}-opt-${idx}`}
                  role="option"
                  aria-selected={idx === highlight}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(s);
                  }}
                  className={`mono cursor-pointer truncate rounded px-2 py-1 select-none ${
                    idx === highlight
                      ? "bg-(--surface-3) text-(--text)"
                      : "text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
                  }`}
                >
                  {s}
                </li>
              ))}
            </ul>,
            document.body,
          )}
        <Button
          bare
          type="button"
          onClick={() => add(draft)}
          disabled={!draft.trim()}
          className="rounded border border-(--border) px-1.5 py-0.5 text-[11px] text-(--text-dim) hover:bg-(--surface-2) disabled:cursor-not-allowed disabled:opacity-40"
        >
          add
        </Button>
      </div>
    </div>
  );
}

/** Inline verb-failure line: 404/409 are normal raced outcomes (spec §6). */
export function VerbError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div
      className="mt-2 rounded-md px-2.5 py-1.5 text-[12px]"
      style={{
        color: "var(--hue-err)",
        background: "color-mix(in oklch, var(--hue-err) 10%, transparent)",
      }}
    >
      {(error as Error).message}
    </div>
  );
}

/** Floating bulk action bar that pins above the bottom edge when items are selected. */
export function BulkActionBar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear?: () => void;
  children: ReactNode;
}) {
  if (count <= 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-(--border-strong) bg-(--surface-1) px-4 py-2.5 shadow-2xl backdrop-blur-sm"
    >
      <div className="flex items-center gap-2 text-[12px] font-medium text-(--text)">
        <span className="tabular-nums font-semibold">{count}</span> selected
      </div>
      <div className="h-4 w-px bg-(--border)" />
      <div className="flex items-center gap-2">{children}</div>
      {onClear && (
        <>
          <div className="h-4 w-px bg-(--border)" />
          <Button
            bare
            type="button"
            onClick={onClear}
            className="cursor-pointer text-[11px] text-(--text-faint) hover:text-(--text)"
          >
            Clear
          </Button>
        </>
      )}
    </div>
  );
}
