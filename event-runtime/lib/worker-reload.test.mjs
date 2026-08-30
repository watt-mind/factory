import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-worker-reload-test-mjs";
import "../test-helpers.mjs";
import { describe, expect, test } from "bun:test";
import { loadAdjustedTimeout } from "./test-helpers-timing.mjs";

/**
 * Ceiling for the execute-side adapter spawn tests (WM-1025).
 *
 * These spawn a real CLI subprocess. 5s is comfortable on a quiet machine and
 * demonstrably not comfortable on a contended one: on 2026-08-22 four of these
 * timed out under concurrent runners and took WM-1008, WM-1015 and WM-534 out
 * of the queue with them — WM-1015 was a documentation-only diff that could
 * not merge because of it.
 *
 * `loadAdjustedTimeout` is the repo's existing answer (CI sets CI_LOAD_FACTOR,
 * capped at 4x). This file was simply not wired into it. Scaling a liveness
 * ceiling changes no assertion: every check below still waits on observable
 * state, so a real hang still fails, just not a slow host.
 */
const EXECUTE_SPAWN_TIMEOUT_MS = loadAdjustedTimeout(5_000);

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  CODE_RELOAD_EXIT,
  codeStamp,
  codeStampFiles,
  codeStampRoot,
  createReloadWatcher,
} from "./worker.mjs";
import { registerTestProcessCleanup } from "./test-helpers-process.mjs";

registerTestProcessCleanup(import.meta.url);

// ---------------------------------------------------------------------------
// Dev live-reload: code stamp + drain-aware reload watcher (WM-213)
// ---------------------------------------------------------------------------

function stampRepo() {
  const root = tmpDir("evrt-stamp-");
  mkdirSync(path.join(root, "event-runtime", "lib", "adapters"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "event-runtime", "cli.mjs"),
    "// cli\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "event-runtime", "lib", "worker.mjs"),
    "// worker\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "event-runtime", "lib", "adapters", "fake.mjs"),
    "// fake\n",
    "utf8",
  );
  writeFileSync(path.join(root, "README.md"), "# outside the stamp\n", "utf8");
  return root;
}

describe("code stamp (WM-213)", () => {
  test("covers event-runtime/lib/** and cli.mjs, and nothing else", () => {
    const root = stampRepo();
    try {
      expect(codeStampFiles(root)).toEqual([
        "event-runtime/cli.mjs",
        "event-runtime/lib/adapters/fake.mjs",
        "event-runtime/lib/worker.mjs",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is stable across calls and changes on an uncommitted edit", () => {
    const root = stampRepo();
    try {
      const before = codeStamp(root);
      expect(codeStamp(root)).toBe(before);

      // No commit, no git at all — the stamp must still notice a working-tree edit.
      writeFileSync(
        path.join(root, "event-runtime", "lib", "worker.mjs"),
        "// worker v2\n",
        "utf8",
      );
      const after = codeStamp(root);
      expect(after).not.toBe(before);

      // A new file under lib/ counts too, and a file outside the paths does not.
      writeFileSync(
        path.join(root, "event-runtime", "lib", "new.mjs"),
        "// new\n",
        "utf8",
      );
      expect(codeStamp(root)).not.toBe(after);
      const withNew = codeStamp(root);
      writeFileSync(path.join(root, "README.md"), "# edited\n", "utf8");
      expect(codeStamp(root)).toBe(withNew);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tree with no git still stamps (nogit), rather than throwing", () => {
    const root = stampRepo();
    try {
      expect(codeStamp(root).startsWith("nogit:")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FACTORY_CODE_STAMP_ROOT overrides the watched checkout", () => {
    const root = stampRepo();
    const previous = process.env.FACTORY_CODE_STAMP_ROOT;
    try {
      process.env.FACTORY_CODE_STAMP_ROOT = root;
      expect(codeStampRoot()).toBe(root);
      expect(codeStamp()).toBe(codeStamp(root));
    } finally {
      if (previous === undefined) delete process.env.FACTORY_CODE_STAMP_ROOT;
      else process.env.FACTORY_CODE_STAMP_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reload watcher (WM-213)", () => {
  /** Watcher over a stamp and clock the test drives by hand. */
  function harness(intervalMs = 1000) {
    let stamp = "a";
    let clock = 0;
    const watcher = createReloadWatcher({
      intervalMs,
      stamp: () => stamp,
      now: () => clock,
    });
    return {
      watcher,
      change: (to) => {
        stamp = to;
      },
      advance: (ms) => {
        clock += ms;
      },
    };
  }

  test("unchanged code never reloads", () => {
    const h = harness();
    h.advance(5000);
    expect(h.watcher.check(null).action).toBe("none");
    expect(h.watcher.check("run_1").action).toBe("none");
  });

  test("re-stamps at most once per interval", () => {
    let calls = 0;
    const watcher = createReloadWatcher({
      intervalMs: 1000,
      stamp: () => {
        calls += 1;
        return "a";
      },
      now: () => 0,
    });
    expect(calls).toBe(1); // the startup stamp
    for (let i = 0; i < 20; i += 1) watcher.check(null);
    expect(calls).toBe(1); // the clock never moved, so nothing re-hashed
  });

  test("idle worker reloads, reporting old → new", () => {
    const h = harness();
    h.change("b");
    h.advance(1000);
    const r = h.watcher.check(null);
    expect(r.action).toBe("reload");
    expect(r.from).toBe("a");
    expect(r.to).toBe("b");
  });

  test("forced between-runs check detects a change before the normal interval (WM-613)", () => {
    const h = harness();
    h.change("b");
    h.advance(1);

    expect(h.watcher.check(null).action).toBe("none");
    expect(h.watcher.check(null, { force: true })).toMatchObject({
      action: "reload",
      from: "a",
      to: "b",
    });
  });

  test("in-flight run defers the reload, then reloads at the next idle check", () => {
    const h = harness();
    h.change("b");
    h.advance(1000);

    // Busy: deferred, and flagged `first` exactly once so the log says it once.
    const first = h.watcher.check("run_busy");
    expect(first).toMatchObject({
      action: "deferred",
      from: "a",
      to: "b",
      runId: "run_busy",
      first: true,
    });
    h.advance(1000);
    expect(h.watcher.check("run_busy")).toMatchObject({
      action: "deferred",
      first: false,
    });

    // The run finishes. The very next check reloads — no extra interval of wait,
    // because the pending change was latched rather than re-detected.
    expect(h.watcher.check(null)).toMatchObject({
      action: "reload",
      from: "a",
      to: "b",
    });
  });

  test("a change that reverts before the next check is never seen", () => {
    const h = harness();
    h.change("b");
    h.change("a");
    h.advance(1000);
    expect(h.watcher.check(null).action).toBe("none");
  });

  test("once latched, the pending stamp is not re-read", () => {
    let stamp = "a";
    let reads = 0;
    let clock = 0;
    const watcher = createReloadWatcher({
      intervalMs: 1000,
      stamp: () => {
        reads += 1;
        return stamp;
      },
      now: () => clock,
    });
    stamp = "b";
    clock += 1000;
    expect(watcher.check("run_busy").action).toBe("deferred");
    const afterLatch = reads;
    stamp = "c"; // a second edit while busy must not un-latch the reload
    clock += 5000;
    expect(watcher.check("run_busy").action).toBe("deferred");
    expect(watcher.check(null)).toMatchObject({ action: "reload", to: "b" });
    expect(reads).toBe(afterLatch);
  });

  test("CODE_RELOAD_EXIT is a code no ordinary worker exit uses", () => {
    expect(CODE_RELOAD_EXIT).toBe(75);
  });
});

// ------------------------------------------ liveness-ceiling invariant ---
// WM-1025. Same shape as the GQL_IMPORT_ALLOWED grep invariant in
// tools/linear.test.mjs: the bug was not that 5s is the wrong number, it was
// that these call sites bypassed the load-adjustment mechanism the repo
// already had. A number typed inline cannot scale, and the next one typed
// inline will not either — so guard the pattern, not the value.
describe("subprocess liveness ceilings scale with host load (WM-1025)", () => {
  const SOURCES = [
    "event-runtime/lib/worker.test.mjs",
    "event-runtime/work.test.mjs",
    "event-runtime/cli/process-cleanup.test.mjs",
  ];

  test("no raw sub-30s timeoutMs literal bypasses loadAdjustedTimeout", () => {
    const root = path.resolve(import.meta.dir, "..", "..");
    const offenders = [];
    for (const rel of SOURCES) {
      const file = path.join(root, rel);
      if (!existsSync(file)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // `timeoutMs: 25` style intentional-hang probes are far below the
          // range that host contention affects; only flag plausible liveness
          // ceilings (1s..30s) written as bare literals.
          const m = line.match(/timeoutMs:\s*([0-9][0-9_]*)\s*,/);
          if (!m) return;
          const ms = Number(m[1].replace(/_/g, ""));
          if (ms < 1_000 || ms > 30_000) return;
          if (line.includes("loadAdjustedTimeout")) return;
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test("the execute-side ceiling actually scales", () => {
    // Guards the wiring itself: a constant that ignores CI_LOAD_FACTOR would
    // satisfy the grep above while still pinning the timeout at 5s.
    expect(EXECUTE_SPAWN_TIMEOUT_MS).toBe(loadAdjustedTimeout(5_000));
    expect(EXECUTE_SPAWN_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });

  test("process-cleanup polling waits scale their caller-provided ceilings", () => {
    const root = path.resolve(import.meta.dir, "..", "..");
    const source = readFileSync(
      path.join(root, "event-runtime/cli/process-cleanup.test.mjs"),
      "utf8",
    );
    for (const name of ["waitForFile", "waitForExit"]) {
      expect(source).toMatch(
        new RegExp(
          `async function ${name}\\([^)]*timeoutMs[^)]*\\)\\s*\\{\\s*timeoutMs = loadAdjustedTimeout\\(timeoutMs\\);`,
        ),
      );
    }
  });
});
