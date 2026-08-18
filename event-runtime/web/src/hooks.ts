import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { notify } from "./components/ui";
import { goPrefixActive } from "./goSequence";
import {
  loadDisplayState,
  saveDisplayState,
  type DisplayConfig,
  type DisplayState,
  type Section as DisplaySection,
} from "./displayOptions";
import type { HashWriter } from "./hash";
import {
  createHashWriter,
  hashSearch,
  parseHash,
  setActiveHashWriter,
  shouldReplaceHash,
} from "./hash";

/** Open-modal depth: global list-navigation keys stand down while a dialog is up. */
export const modal = { depth: 0 };

const HIDDEN_REFETCH_INTERVAL = 15_000;

function pollingOptions(visibleInterval: number) {
  return {
    refetchInterval: () =>
      typeof document !== "undefined" && document.hidden
        ? HIDDEN_REFETCH_INTERVAL
        : visibleInterval,
    // The interval callback backs hidden tabs off explicitly. Keeping the
    // observer active lets it recompute that cadence after the next tick;
    // TanStack Query's visibility listener refetches active queries as soon
    // as the tab becomes visible again, even if a hidden poll just refreshed
    // one and left it temporarily fresh.
    refetchIntervalInBackground: true as const,
    refetchOnWindowFocus: "always" as const,
  };
}

/** Shared collection polling policy: one live primary plus slower joins. */
export const refetchIntervals = {
  primary: pollingOptions(2_000),
  fast: pollingOptions(5_000),
  secondary: pollingOptions(10_000),
} as const;

/** True when a global shortcut should be ignored (typing, or a modal is open). */
export function keyGuard(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && t.closest("input, textarea, select, [contenteditable=true]")) return true;
  return modal.depth > 0;
}

/**
 * Hash routing: "#/runs/run_01" → ["runs", "run_01"]. Default view: overview.
 *
 * Query-only hash updates (or same-path query changes) depend on producing a
 * new route array identity `[...segments]` so React component effects and
 * state updates trigger re-renders properly.
 */
export function useHashRoute(): [string[], (path: string) => void] {
  const read = () => parseHash(window.location.hash);
  const [route, setRoute] = useState<string[]>(read);
  // Query-only hash changes (`#/events?type=`) keep the same path segments;
  // tick so readers of window.location.hash re-render.
  const [, setHash] = useState(window.location.hash);
  // Held j/k writes the URL at most once per interval, so the URL is not the
  // current route while a key is down — this is.
  const intended = useRef(window.location.hash);
  const writer = useRef<HashWriter | null>(null);
  if (!writer.current) {
    writer.current = createHashWriter((hash, replace) => {
      if (!replace) {
        window.location.hash = hash;
        return;
      }
      history.replaceState(
        history.state,
        "",
        `${window.location.pathname}${window.location.search}${hash}`,
      );
      // replaceState does not fire hashchange — tick readers of the URL itself.
      setHash(window.location.hash);
    });
  }
  useEffect(() => {
    setActiveHashWriter(writer.current);
    const onChange = () => {
      // Back, or a view writing window.location.hash directly: the URL is
      // authoritative again, and a buffered write would clobber it.
      writer.current?.cancel();
      intended.current = window.location.hash;
      setRoute(read());
      setHash(window.location.hash);
    };
    const onPageHide = () => {
      writer.current?.flush();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        writer.current?.flush();
      }
    };
    window.addEventListener("hashchange", onChange);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      writer.current?.cancel();
      setActiveHashWriter(null);
    };
  }, []);
  const navigate = useCallback((path: string) => {
    const next = `#/${path}`;
    if (intended.current === next) return;
    const replace = shouldReplaceHash(intended.current, path);
    // App reads `?type=` off window.location.hash as it renders, so a query
    // change cannot sit buffered; only same-view path moves (j/k) coalesce.
    const queryChanged = hashSearch(intended.current).toString() !== hashSearch(next).toString();
    intended.current = next;
    setRoute(parseHash(next));
    setHash(next);
    const write = writer.current;
    if (!write) return;
    if (!replace) {
      write.push(next);
      return;
    }
    write.replace(next);
    if (queryChanged) write.flush();
  }, []);
  return [route.length ? route : ["overview"], navigate];
}

/**
 * j/k + Enter/Escape list navigation (webui spec §5). `keys` maps extra
 * single keys (e.g. "a" approve) to handlers, active only with a selection.
 */
export function useListKeys(opts: {
  count: number;
  selected: number;
  onSelect: (index: number) => void;
  onOpen?: () => void;
  onClose?: () => void;
  keys?: Record<string, () => void>;
}) {
  const { count, selected, onSelect, onOpen, onClose, keys } = opts;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      // `g o` must navigate, not also fire a view's `o` verb: while the `g`
      // chord prefix is armed, every single-key list verb stands down.
      if (goPrefixActive()) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (count) onSelect(Math.min(selected + 1, count - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (count) onSelect(Math.max(selected - 1, 0));
      } else if ((e.key === "Enter" || e.key === "o") && onOpen) {
        e.preventDefault();
        onOpen();
      } else if (e.key === "Escape" && onClose) {
        onClose();
      } else if (keys && keys[e.key] && selected >= 0) {
        e.preventDefault();
        keys[e.key]();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, selected, onSelect, onOpen, onClose, keys]);
}

export type TableToken<T> = [row: T] | [section: DisplaySection<T>, sub: boolean];

/** Flatten table rows and group headers into their exact DOM order. */
export function tableTokens<T>(sections: DisplaySection<T>[], collapsed: readonly string[], grouped: boolean) {
  if (!grouped) return (sections[0]?.rows ?? []).map((row): TableToken<T> => [row]);
  const closed = new Set(collapsed);
  const out: TableToken<T>[] = [];
  for (const section of sections) {
    out.push([section, false]);
    if (closed.has(section.key)) continue;
    if (!section.subsections) out.push(...section.rows.map((row): TableToken<T> => [row]));
    else for (const child of section.subsections) {
      out.push([child, true]);
      if (!closed.has(child.key)) out.push(...child.rows.map((row): TableToken<T> => [row]));
    }
  }
  return out;
}

/** Repeat a page's group ancestry so a window never starts with contextless rows. */
function sliceTableWindow<T>(tokens: TableToken<T>[], start: number, end: number) {
  const page = tokens.slice(start, end);
  if (start && (page[0].length === 1 || page[0][1])) {
    // Only the page's own ancestry belongs here: at most one sub header (the
    // row's) plus its parent. Unshifting every header walked past would render
    // earlier sub headers with zero rows beneath them.
    let haveSub = page[0].length === 2 && page[0][1];
    for (start--; start >= 0; start--) {
      const token = tokens[start];
      if (token.length !== 2) continue;
      if (token[1]) {
        if (haveSub) continue;
        page.unshift(token);
        haveSub = true;
      } else {
        page.unshift(token);
        break;
      }
    }
  }
  return page;
}

/** Keep a 100-token DOM window while selection still addresses the full list. */
export function useTableWindow<T>(
  tokens: TableToken<T>[],
  selectedKey: string | null,
  rowKey: (row: T) => string,
  resetKey: unknown,
) {
  const selected = tokens.findIndex((token) => token.length === 1 && rowKey(token[0]) === selectedKey);
  const [start, setStart] = useState(0);
  const count = tokens.length;
  const max = count ? Math.floor((count - 1) / 100) * 100 : 0;
  const safe = Math.min(start, max);
  const end = Math.min(safe + 100, count);
  useEffect(() => setStart((value) => Math.min(value, max)), [max]);
  useEffect(() => {
    setStart(selected < 0 ? 0 : Math.floor(selected / 100) * 100);
  }, [selected, resetKey]);
  return [
    sliceTableWindow(tokens, safe, end),
    safe,
    end,
    (direction: number) => setStart(Math.max(0, Math.min(max, safe + direction * 100))),
  ] as const;
}

/**
 * Marks the context strip's tablist. The strip renders above every view and its
 * tabs are `role="tab"` too, so `[` / `]` scroll-into-view has to skip them to
 * reach the view's own status tabs.
 */
export const CONTEXT_TABS_ATTR = "data-context-tabs";

/** The selected status tab of the current view — never a context-strip tab. */
function selectedStatusTab(): HTMLElement | null {
  const strip = document.querySelector(`[${CONTEXT_TABS_ATTR}]`);
  const selected = document.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"]');
  for (const tab of selected) if (!strip?.contains(tab)) return tab;
  return null;
}

/** `[` / `]` cycle a view's status tabs (Linear's issue-state keys). */
export function useTabKeys<T extends string>(
  tabs: readonly T[],
  current: T,
  onSelect: (tab: T) => void,
) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "[" && e.key !== "]") return;
      e.preventDefault();
      const i = tabs.indexOf(current);
      if (i < 0) return;
      const delta = e.key === "]" ? 1 : -1;
      onSelect(tabs[(i + delta + tabs.length) % tabs.length]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, current, onSelect]);
  useEffect(() => {
    selectedStatusTab()?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [current]);
}

/**
 * Per-view display options (OPS-493), persisted like the theme: localStorage
 * under `evrt-display-<view>`. A view that swaps configs (Proposals'
 * open/history tabs) gets the new view's persisted state on the same render —
 * the reset-during-render pattern, so no frame shows tab A's grouping on tab
 * B's rows.
 */
export function useDisplayOptions<T>(
  config: DisplayConfig<T>,
): [DisplayState, (next: DisplayState | ((state: DisplayState) => DisplayState)) => void] {
  const [state, setState] = useState<DisplayState>(() => loadDisplayState(config));
  const [prevView, setPrevView] = useState(config.view);
  if (prevView !== config.view) {
    setPrevView(config.view);
    setState(loadDisplayState(config));
  }
  const configRef = useRef(config);
  configRef.current = config;
  const update = useCallback(
    (next: DisplayState | ((state: DisplayState) => DisplayState)) => {
      setState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        saveDisplayState(configRef.current, value);
        return value;
      });
    },
    [],
  );
  return [state, update];
}

export const THEMES = ["dark", "light", "contrast"] as const;
export type Theme = (typeof THEMES)[number];

function isTheme(value: string | null): value is Theme {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

/** Theme state on <html data-theme>; dark is the default (spec §5.1). */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("evrt-theme");
    return isTheme(stored) ? stored : "dark";
  });
  useEffect(() => {
    if (theme === "dark") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem("evrt-theme", theme);
  }, [theme]);
  const cycle = useCallback(
    () => setTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]),
    [],
  );
  return [theme, cycle];
}

/** Ticks every second — drives TTL countdowns and relative timestamps. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * A transient modal can name the live element that should stand in for focus
 * captured inside it. This matters when selecting a command closes the palette
 * and mounts another dialog in the same commit: during render the palette input
 * is still active, but it is about to be detached.
 */
const focusReturnScopes = new WeakMap<HTMLElement, HTMLElement>();

export function registerFocusReturnScope(
  root: HTMLElement,
  returnTarget: HTMLElement | null,
): () => void {
  if (returnTarget) focusReturnScopes.set(root, returnTarget);
  return () => focusReturnScopes.delete(root);
}

function resolveFocusReturn(active: HTMLElement): HTMLElement {
  let node: HTMLElement | null = active;
  while (node) {
    const target = focusReturnScopes.get(node);
    if (target) return target;
    node = node.parentElement;
  }
  return active;
}

/**
 * Preserves the active element on mount and restores keyboard focus on unmount.
 * An enclosing focus-return scope may substitute a live opener for a transient
 * active element. Handles edge cases when the target is no longer in the DOM.
 */
export function useFocusReturn(): void {
  const previousRef = useRef<HTMLElement | null>(null);
  if (previousRef.current === null && typeof document !== "undefined") {
    previousRef.current =
      document.activeElement instanceof HTMLElement
        ? resolveFocusReturn(document.activeElement)
        : null;
  }
  useEffect(() => {
    const previous = previousRef.current;
    return () => {
      if (previous && (previous.isConnected ?? document.contains(previous))) {
        try {
          previous.focus();
        } catch {
          // Ignore focus errors on detached/unsupported elements
        }
      }
    };
  }, []);
}

export type RequeueTarget = { source: string; eventId: string };

/**
 * Poll for an open proposal after an event is requeued (OPS-293).
 * Runs an 8s loop polling `GET /proposals` every 250ms for an open proposal
 * matching `{ eventSource, eventId }`.
 * - Match found: calls `onJumpProposal(proposal.id)`.
 * - Loop expires without match: shows info toast "Requeued <eventId> — no open proposal appeared".
 * - Error thrown during poll: shows error toast "Requeued <eventId> — could not confirm a proposal appeared".
 * Cancels polling if the component unmounts before completion.
 */
export function useRequeuePoll(onJumpProposal: (proposalId: string) => void) {
  const alive = useRef(true);
  const jumpRef = useRef(onJumpProposal);
  jumpRef.current = onJumpProposal;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  return useCallback(
    async (
      targetOrSource: RequeueTarget | string,
      maybeEventId?: string,
    ): Promise<void> => {
      const { source, eventId } =
        typeof targetOrSource === "string"
          ? { source: targetOrSource, eventId: maybeEventId! }
          : targetOrSource;
      const deadline = Date.now() + 8000;
      try {
        while (alive.current && Date.now() < deadline) {
          const { proposals } = await api.proposals();
          const match = proposals.find(
            (p) => p.eventSource === source && p.eventId === eventId,
          );
          if (match && alive.current) {
            jumpRef.current(match.id);
            return;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        // The requeue itself landed; only the confirmation poll broke, so say
        // that rather than claiming no proposal appeared.
        if (alive.current) {
          notify(`Requeued ${eventId} — could not confirm a proposal appeared`, "err");
        }
        return;
      }
      if (alive.current) {
        notify(`Requeued ${eventId} — no open proposal appeared`, "info");
      }
    },
    [],
  );
}
