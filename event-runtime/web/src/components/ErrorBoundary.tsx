import { Component, type ErrorInfo, type ReactNode } from "react";

export const CHUNK_RELOAD_STORAGE_KEY = "factory.chunkReload";
const CHUNK_RELOAD_WINDOW_MS = 5 * 60 * 1000;

type ReloadMarker = {
  route: string;
  at: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "ChunkLoadError" ||
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk .+ failed/i.test(
      error.message,
    )
  );
}

function currentRoute(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/**
 * Atomically claims the one automatic reload allowed for a route's chunk
 * failure. Keeping the marker briefly across the reload prevents a broken
 * deployment from entering a reload loop; route changes and later deploys can
 * recover independently.
 */
export function claimChunkReload(
  error: unknown,
  storage: StorageLike,
  route: string,
  now = Date.now(),
): boolean {
  if (!isChunkLoadError(error)) return false;

  try {
    const raw = storage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    if (raw) {
      const previous = JSON.parse(raw) as Partial<ReloadMarker>;
      if (
        previous.route === route &&
        typeof previous.at === "number" &&
        now - previous.at < CHUNK_RELOAD_WINDOW_MS
      ) {
        return false;
      }
    }
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, JSON.stringify({ route, at: now }));
    return true;
  } catch {
    // Without a durable guard, an automatic reload could loop forever. Leave
    // the operator on the explicit fallback instead.
    return false;
  }
}

type Props = {
  children: ReactNode;
  reload?: () => void;
  storage?: StorageLike;
  route?: string;
  now?: () => number;
};

type State = {
  error: Error | null;
  reloading: boolean;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    const storage = this.props.storage ?? window.sessionStorage;
    const route = this.props.route ?? currentRoute();
    if (claimChunkReload(error, storage, route, this.props.now?.())) {
      this.setState({ reloading: true }, () => (this.props.reload ?? (() => window.location.reload()))());
    }
  }

  render() {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;

    const chunkFailure = isChunkLoadError(error);
    const title = chunkFailure ? "New version deployed" : "The control plane could not render";
    const detail = reloading
      ? "Refreshing this tab once to load the new version…"
      : chunkFailure
        ? "This tab could not load the updated files. Reload to try again."
        : "Reload the page to recover. If the problem continues, check the runtime logs.";

    return (
      <main className="flex min-h-screen items-center justify-center bg-(--surface-0) p-6 text-(--text)">
        <section role="alert" className="max-w-lg border-l-2 border-(--hue-warn) pl-4">
          <h1 className="display text-lg font-semibold">{title}</h1>
          <p className="mt-2 text-sm text-(--text-dim)">{detail}</p>
          {!reloading && (
            <button
              type="button"
              className="mt-4 rounded-md border border-(--border-strong) px-3 py-1.5 text-sm font-medium hover:bg-(--surface-2)"
              onClick={() => (this.props.reload ?? (() => window.location.reload()))()}
            >
              Reload
            </button>
          )}
        </section>
      </main>
    );
  }
}
