import { describe, expect, test } from "bun:test";
import path from "node:path";
import { RUNTIME_ROOT } from "./config.mjs";
import { openDb } from "./db.mjs";
import * as escalationLabels from "./hooks/builtin/escalation-labels.mjs";
import {
  BUILTIN_HOOK_SOURCE,
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_POINTS,
  HookError,
  createHookRegistry,
  defaultHookRegistry,
  ensureHookDecisions,
  hookDecisionCounts,
  hookDecisionsFor,
  validateHookModule,
} from "./hooks.mjs";
import { loadAdjustedTimeout } from "./test-helpers-timing.mjs";

const FIXTURE_HOOKS = path.join(
  RUNTIME_ROOT,
  "test-support",
  "extensions",
  "sample",
  "hooks",
);
const fixture = (name) => import(path.join(FIXTURE_HOOKS, name));

const now = Date.parse("2026-08-19T12:00:00.000Z");
const ctxFor = (labels = [], extra = {}) => ({
  proposal: { id: "proposal-1", runId: "run-1" },
  spec: { agent: "dispatch@1", input: { repo: "factory" } },
  evidence: { ticket: { labels }, escalatePathIntersections: [] },
  policy: { source: "chain", mode: "auto" },
  repo: "factory",
  now,
  ...extra,
});
const hook = (id, fn) => ({ id, default: fn });
const allow = () => ({ decision: "allow" });
const deny = (reason) => () => ({ decision: "deny", reason });

/** A registry with no built-ins, so ordering and persistence tests read cleanly. */
const bare = () => createHookRegistry({ builtins: [] });

describe("hook registry (WM-842)", () => {
  test("only approve.before exists; unknown points and bad modules are typed errors", () => {
    expect(HOOK_POINTS).toEqual(["approve.before"]);
    const hooks = bare();
    expect(() =>
      hooks.register("plan.before", hook("a:b", allow), { source: "x" }),
    ).toThrow(HookError);
    try {
      hooks.register("plan.before", hook("a:b", allow), { source: "x" });
    } catch (err) {
      expect(err.code).toBe("hook_point_unknown");
    }
    expect(() => hooks.run("plan.before", {})).toThrow(HookError);

    for (const [module, why] of [
      [{ id: "a:b" }, /default function/],
      [{ default: allow }, /string id/],
      [{ id: "Not Valid", default: allow }, /string id/],
      [null, /module namespace/],
    ]) {
      expect(() => validateHookModule(module)).toThrow(why);
      expect(() =>
        hooks.register("approve.before", module, { source: "x" }),
      ).toThrow(HookError);
    }
    expect(() =>
      hooks.register("approve.before", hook("a:b", allow), {}),
    ).toThrow(/source/);
    hooks.register("approve.before", hook("a:b", allow), { source: "x" });
    expect(() =>
      hooks.register("approve.before", hook("a:b", allow), { source: "y" }),
    ).toThrow(/already registered from x/);
    expect(hooks.list()).toEqual([
      { point: "approve.before", id: "a:b", source: "x" },
    ]);
    expect(hooks.has("a:b")).toBe(true);
    expect(hooks.unregister("a:b")).toBe(true);
    expect(hooks.unregister("a:b")).toBe(false);
    expect(hooks.list()).toEqual([]);
  });

  test("allow passes through synchronously and every decision is persisted", () => {
    const db = openDb(":memory:");
    const hooks = bare();
    const seen = [];
    hooks.register(
      "approve.before",
      hook("acme/ext:first", (ctx) => {
        seen.push(ctx);
        return { decision: "allow" };
      }),
      { source: "extension:acme/ext", config: () => ({ limit: 3 }) },
    );
    hooks.register("approve.before", hook("acme/ext:second", allow), {
      source: "extension:acme/ext",
    });

    const out = hooks.run("approve.before", ctxFor(["ai:agent-ready"]), {
      db,
      now,
    });
    // Synchronous: no thenable came back, so the decision is a plain object.
    expect(typeof out.then).toBe("undefined");
    expect(out).toMatchObject({
      decision: "allow",
      reason: null,
      hookId: null,
      source: null,
    });
    expect(out.decisions.map((d) => [d.hookId, d.decision])).toEqual([
      ["acme/ext:first", "allow"],
      ["acme/ext:second", "allow"],
    ]);
    // ctx.config is the registered getter's value; the hook saw a copy.
    expect(seen[0].config).toEqual({ limit: 3 });
    expect(seen[0].evidence.ticket.labels).toEqual(["ai:agent-ready"]);
    seen[0].evidence.ticket.labels.push("mutated");

    const rows = hookDecisionsFor(db, "proposal-1");
    expect(rows.map((r) => [r.hookId, r.source, r.decision, r.reason])).toEqual(
      [
        ["acme/ext:first", "extension:acme/ext", "allow", null],
        ["acme/ext:second", "extension:acme/ext", "allow", null],
      ],
    );
    expect(rows[0]).toMatchObject({
      at: new Date(now).toISOString(),
      point: "approve.before",
      proposalId: "proposal-1",
      runId: "run-1",
      error: null,
    });
    expect(typeof rows[0].durationMs).toBe("number");
    expect(hookDecisionsFor(db, "nope")).toEqual([]);
  });

  test("deny short-circuits the waterfall and is persisted with its reason", () => {
    const db = openDb(":memory:");
    const hooks = bare();
    let third = 0;
    hooks.register("approve.before", hook("a:one", allow), { source: "s" });
    hooks.register("approve.before", hook("a:two", deny("infra_paths")), {
      source: "s",
    });
    hooks.register(
      "approve.before",
      hook("a:three", () => {
        third += 1;
        return { decision: "allow" };
      }),
      { source: "s" },
    );

    const out = hooks.run("approve.before", ctxFor(), { db, now });
    expect(out).toMatchObject({
      decision: "deny",
      reason: "infra_paths",
      hookId: "a:two",
      source: "s",
    });
    expect(third).toBe(0);
    expect(
      hookDecisionsFor(db, "proposal-1").map((r) => [
        r.hookId,
        r.decision,
        r.reason,
      ]),
    ).toEqual([
      ["a:one", "allow", null],
      ["a:two", "deny", "infra_paths"],
    ]);
  });

  test("a throwing hook is a deny hook_error:<id> (fail closed), recorded with the error", async () => {
    const db = openDb(":memory:");
    const hooks = bare();
    hooks.register("approve.before", await fixture("throws.mjs"), {
      source: "extension:factory/sample",
    });
    hooks.register("approve.before", hook("a:after", allow), { source: "s" });
    const out = hooks.run("approve.before", ctxFor(), { db, now });
    expect(out).toMatchObject({
      decision: "deny",
      reason: "hook_error:factory/sample:throws",
      hookId: "factory/sample:throws",
    });
    const [row] = hookDecisionsFor(db, "proposal-1");
    expect(row.error).toMatch(/fixture hook exploded/);
    // The hook after it never ran.
    expect(hookDecisionsFor(db, "proposal-1")).toHaveLength(1);
  });

  test("a rejecting async hook and a malformed decision are denies too", async () => {
    const hooks = bare();
    hooks.register(
      "approve.before",
      hook("a:rejects", async () => {
        throw new Error("nope");
      }),
      { source: "s" },
    );
    const rejected = hooks.run("approve.before", ctxFor());
    expect(typeof rejected.then).toBe("function");
    expect(await rejected).toMatchObject({
      decision: "deny",
      reason: "hook_error:a:rejects",
    });

    for (const bad of [
      undefined,
      null,
      "allow",
      { decision: "maybe" },
      { decision: "deny" },
      { decision: "deny", reason: "" },
      { decision: "deny", reason: "has spaces in it" },
    ]) {
      const h = bare();
      h.register(
        "approve.before",
        hook("a:bad", () => bad),
        { source: "s" },
      );
      expect(h.run("approve.before", ctxFor())).toMatchObject({
        decision: "deny",
        reason: "hook_error:a:bad",
      });
    }
  });

  test("a hook that never answers is denied at timeoutMs; default is 2000ms", async () => {
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(2000);
    const db = openDb(":memory:");
    const hooks = bare();
    hooks.register("approve.before", await fixture("hangs.mjs"), {
      source: "extension:factory/sample",
    });
    const started = performance.now();
    const out = await hooks.run("approve.before", ctxFor(), {
      db,
      now,
      timeoutMs: 30,
    });
    expect(performance.now() - started).toBeLessThan(loadAdjustedTimeout(1500));
    expect(out).toMatchObject({
      decision: "deny",
      reason: "hook_error:factory/sample:hangs",
    });
    const [row] = hookDecisionsFor(db, "proposal-1");
    expect(row.error).toMatch(/did not answer within 30ms/);
  });

  test("an async hook makes the run a Promise; the waterfall continues after it", async () => {
    const hooks = bare();
    const order = [];
    hooks.register(
      "approve.before",
      hook("a:async-allow", async () => {
        order.push("async");
        return { decision: "allow" };
      }),
      { source: "s" },
    );
    hooks.register(
      "approve.before",
      hook("a:sync-after", () => {
        order.push("sync");
        return { decision: "allow" };
      }),
      { source: "s" },
    );
    const out = hooks.run("approve.before", ctxFor());
    expect(typeof out.then).toBe("function");
    expect(await out).toMatchObject({ decision: "allow", hookId: null });
    expect(order).toEqual(["async", "sync"]);

    hooks.register("approve.before", await fixture("async-deny.mjs"), {
      source: "extension:factory/sample",
    });
    expect(await hooks.run("approve.before", ctxFor())).toMatchObject({
      decision: "deny",
      reason: "async_sample_deny",
      hookId: "factory/sample:async-deny",
    });
  });

  test("built-in hooks run before extension hooks regardless of registration order", () => {
    const hooks = bare();
    const order = [];
    const record = (id) =>
      hook(id, () => {
        order.push(id);
        return { decision: "allow" };
      });
    hooks.register("approve.before", record("acme/one:ext"), {
      source: "extension:acme/one",
    });
    hooks.register("approve.before", record("factory:builtin-late"), {
      source: BUILTIN_HOOK_SOURCE,
    });
    hooks.register("approve.before", record("acme/two:ext"), {
      source: "extension:acme/two",
    });
    hooks.run("approve.before", ctxFor());
    expect(order).toEqual([
      "factory:builtin-late",
      "acme/one:ext",
      "acme/two:ext",
    ]);
    expect(hooks.list().map((h) => h.id)).toEqual(order);
  });

  test("the default registry ships the escalation-labels hook first, and it reproduces the old refusal", () => {
    const hooks = defaultHookRegistry();
    expect(hooks.list()[0]).toEqual({
      point: "approve.before",
      id: "factory:escalation-labels",
      source: BUILTIN_HOOK_SOURCE,
    });
    expect(createHookRegistry().list()).toEqual([hooks.list()[0]]);

    const fresh = createHookRegistry();
    // The same fixture labels lib/auto-approval.test.mjs used against the inline check.
    for (const labels of [
      ["ai:agent-ready", "ai:escalated"],
      ["type:security"],
      ["area:Security-review"],
    ]) {
      expect(hooks.run("approve.before", ctxFor(labels))).toMatchObject({
        decision: "deny",
        reason: "escalated_or_security",
        hookId: "factory:escalation-labels",
      });
      expect(escalationLabels.hasSecurityOrEscalation(labels)).toBe(true);
    }
    expect(
      fresh.run("approve.before", ctxFor(["ai:agent-ready"])),
    ).toMatchObject({ decision: "allow" });
    // No dispatch evidence (a merge, a ship) → nothing to refuse, as before.
    expect(
      fresh.run("approve.before", ctxFor([], { evidence: null })),
    ).toMatchObject({ decision: "allow" });
    expect(escalationLabels.default({})).toEqual({ decision: "allow" });
  });

  test("escalation-labels accepts a configurable label list, falling back to the original checks", () => {
    expect(escalationLabels.DEFAULT_ESCALATION_LABELS).toEqual([
      "ai:escalated",
      "type:security",
      "/security/i",
    ]);
    // Unconfigured / malformed options keep the original three checks.
    for (const options of [undefined, null, {}, { labels: "ai:escalated" }]) {
      expect(
        escalationLabels.hasSecurityOrEscalation(["ai:escalated"], options),
      ).toBe(true);
      expect(
        escalationLabels.hasSecurityOrEscalation(["type:security"], options),
      ).toBe(true);
      expect(
        escalationLabels.hasSecurityOrEscalation(
          ["area:Security-review"],
          options,
        ),
      ).toBe(true);
      expect(
        escalationLabels.hasSecurityOrEscalation(["ai:agent-ready"], options),
      ).toBe(false);
    }
    // An explicit list replaces the defaults; `/security/i` is not implied.
    expect(
      escalationLabels.hasSecurityOrEscalation(["ai:blocked"], {
        labels: ["ai:blocked"],
      }),
    ).toBe(true);
    expect(
      escalationLabels.hasSecurityOrEscalation(["ai:escalated"], {
        labels: ["ai:blocked"],
      }),
    ).toBe(false);
    expect(
      escalationLabels.hasSecurityOrEscalation(["area:Security-review"], {
        labels: ["ai:blocked"],
      }),
    ).toBe(false);
    // Empty list is an explicit "match nothing", not a fallback.
    expect(
      escalationLabels.hasSecurityOrEscalation(["ai:escalated"], {
        labels: [],
      }),
    ).toBe(false);
    // Regex literals and RegExp objects, plus the escalationLabels alias.
    expect(
      escalationLabels.hasSecurityOrEscalation(["hold:urgent"], {
        escalationLabels: ["/hold:/i", /^nogo$/],
      }),
    ).toBe(true);
    expect(escalationLabels.parseLabelMatcher("/hold:/i")("hold:urgent")).toBe(
      true,
    );
    // The default export reads ctx.config the same way.
    expect(
      escalationLabels.default({
        evidence: { ticket: { labels: ["ops:freeze"] } },
        config: { labels: ["ops:freeze"] },
      }),
    ).toEqual({ decision: "deny", reason: "escalated_or_security" });
    expect(
      escalationLabels.default({
        evidence: { ticket: { labels: ["ai:escalated"] } },
        config: { labels: ["ops:freeze"] },
      }),
    ).toEqual({ decision: "allow" });
  });

  test("hookDecisionCounts aggregates allow/deny per hook over the window", () => {
    const db = openDb(":memory:");
    expect(hookDecisionCounts(db, { now })).toEqual({});
    const hooks = createHookRegistry();
    hooks.register("approve.before", hook("acme/x:gate", deny("nope")), {
      source: "extension:acme/x",
    });
    hooks.run("approve.before", ctxFor(["ai:escalated"]), { db, now });
    hooks.run("approve.before", ctxFor(), { db, now: now - 60_000 });
    hooks.run("approve.before", ctxFor(), { db, now: now - 25 * 3600_000 });
    expect(hookDecisionCounts(db, { now })).toEqual({
      "factory:escalation-labels": {
        source: "builtin",
        point: "approve.before",
        allow: 1,
        deny: 1,
      },
      "acme/x:gate": {
        source: "extension:acme/x",
        point: "approve.before",
        allow: 0,
        deny: 1,
      },
    });
    ensureHookDecisions(db); // idempotent
    expect(db.query(`SELECT COUNT(*) AS n FROM hook_decisions`).get().n).toBe(
      5,
    );
  });
});
