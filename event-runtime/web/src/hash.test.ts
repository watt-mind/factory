import { describe, expect, test } from "bun:test";
import type { HashWriteScheduler } from "./hash";
import {
  artifactFullHash,
  createHashWriter,
  eventsHash,
  flushHash,
  hashPath,
  hashProject,
  hashSearch,
  hashView,
  HASH_WRITE_INTERVAL_MS,
  parseHash,
  setActiveHashWriter,
  shouldReplaceHash,
  withProject,
} from "./hash";

describe("parseHash", () => {
  test("empty hash is overview's empty route", () => {
    expect(parseHash("")).toEqual([]);
    expect(parseHash("#")).toEqual([]);
    expect(parseHash("#/")).toEqual([]);
  });

  test("splits view and id", () => {
    expect(parseHash("#/runs/run_01")).toEqual(["runs", "run_01"]);
    expect(parseHash("#/events/web/evt_1")).toEqual(["events", "web", "evt_1"]);
    expect(parseHash("#/workers")).toEqual(["workers"]);
    expect(parseHash("#/workers/wkr_01")).toEqual(["workers", "wkr_01"]);
  });

  test("strips a query so ?type= cannot become a path segment", () => {
    expect(parseHash("#/events?type=factory.ticket.ready")).toEqual(["events"]);
    expect(parseHash("#/events/web/evt_1?type=x")).toEqual([
      "events",
      "web",
      "evt_1",
    ]);
  });

  test("decodes encoded segments so agent refs round-trip", () => {
    expect(parseHash("#/agents/factory-status-report%401")).toEqual([
      "agents",
      "factory-status-report@1",
    ]);
    expect(parseHash("#/graph/event%3Afactory.ticket.ready")).toEqual([
      "graph",
      "event:factory.ticket.ready",
    ]);
  });
});

describe("hashView", () => {
  test("empty hash is overview", () => {
    expect(hashView("")).toBe("overview");
    expect(hashView("#")).toBe("overview");
    expect(hashView("#/")).toBe("overview");
    expect(hashView("#/overview")).toBe("overview");
  });

  test("reads the first path segment, ignoring ids and query", () => {
    expect(hashView("#/runs/run_01")).toBe("runs");
    expect(hashView("#/events?type=factory.ticket.ready")).toBe("events");
    expect(hashView("#/events/web/evt_1")).toBe("events");
    expect(hashView("#/workers/wkr_01")).toBe("workers");
  });
});

describe("shouldReplaceHash", () => {
  test("j/k selection on the same view replaces", () => {
    expect(shouldReplaceHash("#/runs", "runs/run_01")).toBe(true);
    expect(shouldReplaceHash("#/runs/run_01", "runs/run_02")).toBe(true);
    expect(shouldReplaceHash("#/runs/run_02", "runs")).toBe(true);
    expect(shouldReplaceHash("#/events/web/evt_1", "events/web/evt_2")).toBe(
      true,
    );
    expect(
      shouldReplaceHash("#/agents", "agents/factory-status-report%401"),
    ).toBe(true);
    expect(
      shouldReplaceHash("#/graph", "graph/event%3Afactory.ticket.ready"),
    ).toBe(true);
    expect(shouldReplaceHash("#/workers", "workers/wkr_01")).toBe(true);
    expect(shouldReplaceHash("#/workers/wkr_01", "workers/wkr_02")).toBe(true);
    expect(shouldReplaceHash("#/workers/wkr_01", "workers")).toBe(true);
  });

  test("query-only changes on the same view replace", () => {
    expect(
      shouldReplaceHash("#/events", "events?type=factory.ticket.ready"),
    ).toBe(true);
    expect(shouldReplaceHash("#/events?type=a", "events?type=b")).toBe(true);
    expect(shouldReplaceHash("#/events?type=a", "events/web/evt_1")).toBe(true);
  });

  test("crossing views pushes so Back returns", () => {
    expect(shouldReplaceHash("#/events", "runs")).toBe(false);
    expect(shouldReplaceHash("#/overview", "events")).toBe(false);
    expect(shouldReplaceHash("", "events")).toBe(false);
    expect(shouldReplaceHash("#/events/web/evt_1", "runs/run_01")).toBe(false);
    expect(shouldReplaceHash("#/runs/run_01", "proposals")).toBe(false);
    expect(shouldReplaceHash("#/graph", "agents")).toBe(false);
    expect(shouldReplaceHash("#/runs/run_01", "workers/wkr_01")).toBe(false);
    expect(shouldReplaceHash("#/workers/wkr_01", "runs")).toBe(false);
  });

  test("empty hash and #/overview are the same view", () => {
    expect(shouldReplaceHash("", "overview")).toBe(true);
    expect(shouldReplaceHash("#/overview", "overview")).toBe(true);
  });
});

describe("hashSearch", () => {
  test("reads query keys off the hash", () => {
    expect(hashSearch("#/events?type=factory.ticket.ready").get("type")).toBe(
      "factory.ticket.ready",
    );
    expect(hashSearch("#/events").get("type")).toBeNull();
  });
});

describe("eventsHash", () => {
  test("view root, row, and type query", () => {
    expect(eventsHash()).toBe("events");
    expect(eventsHash("web", "evt_1")).toBe("events/web/evt_1");
    expect(eventsHash(null, null, "factory.ticket.ready")).toBe(
      "events?type=factory.ticket.ready",
    );
    expect(eventsHash("web", "evt_1", "factory.ticket.ready")).toBe(
      "events/web/evt_1?type=factory.ticket.ready",
    );
  });
});

describe("artifactFullHash", () => {
  test("carries the filtered inspector as the full reader's return target", () => {
    const digest = "a".repeat(64);
    expect(
      artifactFullHash(
        digest,
        `#/artifacts/${digest}?kind=transcript&search=f99e8b&project=factory`,
      ),
    ).toBe(
      `artifact/${digest}?back=artifacts%2F${digest}%3Fkind%3Dtranscript%26search%3Df99e8b%26project%3Dfactory`,
    );
  });

  test("does not add a return target outside the catalogue", () => {
    expect(artifactFullHash("a".repeat(64), "#/runs/run_1")).toBe(
      `artifact/${"a".repeat(64)}`,
    );
  });
});

describe("withProject / hashProject", () => {
  test("adds, strips, and merges with type=", () => {
    expect(withProject("runs", "bj29")).toBe("runs?project=bj29");
    expect(withProject("runs", "inflight")).toBe("runs?project=inflight");
    expect(withProject("runs?project=bj29", null)).toBe("runs");
    expect(withProject("events?type=factory.ticket.ready", "bj29")).toBe(
      "events?type=factory.ticket.ready&project=bj29",
    );
    expect(withProject("events?type=x&project=bj29", null)).toBe(
      "events?type=x",
    );
    expect(withProject("runs/run_01", undefined)).toBe("runs/run_01");
  });

  test("hashProject reads the context filter off the hash", () => {
    expect(hashProject("#/runs")).toBeNull();
    expect(hashProject("#/runs?project=bj29")).toBe("bj29");
    expect(hashProject("#/events?type=x&project=inflight")).toBe("inflight");
  });

  test("same-view project query still replaces", () => {
    expect(shouldReplaceHash("#/runs", "runs?project=bj29")).toBe(true);
    expect(shouldReplaceHash("#/runs?project=bj29", "runs")).toBe(true);
    expect(
      shouldReplaceHash("#/events?project=bj29", "runs?project=bj29"),
    ).toBe(false);
  });
});

/** Manual clock: the coalescing is about elapsed time, not about real waiting. */
function fakeScheduler() {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void }> = [];
  const scheduler: HashWriteScheduler = {
    now: () => now,
    after: (fn, ms) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
  };
  return {
    scheduler,
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
    },
  };
}

describe("createHashWriter", () => {
  function harness(write?: (hash: string, replace: boolean) => void) {
    const clock = fakeScheduler();
    const writes: Array<{ hash: string; replace: boolean }> = [];
    const writer = createHashWriter((hash, replace) => {
      writes.push({ hash, replace });
      write?.(hash, replace);
    }, clock.scheduler);
    return { writer, writes, advance: clock.advance };
  }

  test("a single same-view write lands immediately, as a replace", () => {
    const { writer, writes } = harness();
    writer.replace("#/runs/run_01");
    expect(writes).toEqual([{ hash: "#/runs/run_01", replace: true }]);
  });

  test("a burst inside one interval collapses to the last row", () => {
    const { writer, writes, advance } = harness();
    for (let i = 1; i <= 100; i++) writer.replace(`#/runs/run_${i}`);
    expect(writes).toEqual([{ hash: "#/runs/run_1", replace: true }]);
    advance(HASH_WRITE_INTERVAL_MS);
    expect(writes).toEqual([
      { hash: "#/runs/run_1", replace: true },
      { hash: "#/runs/run_100", replace: true },
    ]);
  });

  test("holding j for 30s stays under Safari's ~100 writes per 30s", () => {
    const { writer, writes, advance } = harness();
    // Key repeat is ~30/s once the hold takes; the old code wrote every one.
    for (let i = 1; i <= 900; i++) {
      writer.replace(`#/runs/run_${i}`);
      advance(33);
    }
    expect(writes.length).toBeLessThan(100);
    expect(writes.every((w) => w.replace)).toBe(true);
    // Releasing the key lands the row the operator stopped on, so the URL is
    // still shareable after a hold (OPS-230).
    advance(HASH_WRITE_INTERVAL_MS);
    expect(writes.at(-1)?.hash).toBe("#/runs/run_900");
  });

  test("a view change pushes, landing the buffered selection first", () => {
    const { writer, writes } = harness();
    writer.replace("#/runs/run_01");
    writer.replace("#/runs/run_02");
    writer.push("#/events");
    expect(writes).toEqual([
      { hash: "#/runs/run_01", replace: true },
      { hash: "#/runs/run_02", replace: true },
      { hash: "#/events", replace: false },
    ]);
  });

  test("a throwing write does not escape into the keydown handler", () => {
    const { writer, writes, advance } = harness(() => {
      throw new Error("SecurityError: history write cap");
    });
    expect(() => writer.replace("#/runs/run_01")).not.toThrow();
    writer.replace("#/runs/run_02");
    expect(() => advance(HASH_WRITE_INTERVAL_MS)).not.toThrow();
    expect(() => writer.push("#/events")).not.toThrow();
    expect(writes.length).toBe(3);
  });

  test("cancel drops the buffered write so Back is not clobbered", () => {
    const { writer, writes, advance } = harness();
    writer.replace("#/runs/run_01");
    writer.replace("#/runs/run_02");
    writer.cancel();
    advance(HASH_WRITE_INTERVAL_MS * 2);
    expect(writes).toEqual([{ hash: "#/runs/run_01", replace: true }]);
  });

  test("flush lands a buffered write now, and only once", () => {
    const { writer, writes, advance } = harness();
    writer.replace("#/events");
    writer.replace("#/events?type=factory.ticket.ready");
    writer.flush();
    expect(writes).toEqual([
      { hash: "#/events", replace: true },
      { hash: "#/events?type=factory.ticket.ready", replace: true },
    ]);
    advance(HASH_WRITE_INTERVAL_MS * 2);
    expect(writes.length).toBe(2);
  });

  test("a write after the interval is immediate again", () => {
    const { writer, writes, advance } = harness();
    writer.replace("#/runs/run_01");
    advance(HASH_WRITE_INTERVAL_MS);
    writer.replace("#/runs/run_02");
    expect(writes.length).toBe(2);
    expect(writes.at(-1)?.hash).toBe("#/runs/run_02");
  });

  test("flushHash with no active writer is a safe no-op", () => {
    setActiveHashWriter(null);
    expect(() => flushHash()).not.toThrow();
  });

  test("flushHash with active writer lands buffered value immediately", () => {
    const { writer, writes } = harness();
    setActiveHashWriter(writer);
    writer.replace("#/runs/run_01");
    writer.replace("#/runs/run_02");
    expect(writes).toEqual([{ hash: "#/runs/run_01", replace: true }]);
    flushHash();
    expect(writes).toEqual([
      { hash: "#/runs/run_01", replace: true },
      { hash: "#/runs/run_02", replace: true },
    ]);
    setActiveHashWriter(null);
  });
});

describe("hashPath", () => {
  test("encodes id segments", () => {
    expect(hashPath("runs")).toBe("runs");
    expect(hashPath("runs", "run_01")).toBe("runs/run_01");
    expect(hashPath("agents", "factory-status-report@1")).toBe(
      "agents/factory-status-report%401",
    );
    expect(hashPath("events", "web", "evt_1")).toBe("events/web/evt_1");
    expect(hashPath("graph", "event:factory.ticket.ready")).toBe(
      "graph/event%3Afactory.ticket.ready",
    );
    expect(hashPath("workers")).toBe("workers");
    expect(hashPath("workers", "wkr_01")).toBe("workers/wkr_01");
  });

  test("drops null/empty ids so a closed panel is the view root", () => {
    expect(hashPath("runs", null)).toBe("runs");
    expect(hashPath("runs", undefined)).toBe("runs");
    expect(hashPath("events", "web", "")).toBe("events/web");
  });

  test("round-trips through parseHash", () => {
    const path = hashPath("agents", "factory-status-report@1");
    expect(parseHash(`#/${path}`)).toEqual([
      "agents",
      "factory-status-report@1",
    ]);
    const worker = hashPath("workers", "wkr_lab_4821");
    expect(parseHash(`#/${worker}`)).toEqual(["workers", "wkr_lab_4821"]);
  });
});
