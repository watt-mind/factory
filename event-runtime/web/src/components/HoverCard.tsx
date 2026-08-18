/**
 * Hover card primitive (WM-700).
 *
 * A hover-only card is a mouse-only card: the operator who drives the console
 * from the keyboard never sees it. This primitive opens on hover *and* on
 * focus, answers Escape by closing and handing focus back, and dismisses
 * itself the moment the table underneath scrolls — a portalled panel pinned to
 * viewport coordinates would otherwise float away from the row it describes.
 *
 * Callers supply the trigger and the panel body; the panel is portalled to
 * `document.body` so a row's `overflow: hidden` cannot clip it — which is also
 * why Tab at the card's edges has to be steered back to the trigger, since the
 * portal puts the panel's tab stops after everything else in the document.
 */
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/** Hover dwell before opening — long enough that crossing a row does nothing. */
export const OPEN_MS = 180;
/** Grace before closing, so the pointer can cross the gap into the panel. */
export const CLOSE_MS = 150;

/** Default panel width; the collision math needs a number before layout. */
export const HOVER_CARD_WIDTH = 320;
/** Height estimate used only to decide above/below before the panel exists. */
export const HOVER_CARD_HEIGHT = 220;
/** Keep-clear distance from the viewport edge. */
export const VIEWPORT_MARGIN = 12;
/** Gap between the trigger and the panel. */
export const TRIGGER_GAP = 8;

const FOCUSABLE = "a[href],button,input,select,textarea,[tabindex]";

/**
 * Return the controls the browser can actually reach with Tab, in tab order.
 * querySelectorAll alone also returns controls hidden by an ancestor, controls
 * under `inert`, and descendants of closed details elements. It also keeps DOM
 * order even though positive tabindex values are visited first.
 */
function getTabbableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((candidate) => {
      if (candidate.tabIndex < 0 || candidate.matches(":disabled")) {
        return false;
      }

      for (
        let current: HTMLElement | null = candidate;
        current && root.contains(current);
        current = current.parentElement
      ) {
        if (current.hidden || current.hasAttribute("inert")) return false;
        const style = window.getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.contentVisibility === "hidden"
        ) {
          return false;
        }

        if (current instanceof HTMLDetailsElement && !current.open) {
          const summary = Array.from(current.children).find(
            (child): child is HTMLElement =>
              child instanceof HTMLElement && child.tagName === "SUMMARY",
          );
          if (!summary?.contains(candidate)) return false;
        }
      }
      return true;
    })
    .map((element, domOrder) => ({ element, domOrder }))
    .sort((a, b) => {
      const aTabIndex = a.element.tabIndex;
      const bTabIndex = b.element.tabIndex;
      if (aTabIndex === bTabIndex) return a.domOrder - b.domOrder;
      if (aTabIndex === 0) return 1;
      if (bTabIndex === 0) return -1;
      return aTabIndex - bTabIndex;
    })
    .map(({ element }) => element);
}

interface OpenHoverCard {
  owner: object;
  close: () => void;
}

/** The card primitive is a singleton layer, even across separate React roots. */
let openHoverCard: OpenHoverCard | null = null;

/** Never squeeze the panel below this; scroll it instead. */
export const MIN_PANEL_HEIGHT = 120;

export interface HoverCardPlacement {
  /** Anchor y: the panel's top edge below, or its bottom edge above. */
  top: number;
  left: number;
  placeAbove: boolean;
  /** Room on the chosen side, so a tall card scrolls instead of overflowing. */
  maxHeight: number;
}

/**
 * Clamp the panel inside the viewport and flip it above the trigger when the
 * space below cannot hold it. When neither side fits, take the roomier one —
 * a clipped card is still readable, a card drawn off-screen is not.
 */
export function computeHoverCardPosition(
  trigger: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number } = {
    width: HOVER_CARD_WIDTH,
    height: HOVER_CARD_HEIGHT,
  },
): HoverCardPlacement {
  let left = trigger.left;
  if (left + size.width > viewport.width - VIEWPORT_MARGIN) {
    left = viewport.width - size.width - VIEWPORT_MARGIN;
  }
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

  const spaceBelow = viewport.height - trigger.bottom;
  const spaceAbove = trigger.top;
  const placeAbove =
    spaceBelow < size.height + TRIGGER_GAP && spaceAbove > spaceBelow;
  const top = placeAbove
    ? trigger.top - TRIGGER_GAP
    : trigger.bottom + TRIGGER_GAP;
  const room = (placeAbove ? spaceAbove : spaceBelow) - TRIGGER_GAP;
  return {
    top,
    left,
    placeAbove,
    maxHeight: Math.max(MIN_PANEL_HEIGHT, room - VIEWPORT_MARGIN),
  };
}

/** Reads the OS motion preference; false wherever `matchMedia` is missing. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** `prefers-reduced-motion`, kept current if the operator changes it mid-session. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    if (typeof query.addEventListener !== "function") return;
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export interface HoverCardApi {
  close: () => void;
}

export interface HoverCardProps {
  /** Accessible name of the panel — it is a dialog, so it needs one. */
  label: string;
  /** What the operator hovers or focuses; the function form receives `close`. */
  trigger: ReactNode | ((api: HoverCardApi) => ReactNode);
  /** Panel body. The function form receives `close` for in-panel actions. */
  children: ReactNode | ((api: HoverCardApi) => ReactNode);
  /**
   * Whether the wrapper is its own tab stop. Pass false when `trigger` already
   * renders a button or link: two tab stops for one thing is worse than none,
   * and focus still bubbles to the wrapper's handlers either way.
   */
  focusable?: boolean;
  className?: string;
  panelClassName?: string;
  width?: number;
  /** Height estimate for the above/below decision before the panel renders. */
  estimatedHeight?: number;
  openDelayMs?: number;
  closeDelayMs?: number;
  onOpenChange?: (open: boolean) => void;
}

export function HoverCard({
  label,
  trigger,
  children,
  focusable = true,
  className,
  panelClassName,
  width = HOVER_CARD_WIDTH,
  estimatedHeight = HOVER_CARD_HEIGHT,
  openDelayMs = OPEN_MS,
  closeDelayMs = CLOSE_MS,
  onOpenChange,
}: HoverCardProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<HoverCardPlacement>({
    top: 0,
    left: 0,
    placeAbove: false,
    maxHeight: HOVER_CARD_HEIGHT,
  });
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownerRef = useRef<object>({});
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const focusPanelRef = useRef(false);
  const suppressFocusOpenRef = useRef(false);
  const notifiedRef = useRef(open);
  const [dismissals, setDismissals] = useState(0);
  const panelId = useId();
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (notifiedRef.current === open) return;
    notifiedRef.current = open;
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const reposition = useCallback(() => {
    const el = wrapperRef.current;
    if (!el?.getBoundingClientRect) return;
    const rect = el.getBoundingClientRect();
    setPlacement(
      computeHoverCardPosition(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width, height: estimatedHeight },
      ),
    );
  }, [width, estimatedHeight]);

  /**
   * Touches state only, so it is safe to hand to a caller's render prop. The
   * pending open timer is cancelled by the effect below rather than here: a
   * function that reads a ref must not be callable during render.
   */
  const close = useCallback(() => {
    setOpen(false);
    setDismissals((n) => n + 1);
  }, []);

  const openNow = useCallback(() => {
    clearTimer();
    if (openHoverCard?.owner !== ownerRef.current) openHoverCard?.close();
    openHoverCard = { owner: ownerRef.current, close };
    reposition();
    setOpen(true);
  }, [clearTimer, close, reposition]);

  useEffect(() => {
    if (dismissals > 0) clearTimer();
  }, [dismissals, clearTimer]);

  useEffect(() => {
    if (!open && openHoverCard?.owner === ownerRef.current)
      openHoverCard = null;
  }, [open]);

  const scheduleOpen = useCallback(() => {
    clearTimer();
    if (openDelayMs <= 0) {
      openNow();
      return;
    }
    timerRef.current = setTimeout(openNow, openDelayMs);
  }, [clearTimer, openDelayMs, openNow]);

  /**
   * Deferred and re-checked on fire: a blur arrives *before* the focusin that
   * caused it, so "did focus leave the card?" can only be answered afterwards.
   * Focus that landed inside the trigger or the panel keeps the card open.
   */
  const scheduleClose = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        const active = document.activeElement as Node | null;
        const inside =
          (active != null && panelRef.current?.contains(active)) ||
          (active != null && wrapperRef.current?.contains(active));
        if (inside) return;
        close();
      },
      Math.max(0, closeDelayMs),
    );
  }, [clearTimer, close, closeDelayMs]);

  /**
   * Hand focus back to the trigger without reopening: the focus event this
   * fires is ours, not the operator's, and Escape must mean the card stays shut.
   */
  const restoreFocus = useCallback(() => {
    const previous = lastFocusRef.current;
    const target = previous?.isConnected ? previous : wrapperRef.current;
    if (!target) return;
    suppressFocusOpenRef.current = true;
    target.focus();
    queueMicrotask(() => {
      suppressFocusOpenRef.current = false;
    });
  }, []);

  useEffect(
    () => () => {
      clearTimer();
      if (openHoverCard?.owner === ownerRef.current) openHoverCard = null;
    },
    [clearTimer],
  );

  /**
   * Escape anywhere closes the card. When focus is inside it, the operator
   * meant *this* layer: swallow the key so an enclosing dialog does not close
   * behind it. A card merely left open under the pointer swallows nothing —
   * Escape there belongs to whatever the operator is actually working in.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      const inside =
        (panelRef.current?.contains(active as Node) ?? false) ||
        (wrapperRef.current?.contains(active as Node) ?? false);
      close();
      if (!inside) return;
      e.stopPropagation();
      restoreFocus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close, restoreFocus]);

  // The panel is pinned to viewport coordinates, so any scroll that is not the
  // panel's own would leave it describing a row that has moved on.
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      const active = document.activeElement;
      if (active && panelRef.current?.contains(active)) restoreFocus();
      close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, close, reposition, restoreFocus]);

  /** Focus the first tabbable in the mounted panel. False if it is not there yet. */
  const focusPanel = useCallback(() => {
    const root = panelRef.current;
    if (!root) return false;
    const first = getTabbableElements(root)[0];
    (first ?? root).focus();
    return true;
  }, []);

  // ArrowDown means "take me into the card", so land focus there once it exists.
  useEffect(() => {
    if (!open || !focusPanelRef.current) return;
    focusPanelRef.current = false;
    focusPanel();
  }, [open, focusPanel]);

  const onTriggerFocus = useCallback(
    (e: ReactFocusEvent<HTMLSpanElement>) => {
      lastFocusRef.current = e.target as HTMLElement;
      if (suppressFocusOpenRef.current) return;
      scheduleOpen();
    },
    [scheduleOpen],
  );

  const onTriggerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLSpanElement>) => {
      // Enter is the inner link's own activation key; only claim it when the
      // wrapper itself holds focus and nothing else would act on it.
      const ownEnter = e.key === "Enter" && e.target === e.currentTarget;
      if (e.key !== "ArrowDown" && !ownEnter) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowDown") {
        // Already open after a Tab-edge return: `open` will not change, so the
        // effect above would not run. Focus now if the panel is mounted.
        if (!focusPanel()) focusPanelRef.current = true;
      }
      openNow();
    },
    [openNow, focusPanel],
  );

  /**
   * The panel is portalled, so React dispatches its events from
   * `document.body` — but the *native* event carries on to `window`, where the
   * table's `useListKeys` is listening. Without this, a second ArrowDown after
   * landing in the card silently moves the selected row underneath it. Only
   * propagation is stopped: the default is the panel's own scroll, which a card
   * taller than its `maxHeight` needs.
   *
   * Tab at either edge is a different leak: the portal sits at the end of
   * `document.body`, so the browser would step out of the document instead of
   * continuing from the trigger. Hand focus back there; Tab between two
   * in-card controls is the browser's to handle.
   */
  const onPanelKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.stopPropagation();
        return;
      }
      // Single-character keys (j/k/o, view verbs like a, Space) bind on
      // window via useListKeys. Stop them here so they do not fire under an
      // open card. Do not preventDefault: Space still activates the focused
      // control, and arrows stay scrollable. Tab, Escape, and Enter are not
      // length 1 — Tab is handled below, Escape by the window capture listener.
      if (e.key.length === 1) {
        e.stopPropagation();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const active = document.activeElement;
      // React events from a nested portal still bubble through this panel's
      // component tree, but its focused element is not one of the panel edges.
      if (!active || !root.contains(active)) return;
      const stops = getTabbableElements(root);
      // A card with nothing focusable holds focus on the panel itself, so
      // either direction is an edge. Otherwise only the far end is: forward
      // from the panel root still walks into the card, as the DOM order says.
      const atEdge =
        stops.length === 0 ||
        (e.shiftKey
          ? active === stops[0] || active === root
          : active === stops[stops.length - 1]);
      if (!atEdge) return;
      e.preventDefault();
      restoreFocus();
    },
    [restoreFocus],
  );

  const api: HoverCardApi = { close };
  const body = typeof children === "function" ? children(api) : children;
  const triggerBody = typeof trigger === "function" ? trigger(api) : trigger;

  const motion = reducedMotion
    ? ""
    : " transition-opacity duration-150 animate-in fade-in";

  return (
    <>
      <span
        ref={wrapperRef}
        tabIndex={focusable ? 0 : -1}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={onTriggerFocus}
        onBlur={scheduleClose}
        onKeyDown={onTriggerKeyDown}
        className={`inline-flex items-center outline-none focus-visible:ring-1 focus-visible:ring-(--accent) ${className ?? ""}`}
      >
        {triggerBody}
      </span>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            id={panelId}
            ref={panelRef}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            onMouseEnter={clearTimer}
            onMouseLeave={scheduleClose}
            onFocus={clearTimer}
            onBlur={scheduleClose}
            onKeyDown={onPanelKeyDown}
            style={{
              position: "fixed",
              top: placement.placeAbove ? undefined : `${placement.top}px`,
              bottom: placement.placeAbove
                ? `${window.innerHeight - placement.top}px`
                : undefined,
              left: `${placement.left}px`,
              width: `${width}px`,
              maxHeight: `${placement.maxHeight}px`,
              overflowY: "auto",
              zIndex: 9999,
            }}
            className={`rounded-lg border border-(--border-strong) bg-(--surface-1) p-3.5 shadow-xl text-[12px] text-(--text) select-text outline-none${motion} ${panelClassName ?? ""}`}
          >
            {body}
          </div>,
          document.body,
        )}
    </>
  );
}
