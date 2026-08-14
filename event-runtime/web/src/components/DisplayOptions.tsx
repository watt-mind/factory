/**
 * The "Display" popover (OPS-493) — Linear's view-options panel for the table
 * views: grouping, sub-grouping, ordering, list options, display properties.
 * Pure presentation over `displayOptions.ts`; the owning view holds the state
 * via `useDisplayOptions` and passes it down, so the panel never touches
 * storage and the table never re-derives what the panel showed.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { modal } from "../hooks";
import {
  DEFAULT_ORDER,
  NONE,
  defaultDisplayState,
  isDefaultDisplayState,
  type DisplayConfig,
  type DisplayState,
} from "../displayOptions";

function OptionRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between gap-3">
      <label htmlFor={htmlFor} className="shrink-0 text-[12px] text-(--text-dim)">
        {label}
      </label>
      {children}
    </div>
  );
}

function Select({
  id,
  value,
  onChange,
  options,
  disabled,
  label,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  label: string;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className="w-32 cursor-pointer rounded-md border border-(--border) bg-(--surface-2) px-2 py-1 text-[12px] text-(--text) outline-none hover:border-(--border-strong) focus:border-(--accent) disabled:cursor-not-allowed disabled:opacity-40"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-4 w-7 cursor-pointer rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: checked ? "var(--accent)" : "var(--surface-3)" }}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 size-3 rounded-full bg-(--contrast) transition-transform duration-150 ${
          checked ? "translate-x-3.5" : "translate-x-0.5"
        }`}
        style={checked ? { background: "var(--on-accent)" } : undefined}
      />
    </button>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 mb-1 text-[10.5px] font-medium tracking-wide text-(--text-faint) uppercase">
      {children}
    </div>
  );
}

/** Slider-style glyph, drawn with the text color so every theme carries it. */
function SlidersIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M1 3h10M1 9h10" />
      <circle cx="4" cy="3" r="1.5" fill="var(--surface-1)" />
      <circle cx="8" cy="9" r="1.5" fill="var(--surface-1)" />
    </svg>
  );
}

export function DisplayOptions<T>({
  config,
  state,
  onChange,
}: {
  config: DisplayConfig<T>;
  state: DisplayState;
  onChange: (next: DisplayState | ((state: DisplayState) => DisplayState)) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const groupId = useId();
  const subId = useId();
  const orderId = useId();

  // The open panel is a light modal: the list's j/k/Enter verbs stand down,
  // Esc closes the panel (not the selection), outside click dismisses.
  useEffect(() => {
    if (!open) return;
    modal.depth += 1;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      modal.depth -= 1;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const customized = !isDefaultDisplayState(config, state);
  const activeGroup = config.groups.find((g) => g.key === state.groupBy);
  const subOptions = (config.subGroups ?? []).filter((k) => k !== state.groupBy);
  const toggleable = config.columns.filter((c) => !c.always);
  const groupLabel = (key: string) =>
    config.groups.find((g) => g.key === key)?.label ?? key;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] font-medium transition-colors ${
          open
            ? "border-(--border-strong) bg-(--surface-2) text-(--text)"
            : "border-(--border) text-(--text-dim) hover:bg-(--surface-1) hover:text-(--text)"
        }`}
      >
        <SlidersIcon />
        Display
        {customized && (
          <span aria-hidden className="size-1.5 rounded-full bg-(--accent)" title="Display options customized" />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Display options"
          className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-lg border border-(--border-strong) bg-(--surface-1) p-3 shadow-2xl"
        >
          <OptionRow label="Grouping" htmlFor={groupId}>
            <Select
              id={groupId}
              label="Group by"
              value={state.groupBy}
              onChange={(groupBy) =>
                onChange((s) => ({
                  ...s,
                  groupBy,
                  subGroupBy: s.subGroupBy === groupBy ? NONE : s.subGroupBy,
                  collapsed: [],
                }))
              }
              options={[
                { value: NONE, label: "No grouping" },
                ...config.groups.map((g) => ({ value: g.key, label: g.label })),
              ]}
            />
          </OptionRow>

          {(config.subGroups?.length ?? 0) > 0 && (
            <OptionRow label="Sub-grouping" htmlFor={subId}>
              <Select
                id={subId}
                label="Sub-group by"
                disabled={state.groupBy === NONE}
                value={state.subGroupBy}
                onChange={(subGroupBy) => onChange((s) => ({ ...s, subGroupBy, collapsed: [] }))}
                options={[
                  { value: NONE, label: "No sub-grouping" },
                  ...subOptions.map((k) => ({ value: k, label: groupLabel(k) })),
                ]}
              />
            </OptionRow>
          )}

          <OptionRow label="Ordering" htmlFor={orderId}>
            <div className="flex items-center gap-1.5">
              <Select
                id={orderId}
                label="Order by"
                value={state.sortBy}
                onChange={(sortBy) =>
                  onChange((s) => ({
                    ...s,
                    sortBy,
                    sortDir:
                      config.sorts.find((f) => f.key === sortBy)?.defaultDir ?? "asc",
                  }))
                }
                options={[
                  { value: DEFAULT_ORDER, label: "API order" },
                  ...config.sorts.map((f) => ({ value: f.key, label: f.label })),
                ]}
              />
              <button
                type="button"
                aria-label={`Direction: ${state.sortDir === "asc" ? "ascending" : "descending"} — reverse`}
                title={state.sortDir === "asc" ? "Ascending" : "Descending"}
                onClick={() => onChange((s) => ({ ...s, sortDir: s.sortDir === "asc" ? "desc" : "asc" }))}
                className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-(--border) text-[11px] text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
              >
                {state.sortDir === "asc" ? "↑" : "↓"}
              </button>
            </div>
          </OptionRow>

          <GroupLabel>List options</GroupLabel>
          <OptionRow label="Show empty groups">
            <Switch
              label="Show empty groups"
              disabled={!activeGroup?.order}
              checked={state.showEmpty && !!activeGroup?.order}
              onChange={(showEmpty) => onChange((s) => ({ ...s, showEmpty }))}
            />
          </OptionRow>

          {toggleable.length > 0 && (
            <>
              <GroupLabel>Display properties</GroupLabel>
              <div className="flex flex-wrap gap-1.5">
                {toggleable.map((c) => {
                  const shown = !state.hiddenColumns.includes(c.key);
                  return (
                    <button
                      key={c.key}
                      type="button"
                      aria-pressed={shown}
                      onClick={() =>
                        onChange((s) => ({
                          ...s,
                          hiddenColumns: shown
                            ? [...s.hiddenColumns, c.key]
                            : s.hiddenColumns.filter((k) => k !== c.key),
                        }))
                      }
                      className={`cursor-pointer rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                        shown
                          ? "border-(--border-strong) bg-(--surface-3) text-(--text)"
                          : "border-(--border) text-(--text-faint) hover:bg-(--surface-2) hover:text-(--text-dim)"
                      }`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {customized && (
            <div className="mt-3 border-t border-(--border) pt-2 text-right">
              <button
                type="button"
                onClick={() => onChange({ ...defaultDisplayState(config), collapsed: [] })}
                className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] text-(--text-faint) hover:bg-(--surface-2) hover:text-(--text)"
              >
                Reset to defaults
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
