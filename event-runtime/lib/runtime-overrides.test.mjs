import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-runtime-overrides-test-mjs";
import { openDb } from "./db.mjs";
import { loadRegistry } from "./registry.mjs";
import { FACTORY_ROOT } from "./config.mjs";
import {
  KIND_AGENT,
  KIND_EVENT_TYPE,
  KIND_MODEL_TIER_CELL,
  OverlayError,
  applyPromotion,
  buildPromotionPreview,
  applyModelTierCellOverrides,
  deleteOverride,
  knownAdapters,
  listOverrideJournal,
  listOverrides,
  mergeAgentPatch,
  modelTierCellKey,
  modelTierConfigView,
  modelTierConfigViewTolerant,
  plannedDef,
  putOverride,
  runtimeModelTierCellsTolerant,
  validateAgentPatch,
  validateEventTypePatch,
  validateModelTierCellPatch,
} from "./runtime-overrides.mjs";

const registry = loadRegistry();
// The checkout under test, not reposRoot(): a factory worker exports
// FACTORY_REPOS_ROOT for the checkout it serves, and promotion resolves its
// targets relative to that root — which is outside the registry loaded here.
const REPO_ROOT = FACTORY_ROOT;

/** The event type + agent this repo ships that we can diverge in a preview. */
const PROMO_TYPE = "factory.status-report.requested";
const PROMO_AGENT = "agy-smoke@1";

/** Seed the overlay with one divergent event-type adapter and one agent tier. */
function seedDivergentOverrides(db) {
  putOverride(db, {
    kind: KIND_EVENT_TYPE,
    key: PROMO_TYPE,
    patch: { adapter: "cursor" },
    actor: "operator",
  });
  putOverride(db, {
    kind: KIND_AGENT,
    key: PROMO_AGENT,
    patch: { modelTier: "light" },
    actor: "operator",
  });
}

/**
 * Injected promotion seams that read the repo's real tracked files but never
 * write outside a captured in-memory worktree. Records every seam call so a
 * test can prove nothing targets the live root and no merge/delete occurs.
 */
function fakeSeams({
  worktreeDir = "/tmp/promo-wt-860",
  readTracked,
  readWorktree,
} = {}) {
  const calls = [];
  const writes = new Map();
  return {
    calls,
    writes,
    seams: {
      readTracked:
        readTracked ??
        ((file) => readFileSync(path.join(REPO_ROOT, file), "utf8")),
      tracker: {
        ensure(args) {
          calls.push(["tracker.ensure", args]);
          return { ticket: "gh-860-promo" };
        },
      },
      worktree: {
        up(args) {
          calls.push(["worktree.up", args]);
          return { dir: worktreeDir, branch: "promo/gh-860" };
        },
      },
      readWorktree(dir, file) {
        calls.push(["readWorktree", dir, file]);
        return (
          readWorktree?.(dir, file) ??
          (writes.has(file)
            ? writes.get(file)
            : readFileSync(path.join(REPO_ROOT, file), "utf8"))
        );
      },
      writeWorktree(dir, file, text) {
        calls.push(["writeWorktree", dir, file]);
        writes.set(file, text);
      },
      git: {
        commit(args) {
          calls.push(["git.commit", args]);
        },
        push(args) {
          calls.push(["git.push", args]);
        },
      },
      forge: {
        openPr(args) {
          calls.push(["forge.openPr", args]);
          return { url: "https://example/pr/1", number: 1 };
        },
      },
    },
  };
}

const TARGET = {
  name: "factory",
  path: "/does/not/matter",
  base: "develop",
  github: "watt-mind/factory",
  worktreeUp: "bin/worktree-up.sh",
  worktreeRoot: null,
};

describe("runtime-overrides (WM-887)", () => {
  test("put, get, delete, and journal an event-type adapter overlay", () => {
    const db = openDb(":memory:");
    const type = "factory.status-report.requested";
    putOverride(db, {
      kind: KIND_EVENT_TYPE,
      key: type,
      patch: { adapter: "cursor" },
      actor: "operator",
      now: Date.parse("2026-08-19T10:00:00Z"),
    });
    expect(listOverrides(db).eventTypes[type]).toEqual({ adapter: "cursor" });
    const gone = deleteOverride(db, {
      kind: KIND_EVENT_TYPE,
      key: type,
      actor: "operator",
      now: Date.parse("2026-08-19T10:01:00Z"),
    });
    expect(gone.deleted).toBe(true);
    expect(listOverrides(db).eventTypes[type]).toBeUndefined();
    const journal = listOverrideJournal(db);
    expect(journal).toHaveLength(2);
    expect(journal[0].after).toBeNull();
    expect(journal[1].after).toEqual({ adapter: "cursor" });
    db.close();
  });

  test("malformed agent overrides identify the stored row instead of leaking SyntaxError", () => {
    const db = openDb(":memory:");
    db.query(
      `INSERT INTO runtime_overrides (kind, key, patch_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      KIND_AGENT,
      "agy-malformed@1",
      "{ not json",
      new Date(0).toISOString(),
      "test",
    );

    expect(() => listOverrides(db)).toThrow(OverlayError);
    expect(() => listOverrides(db)).toThrow(
      /invalid stored agent override agy-malformed@1:.*delete or correct this runtime_overrides row/,
    );
    db.close();
  });

  test("unknown override kinds are retained for diagnostics and not applied", () => {
    const db = openDb(":memory:");
    db.query(
      `INSERT INTO runtime_overrides (kind, key, patch_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "retiredKind",
      "legacy-row",
      "{ not json",
      new Date(0).toISOString(),
      "test",
    );

    expect(listOverrides(db)).toEqual({
      eventTypes: {},
      agents: {},
      modelTierCells: {},
      unknown: [{ kind: "retiredKind", key: "legacy-row" }],
    });
    db.close();
  });

  test("validateEventTypePatch refuses unknown type, unknown adapter, extra keys", () => {
    expect(() =>
      validateEventTypePatch(registry, "nope.requested", { adapter: "pi" }),
    ).toThrow(OverlayError);
    expect(() =>
      validateEventTypePatch(registry, "factory.status-report.requested", {
        adapter: "nope",
      }),
    ).toThrow(/unknown adapter/);
    expect(() =>
      validateEventTypePatch(registry, "factory.status-report.requested", {
        adapter: "pi",
        extra: true,
      }),
    ).toThrow(/only adapter/);
    const patch = validateEventTypePatch(
      registry,
      "factory.status-report.requested",
      { adapter: "cursor" },
    );
    expect(patch).toEqual({ adapter: "cursor" });
    expect(knownAdapters(registry).has("pi")).toBe(true);
  });

  test("validateAgentPatch refuses unknown ref and invalid tier; merge keeps independent fields", () => {
    expect(() =>
      validateAgentPatch(registry, "missing@1", { modelTier: "light" }),
    ).toThrow(/unknown agent/);
    expect(() =>
      validateAgentPatch(registry, "factory-status-report@1", {
        modelTier: "turbo",
      }),
    ).toThrow(/modelTier/);
    const incoming = validateAgentPatch(registry, "factory-status-report@1", {
      model: "cursor-grok-4.6-high",
    });
    expect(mergeAgentPatch({ modelTier: "light" }, incoming)).toEqual({
      modelTier: "light",
      model: "cursor-grok-4.6-high",
    });
    expect(
      mergeAgentPatch({ modelTier: "light", model: "x" }, { model: null }),
    ).toEqual({
      modelTier: "light",
      model: null,
    });
    expect(
      mergeAgentPatch({ modelTier: "light" }, { modelTier: null }),
    ).toBeNull();
  });

  test("plannedDef: null model overlay drops the git pin so the tier map wins", () => {
    const planned = plannedDef(
      { model_tier: "standard", model: "pinned-id" },
      { modelOverride: null },
    );
    expect(planned.model).toBeUndefined();
    expect(planned.model_tier).toBe("standard");
  });
});

describe("policy model-tier cell overrides (gh-859)", () => {
  const tracked = {
    pi: { strong: "tracked-strong", standard: "tracked-standard" },
    claude: { light: "tracked-light" },
  };

  test("stores different adapter+tier cells independently and journals each cell", () => {
    const db = openDb(":memory:");
    putOverride(db, {
      kind: KIND_MODEL_TIER_CELL,
      key: modelTierCellKey("pi", "standard"),
      patch: { model: "runtime-standard" },
      actor: "alice",
      now: 1,
    });
    putOverride(db, {
      kind: KIND_MODEL_TIER_CELL,
      key: modelTierCellKey("claude", "light"),
      patch: { model: "runtime-light" },
      actor: "bob",
      now: 2,
    });

    const view = modelTierConfigView(db, tracked);
    expect(view.runtime.pi.standard).toBe("runtime-standard");
    expect(view.runtime.claude.light).toBe("runtime-light");
    expect(view.effective.pi.strong).toBe("tracked-strong");
    expect(view.effective.pi.standard).toBe("runtime-standard");
    const journal = listOverrideJournal(db);
    expect(journal.map((row) => row.key)).toEqual([
      "claude:light",
      "pi:standard",
    ]);
    expect(journal.map((row) => row.actor)).toEqual(["bob", "alice"]);
    expect(journal[0]).toMatchObject({
      before: null,
      after: { model: "runtime-light" },
    });
    db.close();
  });

  test("concurrent processes update different cells without overwriting", async () => {
    const file = path.join(tmpDir("event-model-tier-cells-"), "runtime.db");
    openDb(file).close();
    const cells = [
      ["pi", "standard", "runtime-standard", "alice"],
      ["claude", "light", "runtime-light", "bob"],
    ];
    const processes = cells.map(([adapter, tier, model, actor]) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `
            import { openDb } from "./event-runtime/lib/db.mjs";
            import { KIND_MODEL_TIER_CELL, modelTierCellKey, putOverride } from "./event-runtime/lib/runtime-overrides.mjs";
            const db = openDb(process.argv[1]);
            putOverride(db, {
              kind: KIND_MODEL_TIER_CELL,
              key: modelTierCellKey(process.argv[2], process.argv[3]),
              patch: { model: process.argv[4] },
              actor: process.argv[5],
            });
            db.close();
          `,
          file,
          adapter,
          tier,
          model,
          actor,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const results = await Promise.all(
      processes.map(async (process) => ({
        code: await process.exited,
        stderr: await new Response(process.stderr).text(),
      })),
    );
    expect(results).toEqual([
      { code: 0, stderr: "" },
      { code: 0, stderr: "" },
    ]);

    const db = openDb(file);
    const view = modelTierConfigView(db, tracked);
    expect(view.runtime.pi.standard).toBe("runtime-standard");
    expect(view.runtime.claude.light).toBe("runtime-light");
    expect(
      listOverrideJournal(db)
        .filter((row) => row.kind === KIND_MODEL_TIER_CELL)
        .map((row) => row.actor)
        .sort(),
    ).toEqual(["alice", "bob"]);
    db.close();
  });

  test("delete restores tracked composition and absent delete is idempotent", () => {
    const db = openDb(":memory:");
    const key = modelTierCellKey("pi", "standard");
    putOverride(db, {
      kind: KIND_MODEL_TIER_CELL,
      key,
      patch: { model: "runtime-standard" },
    });
    expect(
      deleteOverride(db, { kind: KIND_MODEL_TIER_CELL, key }).deleted,
    ).toBe(true);
    expect(modelTierConfigView(db, tracked).effective.pi.standard).toBe(
      "tracked-standard",
    );
    expect(
      deleteOverride(db, { kind: KIND_MODEL_TIER_CELL, key }).deleted,
    ).toBe(false);
    // An absent delete is not a mutation and therefore adds no journal row.
    expect(listOverrideJournal(db)).toHaveLength(2);
    db.close();
  });

  test("validates the closed adapter/tier vocabulary and exact model patch", () => {
    expect(() =>
      validateModelTierCellPatch("unknown", "standard", { model: "x" }),
    ).toThrow(/unknown model adapter/);
    expect(() =>
      validateModelTierCellPatch("pi", "turbo", { model: "x" }),
    ).toThrow(/unknown model tier/);
    for (const patch of [
      {},
      { model: "" },
      { model: "   " },
      { model: null },
      { model: "x", extra: true },
    ]) {
      expect(() => validateModelTierCellPatch("pi", "standard", patch)).toThrow(
        OverlayError,
      );
    }
    expect(
      validateModelTierCellPatch("pi", "standard", { model: "x" }),
    ).toEqual({ model: "x" });
  });

  test("startup composition reloads persisted cells and invalid rows fail closed actionably", () => {
    const file = path.join(tmpDir("event-model-tier-restart-"), "runtime.db");
    let db = openDb(file);
    putOverride(db, {
      kind: KIND_MODEL_TIER_CELL,
      key: "pi:standard",
      patch: { model: "first" },
    });
    db.close();

    db = openDb(file);
    const started = applyModelTierCellOverrides(db, tracked);
    putOverride(db, {
      kind: KIND_MODEL_TIER_CELL,
      key: "pi:standard",
      patch: { model: "second" },
    });
    expect(started.pi.standard).toBe("first");
    db.close();

    db = openDb(file);
    expect(applyModelTierCellOverrides(db, tracked).pi.standard).toBe("second");
    deleteOverride(db, {
      kind: KIND_MODEL_TIER_CELL,
      key: "pi:standard",
    });
    expect(started.pi.standard).toBe("first");
    db.close();

    db = openDb(file);
    expect(applyModelTierCellOverrides(db, tracked).pi.standard).toBe(
      "tracked-standard",
    );

    db.query(
      `INSERT INTO runtime_overrides (kind, key, patch_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      KIND_MODEL_TIER_CELL,
      "unknown:standard",
      JSON.stringify({ model: "x" }),
      new Date(0).toISOString(),
      "test",
    );
    expect(() => applyModelTierCellOverrides(db, tracked)).toThrow(
      /invalid stored modelTierCell row.*unknown model adapter.*delete or correct/,
    );
    db.close();
  });

  test("tolerant model-tier reads report malformed rows and retain valid cells", () => {
    const db = openDb(":memory:");
    putOverride(db, {
      kind: KIND_MODEL_TIER_CELL,
      key: "pi:strong",
      patch: { model: "runtime-strong" },
    });
    db.query(
      `INSERT INTO runtime_overrides (kind, key, patch_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      KIND_MODEL_TIER_CELL,
      "pi:standard",
      JSON.stringify({ model: "runtime-standard", extra: true }),
      new Date(0).toISOString(),
      "test",
    );

    expect(runtimeModelTierCellsTolerant(db)).toEqual({
      cells: { pi: { strong: "runtime-strong" } },
      problems: [
        {
          key: "pi:standard",
          error: expect.stringContaining("accepts exactly one field: model"),
        },
      ],
    });
    expect(modelTierConfigViewTolerant(db, tracked).effective.pi.strong).toBe(
      "runtime-strong",
    );
    db.close();
  });
});

describe("overlay promotion (gh-860)", () => {
  let previousReposRoot;
  beforeAll(() => {
    previousReposRoot = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = REPO_ROOT;
  });
  afterAll(() => {
    if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  });

  test("preview snapshots divergent rows with stable keys, targets, and digest", () => {
    const db = openDb(":memory:");
    seedDivergentOverrides(db);
    const preview = buildPromotionPreview({ db, registry });
    const et = preview.selections.find((s) => s.ref === PROMO_TYPE);
    const agent = preview.selections.find((s) => s.ref === PROMO_AGENT);

    expect(et).toMatchObject({
      key: `eventType:${PROMO_TYPE}:adapter`,
      kind: KIND_EVENT_TYPE,
      field: "adapter",
      before: "pi",
      effective: "cursor",
      current: true,
    });
    expect(et.target.file).toBe("event-runtime/event-types.json");
    expect(agent).toMatchObject({
      key: `agent:${PROMO_AGENT}:modelTier`,
      kind: KIND_AGENT,
      field: "modelTier",
      before: "strong",
      effective: "light",
      current: true,
    });
    expect(agent.target.file).toBe("event-runtime/agents/agy-smoke.json");
    expect(typeof preview.digest).toBe("string");
    // Digest is stable for identical override state.
    expect(buildPromotionPreview({ db, registry }).digest).toBe(preview.digest);
    db.close();
  });

  test("empty selection is a typed no-op that drives no seam", async () => {
    const db = openDb(":memory:");
    seedDivergentOverrides(db);
    const { seams, calls } = fakeSeams();
    const preview = buildPromotionPreview({ db, registry });
    const result = await applyPromotion({
      db,
      registry,
      target: TARGET,
      digest: preview.digest,
      keys: [],
      seams,
    });
    expect(result.status).toBe("noop");
    expect(calls).toHaveLength(0);
    db.close();
  });

  test("apply writes only the selected subset, keeps pins, and opens one PR", async () => {
    const db = openDb(":memory:");
    seedDivergentOverrides(db);
    const preview = buildPromotionPreview({ db, registry });
    const { seams, calls, writes } = fakeSeams();
    const keys = preview.selections
      .filter((s) => s.ref === PROMO_TYPE || s.ref === PROMO_AGENT)
      .map((s) => s.key);

    const result = await applyPromotion({
      db,
      registry,
      target: TARGET,
      digest: preview.digest,
      keys,
      seams,
    });

    expect(result.status).toBe("opened");
    expect(result.pr).toEqual({ url: "https://example/pr/1", number: 1 });

    // The event-type write flips only the selected adapter; siblings untouched.
    const etOut = JSON.parse(writes.get("event-runtime/event-types.json"));
    expect(etOut[PROMO_TYPE].adapter).toBe("cursor");
    expect(etOut[PROMO_TYPE].agent).toBe(registry.eventTypes[PROMO_TYPE].agent);

    // The agent write flips only model_tier and RETAINS the pins block.
    const agentOut = JSON.parse(
      writes.get("event-runtime/agents/agy-smoke.json"),
    );
    expect(agentOut.model_tier).toBe("light");
    expect(agentOut.pins).toEqual(registry.agents.get(PROMO_AGENT).pins);

    // Base is the configured branch; worktree is never the live root.
    const up = calls.find((c) => c[0] === "worktree.up")[1];
    expect(up.base).toBe("develop");
    expect(up.checkoutOnly).toBe(true);
    for (const call of calls) {
      if (call[0] === "writeWorktree" || call[0] === "readWorktree") {
        expect(call[1]).not.toBe(registry.root);
      }
    }
    const pr = calls.find((c) => c[0] === "forge.openPr")[1];
    expect(pr.base).toBe("develop");
    expect(pr.head).toBe("promo/gh-860");
    expect(pr.body).toContain("Fixes gh-860-promo");

    // No merge or delete seam is ever reachable.
    const seamNames = calls.map((c) => c[0]);
    expect(seamNames).not.toContain("git.merge");
    expect(seamNames).not.toContain("forge.merge");
    expect(seamNames).not.toContain("worktree.down");
    db.close();
  });

  test("stale preview digest fails closed before any seam runs", async () => {
    const db = openDb(":memory:");
    seedDivergentOverrides(db);
    const preview = buildPromotionPreview({ db, registry });
    const { seams, calls } = fakeSeams();
    await expect(
      applyPromotion({
        db,
        registry,
        target: TARGET,
        digest: "sha256:staaaale",
        keys: [preview.selections[0].key],
        seams,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(0);
    db.close();
  });

  test("unknown key fails closed before any seam runs", async () => {
    const db = openDb(":memory:");
    seedDivergentOverrides(db);
    const preview = buildPromotionPreview({ db, registry });
    const { seams, calls } = fakeSeams();
    await expect(
      applyPromotion({
        db,
        registry,
        target: TARGET,
        digest: preview.digest,
        keys: ["agent:no-such@1:model"],
        seams,
      }),
    ).rejects.toThrow(/unknown promotion key/);
    expect(calls).toHaveLength(0);
    db.close();
  });

  test("target drift fails closed before any worktree exists", async () => {
    const db = openDb(":memory:");
    seedDivergentOverrides(db);
    const preview = buildPromotionPreview({ db, registry });
    const key = preview.selections.find((s) => s.ref === PROMO_AGENT).key;
    // Tracked model_tier now reads "standard", not the previewed "strong".
    const { seams, calls } = fakeSeams({
      readTracked: () =>
        JSON.stringify({ id: "agy-smoke", model_tier: "standard" }),
    });
    await expect(
      applyPromotion({
        db,
        registry,
        target: TARGET,
        digest: preview.digest,
        keys: [key],
        seams,
      }),
    ).rejects.toMatchObject({ status: 409 });
    // Failed drift means no worktree was ever created.
    expect(calls.some((c) => c[0] === "worktree.up")).toBe(false);
    db.close();
  });

  test("base-branch drift after checkout fails before writing the worktree", async () => {
    const db = openDb(":memory:");
    seedDivergentOverrides(db);
    const preview = buildPromotionPreview({ db, registry });
    const key = preview.selections.find((s) => s.ref === PROMO_AGENT).key;
    const { seams, calls } = fakeSeams({
      readWorktree: () =>
        JSON.stringify({ id: "agy-smoke", model_tier: "standard" }),
    });

    await expect(
      applyPromotion({
        db,
        registry,
        target: TARGET,
        digest: preview.digest,
        keys: [key],
        seams,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(
        "target drift on agent:agy-smoke@1:modelTier: base-branch value changed since preview",
      ),
    });
    expect(calls.some((call) => call[0] === "writeWorktree")).toBe(false);
    db.close();
  });

  test("invalid tracked JSON fails closed", async () => {
    const db = openDb(":memory:");
    seedDivergentOverrides(db);
    const preview = buildPromotionPreview({ db, registry });
    const key = preview.selections.find((s) => s.ref === PROMO_AGENT).key;
    const { seams } = fakeSeams({ readTracked: () => "{ not json" });
    await expect(
      applyPromotion({
        db,
        registry,
        target: TARGET,
        digest: preview.digest,
        keys: [key],
        seams,
      }),
    ).rejects.toMatchObject({ status: 422 });
    db.close();
  });

  test("failure after checkout returns recoverable worktree evidence", async () => {
    const db = openDb(":memory:");
    seedDivergentOverrides(db);
    const preview = buildPromotionPreview({ db, registry });
    const key = preview.selections.find((s) => s.ref === PROMO_AGENT).key;
    const { seams } = fakeSeams();
    seams.git.push = () => {
      throw new Error("network down");
    };
    let caught;
    try {
      await applyPromotion({
        db,
        registry,
        target: TARGET,
        digest: preview.digest,
        keys: [key],
        seams,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OverlayError);
    expect(caught.evidence).toMatchObject({
      worktree: "/tmp/promo-wt-860",
      branch: "promo/gh-860",
      ticket: "gh-860-promo",
    });
    db.close();
  });
});
