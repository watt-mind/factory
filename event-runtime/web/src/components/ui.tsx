import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { modal, useNow } from "../hooks";
import { tokenizeJson, TOKEN_CLASSES } from "../highlight";
import { flushHash } from "../hash";
import {
  type FilterChipToken,
  type FilterQuery,
  chipHelp,
  chipLabel,
  filterHint,
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

export function copyText(text: string, label: string) {
  navigator.clipboard.writeText(text);
  notify(`Copied ${label}`, "info");
}

/** Shareable hash of the current selection — the payoff of hash-as-source-of-truth. */
export function copyLink() {
  flushHash();
  copyText(window.location.href, "link");
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
    <button
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
      <span className={`mono ${token.supported ? "" : "line-through"}`}>{label}</span>
      <span aria-hidden className="text-(--text-faint) group-hover:text-(--text)">
        ×
      </span>
    </button>
  );
}

/**
 * The list filter box. Pass `query` (parsed by the view, which is the only
 * thing that knows its own facets) to get the keyed syntax: the text stays
 * authoritative and the chips are what it parsed to, so editing the box and
 * dismissing a chip can never disagree about the current filter.
 */
export function FilterInput({
  value,
  onChange,
  placeholder,
  label,
  query,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  query?: FilterQuery;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [hint, setHint] = useState(false);
  const chips = query?.chips ?? [];
  const hintText = query ? filterHint(query) : "";
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
          value={value}
          aria-describedby={query ? hintId : undefined}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setHint(true)}
          onBlur={() => setHint(false)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            if (value) onChange("");
            else e.currentTarget.blur();
          }}
          placeholder={placeholder}
          aria-label={label}
          className="w-full rounded-md border border-(--border) bg-(--surface-1) px-2.5 py-1 pr-7 text-[12px] text-(--text) outline-none placeholder:text-(--text-faint) focus:border-(--accent)"
        />
        {!value && (
          <kbd
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border border-(--border) px-1 font-sans text-[10px] text-(--text-faint)"
          >
            /
          </kbd>
        )}
        {/* Syntax on `/`, not on hover — the operators who need it reached
            this box with a keystroke. It floats over the table rather than
            taking a row, so focusing the filter never moves the rows. Right-
            aligned and wider than the box: Runs parks the input at the far
            end of the tab row, and a box-width column of wrapping text is
            unreadable. */}
        {query && (
          <span
            id={hintId}
            className={
              hint && !value
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
          <button
            type="button"
            onClick={() => rewrite("")}
            title="Clear query (Esc)"
            aria-label="Clear query"
            className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-(--text-faint) hover:bg-(--surface-1) hover:text-(--text)"
          >
            clear
          </button>
        </div>
      )}
    </>
  );
}

/** Pinned title/tabs/filter; only the table (and anything below it) scrolls. */
export function ListPane({ chrome, children }: { chrome: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pt-5 pb-3">{chrome}</div>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">{children}</div>
    </div>
  );
}

/** Pinned copy/close bar; the spec and payload scroll underneath. */
export function DetailPane({
  widthClass,
  title,
  actions,
  children,
}: {
  widthClass: string;
  title: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <aside className={`${widthClass} flex min-h-0 shrink-0 flex-col border-l border-(--border) bg-(--surface-1)`}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--border) px-4 py-3">
        <div className="display min-w-0 truncate text-[14px] font-semibold">{title}</div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">{actions}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
    </aside>
  );
}

export const ESC_CLEARS_FILTER = "Esc clears the filter";

/** Empty / loading / error row for the dense lists. Never say "none" while pending. */
export function ListEmpty({
  colSpan,
  query,
  filtered,
  noun,
  empty,
  action,
  escHint,
}: {
  colSpan: number;
  query: { isPending: boolean; isError: boolean; data?: unknown };
  filtered?: boolean;
  noun: string;
  empty: string;
  action?: ReactNode;
  escHint?: boolean;
}) {
  let msg = empty;
  if (query.isPending && !query.data) msg = `Loading ${noun}…`;
  else if (query.isError && !query.data) {
    msg = `Cannot reach the control API — ${noun} will appear when it is up.`;
  } else if (filtered) msg = `No ${noun} match this filter.`;
  const showEscHint = (filtered || escHint) && !query.isPending && !query.isError;
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-(--text-faint)">
        <div>{msg}</div>
        {showEscHint && (
          <div className="mt-2 text-[11px]">{ESC_CLEARS_FILTER}</div>
        )}
        {action && !query.isPending && !query.isError && !filtered && <div className="mt-3">{action}</div>}
      </td>
    </tr>
  );
}

export function StateBadge({
  state,
  hues = STATE_HUES,
}: {
  state: string;
  hues?: Record<string, string>;
}) {
  const hue = hues[state] ?? "var(--hue-idle)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{ color: hue, background: `color-mix(in oklch, ${hue} 12%, transparent)` }}
    >
      <span className="size-1.5 rounded-full" style={{ background: hue }} />
      {state}
    </span>
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
      <div className="display text-xl tabular-nums" style={hue ? { color: hue } : undefined}>
        {value}
      </div>
    </>
  );
  const cls = "rounded-md border border-(--border) bg-(--surface-1) px-3 py-2 text-left";
  if (!onClick) return <div className={cls}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${value}`}
      className={`${cls} cursor-pointer hover:bg-(--surface-2)`}
    >
      {inner}
    </button>
  );
}

/** In-table / KV jump that does not select the parent row. */
export function JumpLink({
  children,
  onClick,
  title,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`mono cursor-pointer text-left hover:text-(--accent) ${className ?? ""}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

export function Countdown({ createdAt, ttlSeconds }: { createdAt: string; ttlSeconds: number }) {
  const now = useNow();
  const left = Math.floor((new Date(createdAt).getTime() + ttlSeconds * 1000 - now) / 1000);
  if (left <= 0) return <span style={{ color: "var(--hue-err)" }}>expired</span>;
  const m = Math.floor(left / 60);
  const s = left % 60;
  const low = left < 300;
  return (
    <span className="tabular-nums" style={low ? { color: "var(--hue-warn)" } : undefined}>
      {m}:{String(s).padStart(2, "0")}
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
    <div className={`fixed bottom-4 right-4 z-50 flex flex-col pointer-events-none ${gap}`}>
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
    <div role={role} aria-live={live} aria-atomic="false" className="flex flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          title="Dismiss"
          onClick={() => dismissToast(t.id)}
          className="pointer-events-auto flex cursor-pointer items-center gap-2 rounded-md border bg-(--surface-1) px-3 py-2 text-left text-[12px] shadow-xl transition-all hover:bg-(--surface-2) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
          style={{
            borderColor: t.type === "err" ? "var(--hue-err)" : t.type === "ok" ? "var(--hue-ok)" : "var(--accent)",
          }}
        >
          <span
            className="size-2 shrink-0 rounded-full"
            style={{
              background: t.type === "err" ? "var(--hue-err)" : t.type === "ok" ? "var(--hue-ok)" : "var(--accent)",
            }}
          />
          <span className="text-(--text) font-medium">{t.message}</span>
        </button>
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
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 rounded border border-(--border) bg-(--surface-1) px-2 py-0.5 text-[10px] font-medium text-(--text-dim) opacity-0 transition-opacity group-hover:opacity-100 hover:bg-(--surface-2) hover:text-(--text)"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
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
  return (
    <details open={defaultOpen} className="mb-1.5">
      <summary className="cursor-pointer text-[11px] text-(--text-faint) select-none hover:text-(--text-dim)">
        {label}
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-1.5 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  const text = typeof v === "string" ? v : null;
  const copyable = !!text && text !== "-";
  return (
    <div className="flex justify-between gap-4 border-b border-(--border) py-1 last:border-0">
      <span className="text-(--text-faint)">{k}</span>
      {copyable ? (
        <button
          type="button"
          title={`Copy ${k}`}
          onClick={() => copyText(text, k)}
          className="mono max-w-[70%] truncate text-right text-(--text-dim) hover:text-(--accent)"
        >
          {text}
        </button>
      ) : (
        <span className="mono truncate text-(--text-dim)" title={text ?? undefined}>
          {v ?? "-"}
        </span>
      )}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  autoFocus,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const styles = {
    default: "border-(--border-strong) bg-(--surface-2) text-(--text) hover:bg-(--surface-3)",
    primary: "border-transparent bg-(--accent) text-(--on-accent) hover:opacity-90",
    danger:
      "border-(--border-strong) bg-(--surface-2) hover:bg-(--surface-3) text-[color:var(--hue-err)]",
  }[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      className={`rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

const FOCUSABLE =
  "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

function tabCycle(root: HTMLElement, e: KeyboardEvent) {
  const nodes = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
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
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    modal.depth += 1;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      else if (e.key === "Tab" && panelRef.current) tabCycle(panelRef.current, e);
    };
    window.addEventListener("keydown", onKey);
    const root = panelRef.current;
    const pref = root?.querySelector<HTMLElement>("[autofocus]");
    (pref ?? root)?.focus();
    return () => {
      modal.depth -= 1;
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onClose lives in the ref
  }, []);
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[10vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onCloseRef.current()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${extraWide ? "w-[920px] max-w-[95vw]" : wide ? "w-[720px]" : "w-[480px]"} max-h-[80vh] overflow-auto rounded-lg border border-(--border-strong) bg-(--surface-1) p-4 shadow-2xl outline-none`}
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
    <div role="tablist" aria-label={label} className="inline-flex gap-0.5 rounded-md border border-(--border) bg-(--surface-0) p-0.5">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          aria-disabled={t.disabled || undefined}
          title={t.title}
          onClick={() => onSelect(t.id)}
          className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
            active === t.id
              ? "bg-(--surface-3) text-(--text)"
              : t.disabled
                ? "text-(--text-faint) opacity-60"
                : "text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Read-only value badge (schema `const` fields). */
export function Pill({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="mono inline-flex items-center rounded border border-(--border) bg-(--surface-2) px-1.5 py-0.5 text-[11px] text-(--text-dim)"
    >
      {children}
    </span>
  );
}

/** Text input with datalist suggestions and free write-in (WM-76 repo picker). */
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
  return (
    <>
      <input
        id={id}
        type="text"
        value={value}
        list={suggestions && suggestions.length > 0 ? listId : undefined}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        className="mono w-full rounded-md border border-(--border) bg-(--surface-0) px-2 py-1 text-[12px] text-(--text) outline-none focus:border-(--border-strong)"
      />
      {suggestions && suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
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
  const listId = useId();
  const add = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (!values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="rounded-md border border-(--border) bg-(--surface-0) p-1.5">
      {values.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {values.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              title={`Remove ${v}`}
              aria-label={`Remove ${v}`}
              className="group inline-flex cursor-pointer items-center gap-1 rounded-md border border-(--border) bg-(--surface-2) px-1.5 py-0.5 text-[11px] hover:border-(--border-strong) hover:bg-(--surface-3)"
            >
              <span className="mono">{v}</span>
              <span aria-hidden className="text-(--text-faint) group-hover:text-(--text)">
                ×
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <input
          id={id}
          type="text"
          value={draft}
          list={suggestions && suggestions.length > 0 ? listId : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            e.stopPropagation();
            add(draft);
          }}
          placeholder={placeholder ?? "add…"}
          spellCheck={false}
          className="mono w-full rounded border-0 bg-transparent px-1 py-0.5 text-[12px] text-(--text) outline-none placeholder:text-(--text-faint)"
        />
        {suggestions && suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions
              .filter((s) => !values.includes(s))
              .map((s) => (
                <option key={s} value={s} />
              ))}
          </datalist>
        )}
        <button
          type="button"
          onClick={() => add(draft)}
          disabled={!draft.trim()}
          className="rounded border border-(--border) px-1.5 py-0.5 text-[11px] text-(--text-dim) hover:bg-(--surface-2) disabled:cursor-not-allowed disabled:opacity-40"
        >
          add
        </button>
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
