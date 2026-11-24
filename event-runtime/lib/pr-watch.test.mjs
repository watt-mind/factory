import { describe, expect, test } from "bun:test";
import { createPrWatchHub, extractPrWatchEvents } from "./pr-watch.mjs";

const FIXED_AT = "2026-11-24T22:00:00.000Z";
const SHA_A = "abcdef1234567890abcdef1234567890abcdef12";
const SHA_B = "11223344556677889900aabbccddeeff00112233";

describe("extractPrWatchEvents", () => {
  test("check_suite completed emits one wakeup per PR or pr: null when empty", () => {
    const multi = extractPrWatchEvents(
      "check_suite",
      {
        action: "completed",
        repository: { full_name: "watt-mind/factory" },
        check_suite: {
          head_sha: SHA_A,
          conclusion: "success",
          pull_requests: [{ number: 10 }, { number: 20 }, { number: 10 }],
        },
      },
      { deliveryId: "del-cs-1", at: FIXED_AT },
    );
    expect(multi).toEqual([
      {
        repo: "watt-mind/factory",
        pr: 10,
        headSha: SHA_A,
        githubEvent: "check_suite",
        action: "completed",
        conclusion: "success",
        deliveryId: "del-cs-1",
        at: FIXED_AT,
      },
      {
        repo: "watt-mind/factory",
        pr: 20,
        headSha: SHA_A,
        githubEvent: "check_suite",
        action: "completed",
        conclusion: "success",
        deliveryId: "del-cs-1",
        at: FIXED_AT,
      },
    ]);

    const noPr = extractPrWatchEvents(
      "check_suite",
      {
        action: "completed",
        repository: { full_name: "watt-mind/factory" },
        check_suite: {
          head_sha: SHA_A,
          conclusion: "failure",
          pull_requests: [],
        },
      },
      { deliveryId: "del-cs-2", at: FIXED_AT },
    );
    expect(noPr).toEqual([
      {
        repo: "watt-mind/factory",
        pr: null,
        headSha: SHA_A,
        githubEvent: "check_suite",
        action: "completed",
        conclusion: "failure",
        deliveryId: "del-cs-2",
        at: FIXED_AT,
      },
    ]);

    expect(
      extractPrWatchEvents("check_suite", {
        action: "requested",
        repository: { full_name: "watt-mind/factory" },
        check_suite: { head_sha: SHA_A, pull_requests: [{ number: 10 }] },
      }),
    ).toEqual([]);
  });

  test("check_run completed emits per PR or pr: null when empty", () => {
    const withPr = extractPrWatchEvents(
      "check_run",
      {
        action: "completed",
        repository: { full_name: "watt-mind/factory" },
        check_run: {
          head_sha: SHA_A,
          conclusion: "neutral",
          pull_requests: [{ number: 42 }],
        },
      },
      { deliveryId: "del-cr-1", at: FIXED_AT },
    );
    expect(withPr).toEqual([
      {
        repo: "watt-mind/factory",
        pr: 42,
        headSha: SHA_A,
        githubEvent: "check_run",
        action: "completed",
        conclusion: "neutral",
        deliveryId: "del-cr-1",
        at: FIXED_AT,
      },
    ]);

    const emptyPrs = extractPrWatchEvents(
      "check_run",
      {
        action: "completed",
        repository: { full_name: "watt-mind/factory" },
        check_run: {
          head_sha: SHA_B,
          conclusion: "timed_out",
          pull_requests: [],
        },
      },
      { deliveryId: "del-cr-2", at: FIXED_AT },
    );
    expect(emptyPrs).toEqual([
      {
        repo: "watt-mind/factory",
        pr: null,
        headSha: SHA_B,
        githubEvent: "check_run",
        action: "completed",
        conclusion: "timed_out",
        deliveryId: "del-cr-2",
        at: FIXED_AT,
      },
    ]);

    expect(
      extractPrWatchEvents("check_run", {
        action: "created",
        repository: { full_name: "watt-mind/factory" },
        check_run: { head_sha: SHA_A, pull_requests: [{ number: 42 }] },
      }),
    ).toEqual([]);
  });

  test("workflow_run completed emits per PR or pr: null when empty", () => {
    const withPr = extractPrWatchEvents(
      "workflow_run",
      {
        action: "completed",
        repository: { full_name: "watt-mind/factory" },
        workflow_run: {
          head_sha: SHA_A,
          conclusion: "success",
          pull_requests: [{ number: 7 }, { number: 8 }],
        },
      },
      { deliveryId: "del-wr-1", at: FIXED_AT },
    );
    expect(withPr.map((e) => e.pr)).toEqual([7, 8]);
    expect(withPr[0]).toEqual({
      repo: "watt-mind/factory",
      pr: 7,
      headSha: SHA_A,
      githubEvent: "workflow_run",
      action: "completed",
      conclusion: "success",
      deliveryId: "del-wr-1",
      at: FIXED_AT,
    });

    const emptyPrs = extractPrWatchEvents(
      "workflow_run",
      {
        action: "completed",
        repository: { full_name: "watt-mind/factory" },
        workflow_run: {
          head_sha: SHA_B,
          conclusion: "cancelled",
          pull_requests: [],
        },
      },
      { deliveryId: "del-wr-2", at: FIXED_AT },
    );
    expect(emptyPrs).toEqual([
      {
        repo: "watt-mind/factory",
        pr: null,
        headSha: SHA_B,
        githubEvent: "workflow_run",
        action: "completed",
        conclusion: "cancelled",
        deliveryId: "del-wr-2",
        at: FIXED_AT,
      },
    ]);

    expect(
      extractPrWatchEvents("workflow_run", {
        action: "in_progress",
        repository: { full_name: "watt-mind/factory" },
        workflow_run: { head_sha: SHA_A, pull_requests: [{ number: 7 }] },
      }),
    ).toEqual([]);
  });

  test("pull_request handles lifecycle actions and merged conclusion", () => {
    for (const action of [
      "opened",
      "synchronize",
      "reopened",
      "ready_for_review",
      "closed",
    ]) {
      const merged = action === "closed";
      const events = extractPrWatchEvents(
        "pull_request",
        {
          action,
          repository: { full_name: "watt-mind/factory" },
          pull_request: {
            number: 99,
            head: { sha: SHA_A },
            merged,
          },
        },
        { deliveryId: `del-pr-${action}`, at: FIXED_AT },
      );
      expect(events).toEqual([
        {
          repo: "watt-mind/factory",
          pr: 99,
          headSha: SHA_A,
          githubEvent: "pull_request",
          action,
          conclusion: merged ? "merged" : null,
          deliveryId: `del-pr-${action}`,
          at: FIXED_AT,
        },
      ]);
    }

    const closedUnmerged = extractPrWatchEvents(
      "pull_request",
      {
        action: "closed",
        repository: { full_name: "watt-mind/factory" },
        pull_request: { number: 100, head: { sha: SHA_B }, merged: false },
      },
      { deliveryId: "del-pr-closed-unmerged", at: FIXED_AT },
    );
    expect(closedUnmerged[0].conclusion).toBeNull();

    expect(
      extractPrWatchEvents("pull_request", {
        action: "labeled",
        repository: { full_name: "watt-mind/factory" },
        pull_request: { number: 99, head: { sha: SHA_A } },
      }),
    ).toEqual([]);
  });

  test("ignores unknown events, missing repo, and malformed payloads", () => {
    expect(
      extractPrWatchEvents("issues", {
        action: "opened",
        repository: { full_name: "watt-mind/factory" },
      }),
    ).toEqual([]);
    expect(
      extractPrWatchEvents("check_suite", {
        action: "completed",
        check_suite: { head_sha: SHA_A, pull_requests: [{ number: 1 }] },
      }),
    ).toEqual([]);
    expect(extractPrWatchEvents("check_suite", null)).toEqual([]);
    expect(extractPrWatchEvents(null, {})).toEqual([]);
  });
});

describe("createPrWatchHub", () => {
  const sample = (overrides = {}) => ({
    repo: "watt-mind/factory",
    pr: 42,
    headSha: SHA_A,
    githubEvent: "check_run",
    action: "completed",
    conclusion: "success",
    deliveryId: "del-1",
    at: FIXED_AT,
    ...overrides,
  });

  test("enforces maxRecent ring buffer cap and returns newest-first", () => {
    const hub = createPrWatchHub({ maxRecent: 3 });
    for (let i = 1; i <= 5; i++) {
      hub.publish(sample({ deliveryId: `del-${i}`, pr: i }));
    }
    expect(hub.stats()).toEqual({ subscribers: 0, recentCount: 3 });
    expect(hub.recent().map((e) => e.deliveryId)).toEqual([
      "del-5",
      "del-4",
      "del-3",
    ]);
    expect(hub.recent({ limit: 2 }).map((e) => e.deliveryId)).toEqual([
      "del-5",
      "del-4",
    ]);
  });

  test("filters by repo (case-insensitive), pr/prs, and sha prefix/exact", () => {
    const hub = createPrWatchHub();
    const seen = [];
    const unsub = hub.subscribe(
      {
        repo: "Watt-Mind/Factory",
        prs: new Set([42, 43]),
        sha: "ABCDEF12",
      },
      (ev) => seen.push(ev.deliveryId),
    );
    expect(typeof unsub).toBe("function");

    hub.publish(sample({ deliveryId: "match-1", pr: 42, headSha: SHA_A }));
    hub.publish(
      sample({
        deliveryId: "wrong-repo",
        repo: "other/repo",
        pr: 42,
        headSha: SHA_A,
      }),
    );
    hub.publish(sample({ deliveryId: "wrong-pr", pr: 99, headSha: SHA_A }));
    hub.publish(sample({ deliveryId: "null-pr", pr: null, headSha: SHA_A }));
    hub.publish(sample({ deliveryId: "wrong-sha", pr: 42, headSha: SHA_B }));
    hub.publish(sample({ deliveryId: "match-2", pr: 43, headSha: SHA_A }));

    expect(seen).toEqual(["match-1", "match-2"]);
    expect(
      hub
        .recent({ repo: "WATT-MIND/FACTORY", pr: 42, sha: SHA_A })
        .map((e) => e.deliveryId),
    ).toEqual(["match-1"]);
    expect(
      hub.recent({ sha: SHA_A.slice(0, 8) }).map((e) => e.deliveryId),
    ).toEqual(["match-2", "null-pr", "wrong-pr", "wrong-repo", "match-1"]);

    unsub();
    expect(hub.stats().subscribers).toBe(0);
  });

  test("enforces maxSubscribers fail-closed and releases slots on unsubscribe", () => {
    const hub = createPrWatchHub({ maxSubscribers: 2 });
    const unsub1 = hub.subscribe({}, () => {});
    const unsub2 = hub.subscribe({}, () => {});
    const overflow = hub.subscribe({}, () => {});

    expect(typeof unsub1).toBe("function");
    expect(typeof unsub2).toBe("function");
    expect(overflow).toBeNull();
    expect(hub.stats().subscribers).toBe(2);

    // Unsubscribing is idempotent and frees a slot.
    unsub1();
    unsub1();
    expect(hub.stats().subscribers).toBe(1);

    const unsub3 = hub.subscribe({}, () => {});
    expect(typeof unsub3).toBe("function");
    expect(hub.stats().subscribers).toBe(2);

    unsub2();
    unsub3();
    expect(hub.stats().subscribers).toBe(0);
  });

  test("isolates subscriber exceptions so other subscribers still receive events", () => {
    const hub = createPrWatchHub();
    const received = [];
    hub.subscribe({}, () => {
      throw new Error("boom");
    });
    hub.subscribe({}, (ev) => {
      received.push(ev.deliveryId);
    });

    const delivered = hub.publish(sample({ deliveryId: "del-safe" }));
    expect(delivered).toBe(1);
    expect(received).toEqual(["del-safe"]);
    expect(hub.stats().recentCount).toBe(1);
  });
});
