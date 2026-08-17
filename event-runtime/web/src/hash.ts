/**
 * Hash paths for the control plane. Selection lives in the hash so an
 * operator-pasted `#/runs/:id` survives refresh (OPS-230).
 *
 * `#/overview` `#/events` `#/events?type=` `#/events/:source/:eventId`
 * `#/proposals` `#/proposals/:id` `#/runs` `#/runs/:id` `#/run/:id` (the
 * full-page run view — distinct first segment so expand/back get push
 * semantics) `#/tickets` `#/tickets/:id` (the ticket journey; an id-less
 * route presents the ticket picker) `#/prs/:number` (the PR journey, WM-640 —
 * the same layout keyed on a pull request; reached from PR chips and ⌘K, not
 * the nav rail) `#/agents` `#/agents/:ref` `#/artifacts`
 * `#/artifacts?kind=…` `#/workers` `#/workers/:id` `#/graph` `#/graph/:nodeId`
 * `#/chain/:correlationId` `#/chain/:correlationId/:nodeId` (the chain trace,
 * WM-527 — a drill-in like `#/run/:id`, not a nav item)
 *
 * Optional `?project=` (OPS-356) restores the context-tab filter; `inflight`
 * is reserved. The path still names the view. A pasted `#/runs/:id` without
 * that query opens All.
 */

function pathAndQuery(hash: string): { path: string; query: string } {
  const trimmed = hash.replace(/^#\/?/, "");
  const i = trimmed.indexOf("?");
  return i >= 0
    ? { path: trimmed.slice(0, i), query: trimmed.slice(i + 1) }
    : { path: trimmed, query: "" };
}

export function parseHash(hash: string): string[] {
  return pathAndQuery(hash)
    .path.split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** First path segment; empty hash is the overview view. */
export function hashView(hash: string): string {
  return parseHash(hash)[0] ?? "overview";
}

/**
 * Same-view hash writes (j/k selection, closing a panel, type query) should
 * replace the current history entry. Crossing views (nav rail, `g e`) must
 * push so Back returns to the previous view.
 */
export function shouldReplaceHash(currentHash: string, nextPath: string): boolean {
  return hashView(currentHash) === hashView(`#/${nextPath}`);
}

/** Query after `?` in the hash (`#/events?type=…`). Empty when none. */
export function hashSearch(hash: string): URLSearchParams {
  return new URLSearchParams(pathAndQuery(hash).query);
}

/** Build a hash path; each id segment is encoded. */
export function hashPath(view: string, ...ids: Array<string | null | undefined>): string {
  const parts = [view];
  for (const id of ids) {
    if (id == null || id === "") continue;
    parts.push(encodeURIComponent(id));
  }
  return parts.join("/");
}

/**
 * Safari throws `SecurityError` past ~100 history writes per 30s, and a held
 * `j` fires ~30 keydowns a second — three seconds of hold used to break the
 * write and freeze the selection. One history write per interval keeps a
 * sustained hold an order of magnitude under the cap.
 */
export const HASH_WRITE_INTERVAL_MS = 500;

/** Clock + timer seam so the coalescing is testable without real time. */
export type HashWriteScheduler = {
  now: () => number;
  /** Runs `fn` after `ms`; the returned function cancels that pending run. */
  after: (fn: () => void, ms: number) => () => void;
};

export type HashWriter = {
  /** Same-view write: at most one per interval, last value wins. */
  replace: (hash: string) => void;
  /** View change: lands now, after any buffered same-view write. */
  push: (hash: string) => void;
  /** Write the buffered value now — for a change a reader must see at once. */
  flush: () => void;
  /** Drop the buffered value: the URL moved under us and it would clobber. */
  cancel: () => void;
};

let activeHashWriter: HashWriter | null = null;

/** Register the active writer so direct readers of the URL (copyLink) can flush. */
export function setActiveHashWriter(writer: HashWriter | null) {
  activeHashWriter = writer;
}

/** Write any buffered hash immediately to the URL. Safe no-op when none is active. */
export function flushHash() {
  activeHashWriter?.flush();
}

const timerScheduler: HashWriteScheduler = {
  now: () => Date.now(),
  after: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

/**
 * Rate-limits history writes. `write` gets the hash and whether it replaces;
 * the caller keeps its own idea of the current hash, because the URL trails
 * the intent by up to one interval while a key is held.
 */
export function createHashWriter(
  write: (hash: string, replace: boolean) => void,
  scheduler: HashWriteScheduler = timerScheduler,
  intervalMs: number = HASH_WRITE_INTERVAL_MS,
): HashWriter {
  let buffered: string | null = null;
  let cancelTimer: (() => void) | null = null;
  let wroteAt = -Infinity;

  const send = (hash: string, replace: boolean) => {
    wroteAt = scheduler.now();
    try {
      write(hash, replace);
    } catch {
      // A history-rate SecurityError must not escape into the keydown handler
      // that caused it: the selection has already moved, and the next write
      // once the browser's window rolls over lands the real URL.
    }
  };
  const drop = () => {
    cancelTimer?.();
    cancelTimer = null;
    buffered = null;
  };
  const flush = () => {
    const hash = buffered;
    drop();
    if (hash !== null) send(hash, true);
  };

  return {
    replace(hash) {
      const since = scheduler.now() - wroteAt;
      if (since >= intervalMs) {
        drop();
        send(hash, true);
        return;
      }
      buffered = hash;
      if (!cancelTimer) {
        cancelTimer = scheduler.after(() => {
          cancelTimer = null;
          flush();
        }, intervalMs - since);
      }
    },
    push(hash) {
      // Land the buffered selection first so Back returns to the row the
      // operator was actually on, not the one the last write happened to catch.
      flush();
      send(hash, false);
    },
    flush,
    cancel: drop,
  };
}

/** Events view hash, optionally with a shareable type filter. */
export function eventsHash(
  source?: string | null,
  eventId?: string | null,
  type?: string | null,
): string {
  const path = hashPath("events", source, eventId);
  return type ? `${path}?type=${encodeURIComponent(type)}` : path;
}

/** Shareable Artifacts view filters. Project context is added by `withProject`. */
export function artifactsHash(filters: {
  kind?: string | null;
  orphan?: boolean | null;
  search?: string | null;
} = {}): string {
  const query = new URLSearchParams();
  if (filters.kind) query.set("kind", filters.kind);
  if (filters.orphan != null) query.set("orphan", String(filters.orphan));
  if (filters.search) query.set("search", filters.search);
  const qs = query.toString();
  return qs ? `artifacts?${qs}` : "artifacts";
}

/** `?project=` on the hash — the context strip's active filter, not the view. */
export function hashProject(hash: string): string | null {
  return hashSearch(hash).get("project");
}

/**
 * Set or clear `project` on a hash path, preserving other query keys (`type=`).
 * `project` null/empty strips it so All has no query of its own.
 */
export function withProject(path: string, project: string | null | undefined): string {
  const i = path.indexOf("?");
  const pathname = i >= 0 ? path.slice(0, i) : path;
  const query = new URLSearchParams(i >= 0 ? path.slice(i + 1) : "");
  if (project) query.set("project", project);
  else query.delete("project");
  const qs = query.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
