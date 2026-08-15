import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cpSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { RUNTIME_ROOT } from "./config.mjs";
import {
  DEFAULT_MODEL, RegistryError, getAgent, getEventType, loadModelTierMap, loadRegistry, resolveModel, updatePins,
} from "./registry.mjs";

/** Copy the real registry into a temp root so tests can corrupt it safely. */
function tempRegistry() {
  const root = mkdtempSync(path.join(tmpdir(), "event-registry-"));
  for (const dir of ["agents", "schemas"]) {
    cpSync(path.join(RUNTIME_ROOT, dir), path.join(root, dir), { recursive: true });
  }
  cpSync(path.join(RUNTIME_ROOT, "event-types.json"), path.join(root, "event-types.json"));
  return root;
}

/**
 * A tier map that satisfies the committed registry: since WM-215 every LLM
 * route is the pi adapter, so the pi map must cover every tier a routed
 * definition declares. The claude map stays as the per-route exception's
 * mapping — no committed route consumes it today.
 */
const PI_TIERS = {
  claude: { strong: "default", standard: "sonnet", light: "haiku" },
  pi: {
    strong: "openai-codex/gpt-5.6-sol",
    standard: "openai-codex/gpt-5.6-terra",
    light: "openai-codex/gpt-5.6-luna",
  },
};

describe("registry", () => {
  test("loads the committed registry (pins verified)", () => {
    const registry = loadRegistry();
    const def = getAgent(registry, "factory-status-report@1");
    expect(def.outputSchema.required).toContain("recommendedAction");
    expect(getEventType(registry, "factory.status-report.requested").agent).toBe("factory-status-report@1");
    expect(getEventType(registry, "unknown.event")).toBeNull();
  });

  test("editing a pinned file without re-pinning fails closed", () => {
    const root = tempRegistry();
    const promptFile = path.join(root, "agents", "factory-status-report.md");
    writeFileSync(promptFile, `${readFileSync(promptFile, "utf8")}\n<!-- drift -->\n`);
    expect(() => loadRegistry({ root })).toThrow(RegistryError);
    updatePins({ root });
    expect(() => loadRegistry({ root })).not.toThrow();
  });

  test("mutating agents are refused in the MVP", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...def, mutating: true }));
    expect(() => loadRegistry({ root })).toThrow(/mutating/);
  });

  test("a mutating LLM agent over a tier-2 worktree workspace is admitted (dispatch design §6, WM-108)", () => {
    const registry = loadRegistry();
    const def = getAgent(registry, "dispatch@1");
    expect(def.mutating).toBe(true);
    expect(def.workspace.type).toBe("worktree");
    expect(getEventType(registry, "factory.dispatch.requested").agent).toBe("dispatch@1");
    // The carve-out is the workspace type, nothing wider: the same def on an
    // ephemeral workspace must still fail closed.
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "dispatch.json");
    const raw = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...raw, workspace: { type: "ephemeral" } }));
    expect(() => loadRegistry({ root })).toThrow(/mutating/);
  });

  test("schedule payload must be a plain object without reserved tick fields (WM-72)", () => {
    const root = tempRegistry();
    const withPayload = (payload) =>
      writeFileSync(
        path.join(root, "schedules.json"),
        JSON.stringify({
          "reconcile-x": { every: "10m", eventType: "factory.reconcile.requested", payload, enabled: false },
        }),
      );
    withPayload(["bj29"]);
    expect(() => loadRegistry({ root })).toThrow(/plain object/);
    withPayload({ slot: "2026-01-01T00:00:00.000Z" });
    expect(() => loadRegistry({ root })).toThrow(/reserved tick field/);
    withPayload({ repo: "bj29" });
    expect(() => loadRegistry({ root })).not.toThrow();
  });

  test("repos scope: malformed values fail closed at load, well-formed ones load (WM-64)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    const withRepos = (repos) => writeFileSync(defFile, JSON.stringify({ ...def, repos }));

    withRepos("bj29"); // not an array
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);
    withRepos([]); // half-finished edit, not a deny-all
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);
    withRepos(["bj29", ""]); // empty string member
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);
    withRepos(["bj29", 7]); // non-string member
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);

    // Well-formed loads, and membership is deliberately NOT checked against
    // config/repos.yaml here — the planner owns that at plan time.
    withRepos(["bj29", "not-in-repos-yaml"]);
    const registry = loadRegistry({ root });
    expect(getAgent(registry, "factory-status-report@1").repos).toEqual(["bj29", "not-in-repos-yaml"]);
  });

  test("model_tier: valid tiers load and are readable; absent field stays absent (WM-135)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...def, model_tier: "standard" }));
    // Every LLM route is "pi" since WM-215, so the pi map must cover every
    // tier any routed definition declares — event types outside this test's
    // own agent are validated too.
    const registry = loadRegistry({ root, modelTiers: PI_TIERS });
    expect(getAgent(registry, "factory-status-report@1").model_tier).toBe("standard");
    // A definition that declares nothing is untouched — adapter default.
    expect(getAgent(registry, "reconcile@1").model_tier).toBeUndefined();
    expect(getAgent(registry, "reconcile@1").model).toBeUndefined();
  });

  test("model_tier outside the closed enum fails at load (WM-135)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    for (const bad of ["medium", "opus-4", 3, null]) {
      writeFileSync(defFile, JSON.stringify({ ...def, model_tier: bad }));
      expect(() => loadRegistry({ root, modelTiers: { claude: { strong: "default", standard: "sonnet" } } })).toThrow(
        /"model_tier"/,
      );
    }
  });

  test("declared tier with no mapping for the routed adapter fails closed at load (WM-135)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...def, model_tier: "light" }));
    // No pi tier map at all, and a map missing this one tier: both refuse.
    // (factory-status-report is the first routed event type in the file, so
    // its unmapped "light" is what the load trips on in both cases.)
    expect(() => loadRegistry({ root, modelTiers: {} })).toThrow(/no mapping for adapter "pi"/);
    expect(() =>
      loadRegistry({
        root,
        modelTiers: { pi: { strong: "openai-codex/gpt-5.6-sol", standard: "openai-codex/gpt-5.6-terra" } },
      }),
    ).toThrow(/model_tier "light" has no mapping/);
  });

  test("a tier on a command/actions-routed agent is not applicable, never an error (WM-135)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "reconcile.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...def, model_tier: "light" }));
    // reconcile routes via the command adapter — "light" is resolved for no
    // adapter there, so the command route stays applicable either way.
    const registry = loadRegistry({ root, modelTiers: PI_TIERS });
    expect(resolveModel(getAgent(registry, "reconcile@1"), "command", registry.modelTiers)).toBeNull();
  });

  test("model override: malformed rejected, well-formed wins over the tier (WM-135)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    const tiers = PI_TIERS;
    writeFileSync(defFile, JSON.stringify({ ...def, model: "" }));
    expect(() => loadRegistry({ root, modelTiers: tiers })).toThrow(/"model"/);
    writeFileSync(defFile, JSON.stringify({ ...def, model: 42 }));
    expect(() => loadRegistry({ root, modelTiers: tiers })).toThrow(/"model"/);

    // Both fields allowed; the override wins, and it also satisfies load even
    // though "light" has no mapping — the tier is never consulted.
    writeFileSync(defFile, JSON.stringify({ ...def, model: "claude-opus-4-1", model_tier: "light" }));
    const registry = loadRegistry({ root, modelTiers: tiers });
    const loaded = getAgent(registry, "factory-status-report@1");
    expect(resolveModel(loaded, "claude", registry.modelTiers)).toBe("claude-opus-4-1");
  });

  test("resolveModel: override > tier map > adapter default; sentinel passes through (WM-135)", () => {
    const tiers = { claude: { strong: "default", standard: "sonnet", light: "haiku" } };
    expect(resolveModel({ ref: "x@1", model_tier: "standard" }, "claude", tiers)).toBe("sonnet");
    expect(resolveModel({ ref: "x@1", model_tier: "strong" }, "claude", tiers)).toBe(DEFAULT_MODEL);
    expect(resolveModel({ ref: "x@1", model: "haiku", model_tier: "strong" }, "claude", tiers)).toBe("haiku");
    expect(resolveModel({ ref: "x@1" }, "claude", tiers)).toBeNull(); // nothing declared → adapter default
    expect(resolveModel({ ref: "x@1", model_tier: "light" }, "command", tiers)).toBeNull(); // not applicable
    expect(() => resolveModel({ ref: "x@1", model_tier: "light" }, "claude", {})).toThrow(RegistryError);
  });

  test("loadModelTierMap: reads policy.yaml, validates shape fail-closed, tolerates absence (WM-135)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "event-policy-"));
    expect(loadModelTierMap({ root })).toEqual({}); // no policy.yaml at all
    mkdirSync(path.join(root, "config"), { recursive: true });
    const write = (yaml) => writeFileSync(path.join(root, "config", "policy.yaml"), yaml);

    write("concurrency:\n  max_in_flight_per_repo: 3\n"); // no models block
    expect(loadModelTierMap({ root })).toEqual({});

    write("models:\n  claude:\n    strong: default\n    standard: sonnet\n    light: haiku\n");
    expect(loadModelTierMap({ root })).toEqual({ claude: { strong: "default", standard: "sonnet", light: "haiku" } });

    write("models:\n  claude:\n    strnog: sonnet\n"); // typo'd tier key
    expect(() => loadModelTierMap({ root })).toThrow(/not a tier/);
    write("models:\n  claude:\n    standard: 7\n"); // non-string value
    expect(() => loadModelTierMap({ root })).toThrow(/non-empty model value/);
    write("models:\n  claude: sonnet\n"); // adapter entry not a map
    expect(() => loadModelTierMap({ root })).toThrow(/must map tiers/);
  });

  test("event type mapped to an unregistered agent fails closed", () => {
    const root = tempRegistry();
    writeFileSync(
      path.join(root, "event-types.json"),
      JSON.stringify({ "x.y": { agent: "ghost@9", idempotencyScope: ["correlationId"] } }),
    );
    expect(() => loadRegistry({ root })).toThrow(/unregistered agent/);
  });
});
