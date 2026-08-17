import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  CHUNK_RELOAD_STORAGE_KEY,
  ErrorBoundary,
  claimChunkReload,
  isChunkLoadError,
} from "./ErrorBoundary";

afterEach(cleanup);

function chunkFailure() {
  return new TypeError(
    "Failed to fetch dynamically imported module: http://127.0.0.1:7667/assets/Proposals-stale.js",
  );
}

function BrokenRoute({ error = chunkFailure() }: { error?: Error }): null {
  throw error;
}

describe("chunk-load recovery", () => {
  test("recognizes browser and bundler chunk-load failures", () => {
    expect(isChunkLoadError(chunkFailure())).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error("chunk missing"), { name: "ChunkLoadError" }))).toBe(
      true,
    );
    expect(isChunkLoadError(new Error("ordinary render failure"))).toBe(false);
  });

  test("claims only one automatic reload for the same route and failure window", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const error = chunkFailure();

    expect(claimChunkReload(error, storage, "/#/proposals", 1_000)).toBe(true);
    expect(claimChunkReload(error, storage, "/#/proposals", 1_001)).toBe(false);
    expect(claimChunkReload(error, storage, "/#/agents", 1_001)).toBe(true);
    expect(values.has(CHUNK_RELOAD_STORAGE_KEY)).toBe(true);
  });

  test("reloads exactly once, then renders the text fallback on a repeated failure", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    let reloads = 0;
    const reload = () => {
      reloads += 1;
    };

    const first = render(
      <ErrorBoundary storage={storage} route="/#/proposals" now={() => 1_000} reload={reload}>
        <BrokenRoute />
      </ErrorBoundary>,
    );
    await waitFor(() => expect(reloads).toBe(1));
    expect(first.getByRole("alert").textContent).toContain("Refreshing this tab once");
    first.unmount();

    const second = render(
      <ErrorBoundary storage={storage} route="/#/proposals" now={() => 1_001} reload={reload}>
        <BrokenRoute />
      </ErrorBoundary>,
    );
    await waitFor(() => {
      expect(second.getByRole("heading", { name: "New version deployed" })).toBeTruthy();
    });
    expect(second.getByRole("alert").textContent).toContain(
      "This tab could not load the updated files. Reload to try again.",
    );
    expect(second.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(reloads).toBe(1);
  });
});
