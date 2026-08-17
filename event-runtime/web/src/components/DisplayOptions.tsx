/**
 * The "Display" popover (OPS-493, WM-214) — Linear's view-options panel for the table
 * views: grouping, sub-grouping, ordering, list options, display properties,
 * and dynamic payload/spec custom columns.
 * Pure presentation over `displayOptions.ts`; the owning view holds the state
 * via `useDisplayOptions` and passes it down, so the panel never touches
 * storage and the table never re-derives what the panel showed.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { keyGuard, modal } from "../hooks";
import { goPrefixActive } from "../goSequence";
import {
  DEFAULT_ORDER,
  NONE,
  addCustomColumn,
  defaultDisplayState,
  isDefaultDisplayState,
  removeCustomColumn,
  type DisplayConfig,
  type DisplayState,
} from "../displayOptions";
import {
  discoverPayloadFields,
  groupDiscoveredFields,
  type DiscoveredField,
} from "../schemaDiscovery";

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

function ListboxSelect({
  id,
  ref,
  value,
  onChange,
  options,
  disabled,
  label,
}: {
  id?: string;
  ref?: RefObject<HTMLButtonElement | null>;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  label: string;
}) {
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const internalRef = useRef<HTMLButtonElement>(null);
  const triggerRef = ref ?? internalRef;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(selectedIndex);
  const selected = options[selectedIndex] ?? options[0];

  useEffect(() => {
    if (!open) return;
    (listRef.current?.children[highlight] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }, [highlight, listId, open]);

  const show = () => {
    if (disabled) return;
    setHighlight(selectedIndex);
    setOpen(true);
  };

  const pick = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        show();
      } else {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((index) => (index + delta + options.length) % options.length);
      }
      return;
    }
    if (open && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      setHighlight(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (open) pick(highlight);
      else show();
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "Tab") setOpen(false);
  };

  return (
    <div className="relative w-32">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        data-display-listbox-trigger
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-option-${highlight}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-(--border) bg-(--surface-2) px-2 py-1 text-left text-[12px] text-(--text) outline-none hover:border-(--border-strong) focus:border-(--accent) disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="truncate">{selected?.label}</span>
        <span aria-hidden className="shrink-0 text-[9px] text-(--text-faint)">▼</span>
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={`${label} options`}
          className="absolute top-full right-0 z-40 mt-1 max-h-52 w-40 overflow-auto rounded-md border border-(--border-strong) bg-(--surface-1) p-1 text-[12px] shadow-xl outline-none"
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(index);
              }}
              onMouseEnter={() => setHighlight(index)}
              className={`flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 select-none ${
                index === highlight
                  ? "bg-(--surface-3) text-(--text)"
                  : "text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
              }`}
            >
              <span className="truncate">{option.label}</span>
              {option.value === value && <span aria-hidden className="text-(--accent)">✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
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
    <div className="mt-3 mb-1 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
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

export function exportJson(filename: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const url = typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(blob)
      : "";
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (url && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(url);
    }
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=true]"));
}

/** SuggestInput interaction model with richer, non-selectable discovery groups. */
function DiscoveredFieldSuggestInput({
  value,
  fields,
  placeholder,
  onChange,
  onAdd,
}: {
  value: string;
  fields: DiscoveredField[];
  placeholder: string;
  onChange: (value: string) => void;
  onAdd: (path: string) => void;
}) {
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const filteredFields = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!query) return fields;
    return fields.filter((field) => field.path.toLowerCase().includes(query));
  }, [fields, value]);
  const groups = useMemo(() => groupDiscoveredFields(filteredFields), [filteredFields]);
  const selectableFields = useMemo(() => groups.flatMap((group) => group.fields), [groups]);
  const indexedGroups = useMemo(() => {
    let index = 0;
    return groups.map((group) => ({
      ...group,
      fields: group.fields.map((field) => ({ field, index: index++ })),
    }));
  }, [groups]);
  const show = open && selectableFields.length > 0;
  const showNotSeenHint = value.trim().length > 0 && selectableFields.length === 0;

  useEffect(() => {
    setHighlight(0);
  }, [selectableFields]);

  useEffect(() => {
    if (!show || !listRef.current) return;
    listRef.current.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlight, show]);

  const pick = (field: DiscoveredField) => {
    onAdd(field.path);
    setOpen(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && selectableFields.length > 0) {
      event.preventDefault();
      setOpen(true);
      if (show) setHighlight((index) => (index + 1) % selectableFields.length);
      return;
    }
    if (event.key === "ArrowUp" && selectableFields.length > 0) {
      event.preventDefault();
      setOpen(true);
      setHighlight((index) => (show ? (index - 1 + selectableFields.length) % selectableFields.length : selectableFields.length - 1));
      return;
    }
    if (event.key === "Enter") {
      const selected = show ? selectableFields[highlight] : undefined;
      if (!selected && !value.trim()) return;
      event.preventDefault();
      event.stopPropagation();
      if (selected) pick(selected);
      else {
        onAdd(value);
        setOpen(false);
      }
      return;
    }
    if (event.key === "Escape" && show) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          role="combobox"
          aria-label="Add custom property path"
          aria-autocomplete="list"
          aria-expanded={show}
          aria-controls={show ? listId : undefined}
          aria-activedescendant={show && selectableFields[highlight] ? `${listId}-option-${highlight}` : undefined}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="mono min-w-0 flex-1 rounded-md border border-(--border) bg-(--surface-0) px-2 py-1 text-[11px] text-(--text) outline-none placeholder:text-(--text-faint) focus:border-(--border-strong)"
        />
        <button
          type="button"
          disabled={!value.trim()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onAdd(value);
            setOpen(false);
          }}
          className="cursor-pointer rounded-md border border-(--border) bg-(--surface-2) px-2 py-1 text-[11px] font-medium text-(--text-dim) hover:bg-(--surface-3) hover:text-(--text) disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Add
        </button>
      </div>

      {show && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Discovered property paths"
          className="mt-1 max-h-60 w-full overflow-auto rounded-md border border-(--border-strong) bg-(--surface-1) p-1 text-[11px] shadow-xl outline-none"
        >
          {indexedGroups.map((group) => (
            <li key={group.root} role="presentation">
              <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide text-(--text-faint) uppercase">
                {group.root}
              </div>
              <ul role="group" aria-label={`${group.root} fields`}>
                {group.fields.map(({ field, index }) => (
                  <li
                    key={field.path}
                    id={`${listId}-option-${index}`}
                    role="option"
                    aria-selected={index === highlight}
                    aria-label={`${field.path}, ${field.sampleValue}, ${field.occurrenceCount} ${field.occurrenceCount === 1 ? "row" : "rows"}`}
                    title={`${field.path} — sample: ${field.sampleValue} — ${field.occurrenceCount} rows`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(field);
                    }}
                    className={`cursor-pointer rounded px-2 py-1 select-none ${
                      index === highlight
                        ? "bg-(--surface-3) text-(--text)"
                        : "text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
                    }`}
                  >
                    <div className="mono truncate">{field.path}</div>
                    <div className="flex items-center justify-between gap-2 text-[10px] text-(--text-faint)">
                      <span className="truncate">{field.sampleValue}</span>
                      <span className="shrink-0">{field.occurrenceCount} {field.occurrenceCount === 1 ? "row" : "rows"}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {showNotSeenHint && (
        <div role="status" className="mt-1 text-[10px] text-(--text-faint)">
          not seen in loaded items; the column will show — until a row has it
        </div>
      )}
    </div>
  );
}

export function DisplayOptions<T>({
  config,
  state,
  onChange,
  onExport,
  rows,
}: {
  config: DisplayConfig<T>;
  state: DisplayState;
  onChange: (next: DisplayState | ((state: DisplayState) => DisplayState)) => void;
  onExport?: () => void;
  rows?: T[];
}) {
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstFocusRef = useRef<HTMLButtonElement>(null);
  const groupId = useId();
  const subId = useId();
  const orderId = useId();

  // 'v' key toggles/opens the popover when not typing
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (goPrefixActive()) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "v" && !open) {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // The open panel is a light modal: the list's j/k/Enter verbs stand down,
  // Esc closes the panel (not the selection), outside click dismisses.
  useEffect(() => {
    if (!open) return;
    modal.depth += 1;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const openNestedPopup = rootRef.current?.querySelector(
        '[aria-label="Add custom property path"][aria-expanded="true"], [data-display-listbox-trigger][aria-expanded="true"]',
      );
      if (openNestedPopup && e.target === openNestedPopup) return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      modal.depth -= 1;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  useEffect(() => {
    if (open) firstFocusRef.current?.focus();
  }, [open]);

  const customized = !isDefaultDisplayState(config, state);
  const activeGroup = config.groups.find((g) => g.key === state.groupBy);
  const subOptions = (config.subGroups ?? []).filter((k) => k !== state.groupBy);
  const toggleable = config.columns.filter((c) => !c.always);
  const groupLabel = (key: string) =>
    config.groups.find((g) => g.key === key)?.label ?? key;

  const discoveredFields = useMemo(() => {
    if (!open || !rows?.length) return [];
    return discoverPayloadFields(rows, state.customColumns);
  }, [open, rows, state.customColumns]);

  const discoveredPlaceholder = useMemo(() => {
    const examples = groupDiscoveredFields(discoveredFields)
      .slice(0, 2)
      .map((group) => group.fields[0]?.path)
      .filter(Boolean);
    return examples.length > 0 ? `e.g. ${examples.join(", ")}` : "Enter a property path";
  }, [discoveredFields]);

  const handleAddCustom = (pathToAdd?: string) => {
    const target = (pathToAdd ?? customInput).trim();
    if (!target) return;
    onChange((s) => addCustomColumn(s, target));
    setCustomInput("");
  };

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
        <span aria-hidden="true" className="mono ml-1 text-(--text-faint) text-[10px]">v</span>
        {customized && (
          <span aria-hidden className="size-1.5 rounded-full bg-(--accent)" title="Display options customized" />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Display options"
          className="absolute right-0 top-full z-30 mt-1.5 w-80 max-h-[85vh] overflow-y-auto rounded-lg border border-(--border-strong) bg-(--surface-1) p-3 shadow-2xl"
        >
          <OptionRow label="Grouping" htmlFor={groupId}>
            <ListboxSelect
              id={groupId}
              ref={firstFocusRef}
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
              <ListboxSelect
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
              <ListboxSelect
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
                  { value: DEFAULT_ORDER, label: "Default order" },
                  ...config.sorts.map((f) => ({ value: f.key, label: f.label })),
                  ...(state.customColumns ?? []).map((path) => ({
                    value: `custom:${path}`,
                    label: path,
                  })),
                ]}
              />
              <div
                role="group"
                aria-label="Ordering direction"
                className="inline-flex shrink-0 items-center rounded-md border border-(--border) bg-(--surface-0) p-0.5"
              >
                {(["asc", "desc"] as const).map((direction) => {
                  const pressed = state.sortDir === direction;
                  return (
                    <button
                      key={direction}
                      type="button"
                      aria-pressed={pressed}
                      aria-label={direction === "asc" ? "Ascending order" : "Descending order"}
                      onClick={() => onChange((s) => ({ ...s, sortDir: direction }))}
                      className={`cursor-pointer rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                        pressed
                          ? "bg-(--surface-2) text-(--text) shadow-sm"
                          : "text-(--text-faint) hover:text-(--text-dim)"
                      }`}
                    >
                      <span aria-hidden>{direction === "asc" ? "↑" : "↓"}</span> {direction}
                    </button>
                  );
                })}
              </div>
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
                      className={`inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                        shown
                          ? "border-(--border-strong) bg-(--surface-2) text-(--text)"
                          : "border-(--border) bg-transparent hover:bg-(--surface-2)"
                      }`}
                      style={shown ? undefined : { color: "var(--text-muted, var(--text-faint))" }}
                    >
                      {shown && <span aria-hidden className="text-(--accent)">✓</span>}
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* Dynamic / Payload Custom Columns (WM-214) */}
          <GroupLabel>Custom columns</GroupLabel>
          {(state.customColumns?.length ?? 0) > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {state.customColumns.map((path) => {
                const colKey = `custom:${path}`;
                const shown = !state.hiddenColumns.includes(colKey);
                return (
                  <div
                    key={path}
                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${
                      shown
                        ? "border-(--border-strong) bg-(--surface-3) text-(--text)"
                        : "border-(--border) text-(--text-faint)"
                    }`}
                  >
                    <button
                      type="button"
                      title={shown ? "Hide column" : "Show column"}
                      onClick={() =>
                        onChange((s) => ({
                          ...s,
                          hiddenColumns: shown
                            ? [...s.hiddenColumns, colKey]
                            : s.hiddenColumns.filter((k) => k !== colKey),
                        }))
                      }
                      className="cursor-pointer font-medium hover:underline"
                    >
                      {path}
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove column ${path}`}
                      title="Remove column"
                      onClick={() => onChange((s) => removeCustomColumn(s, path))}
                      className="cursor-pointer text-(--text-faint) hover:text-(--text)"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <DiscoveredFieldSuggestInput
            value={customInput}
            fields={discoveredFields}
            placeholder={discoveredPlaceholder}
            onChange={setCustomInput}
            onAdd={handleAddCustom}
          />

          {(onExport || customized) && (
            <div className="mt-3 flex items-center justify-between border-t border-(--border) pt-2">
              {onExport ? (
                <button
                  type="button"
                  onClick={() => {
                    onExport();
                  }}
                  className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium text-(--text-dim) hover:bg-(--surface-2) hover:text-(--text)"
                >
                  Export JSON
                </button>
              ) : (
                <span />
              )}
              {customized && (
                <button
                  type="button"
                  onClick={() => onChange({ ...defaultDisplayState(config), collapsed: [] })}
                  className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] text-(--text-faint) hover:bg-(--surface-2) hover:text-(--text)"
                >
                  Reset to defaults
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
