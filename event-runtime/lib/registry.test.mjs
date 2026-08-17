import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJson, hashBytes } from "./canonical.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import {
  DEFAULT_MODEL,
  RegistryError,
  createFsPackLoader,
  getAgent,
  getArtifactView,
  getEventType,
  loadModelTierMap,
  loadPackRoots,
  loadRegistry,
  resolveModel,
  updatePins,
} from "./registry.mjs";
import { computeDefHash } from "./receipts.mjs";

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
const SAMPLE_PACK_ROOT = path.join(RUNTIME_ROOT, "test-support", "packs", "sample");

function samplePack(root = SAMPLE_PACK_ROOT, name = "sample", namespace = "sample") {
  return { kind: "fs", name, path: root, namespace };
}

function tempPack({ name = "sample", namespace = "sample" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "event-pack-"));
  cpSync(SAMPLE_PACK_ROOT, root, { recursive: true });
  writeFileSync(path.join(root, "pack.json"), `${JSON.stringify({ name, version: "1.0.0", namespace }, null, 2)}\n`);
  return samplePack(root, name, namespace);
}

function registryDigest(registry) {
  const agents = Object.fromEntries(
    [...registry.agents].map(([ref, def]) => {
      const { pack: _pack, promptPath, ...stable } = def;
      return [ref, { ...stable, promptPath: path.relative(registry.root, promptPath) }];
    }),
  );
  return hashBytes(
    canonicalJson({
      agents,
      eventTypes: registry.eventTypes,
      edges: registry.edges,
      schedules: registry.schedules,
      modelTiers: registry.modelTiers,
    }),
  );
}

const PI_TIERS = {
  claude: { strong: "default", standard: "sonnet", light: "haiku" },
  pi: {
    strong: "openai-codex/gpt-5.6-sol",
    standard: "openai-codex/gpt-5.6-terra",
    light: "openai-codex/gpt-5.6-luna",
  },
  agy: {
    strong: "gemini-3.7-flash",
    standard: "gemini-3.7-flash",
    light: "gemini-3.7-flash",
  },
  cursor: {
    strong: "composer-2.5",
    standard: "composer-2.5",
    light: "composer-2.5-fast",
  },
};

describe("registry", () => {
  test("loads the committed registry (pins verified)", () => {
    const registry = loadRegistry();
    const def = getAgent(registry, "factory-status-report@1");
    expect(def.outputSchema.required).toContain("recommendedAction");
    expect(def.pack).toBe("event-runtime");
    expect(registry.packs).toEqual([{ name: "event-runtime", root: RUNTIME_ROOT, namespace: "" }]);
    expect(getEventType(registry, "factory.status-report.requested").agent).toBe("factory-status-report@1");
    expect(getEventType(registry, "unknown.event")).toBeNull();
  });

  test("zero-pack merged-view digest matches the develop baseline", () => {
    // Regenerate with registryDigest(loadRegistry({ packRoots: [] })) on develop.
    // The serializer omits only WM-470's new pack provenance and normalizes
    // the absolute prompt path. Changing this digest requires an explicit
    // reason in the PR body: it is the mechanical zero-pack compatibility gate.
    const expected = "sha256:65fd52598a910dc92f9657eeddce3cd1af10695b8f24fceece24ed1f4b33f580";
    expect(registryDigest(loadRegistry({ packRoots: [] }))).toBe(expected);
  });

  test("pack provenance never enters the receipt defHash (WM-470)", () => {
    // The absolute constant is the whole point: it is develop's defHash for
    // this definition, whose content WM-470 did not touch. computeDefHash
    // strips the known runtime-injected fields and hashes the enumerable rest,
    // so any new enumerable key silently re-hashes every built-in agent and
    // makes verifyDefHash refuse them with `agent_definition_mismatch`. `pack`
    // is therefore defined non-enumerably: readable by callers, invisible to
    // the hash. Do not "update" this constant — a change here means a
    // provenance break, not a stale expectation.
    const registry = loadRegistry();
    const def = registry.agents.get("dispatch@1");
    expect(def.pack).toBe("event-runtime");
    expect(Object.keys(def)).not.toContain("pack");
    expect(computeDefHash(def)).toBe("sha256:323836eeac3c5b7370dc13e83cbe4f0d7cc029155e76ea0fc80672b7a7f973fd");
  });

  test("loads a namespaced filesystem pack and validates the merged maps", () => {
    const registry = loadRegistry({ packRoots: [samplePack()] });
    const def = getAgent(registry, "sample/echo@1");
    expect(def.pack).toBe("sample");
    expect(def.promptPath).toBe(path.join(SAMPLE_PACK_ROOT, "agents", "echo.md"));
    expect(def.pins).toEqual(JSON.parse(readFileSync(path.join(SAMPLE_PACK_ROOT, "pins.json"), "utf8")));
    expect(Object.entries(def.pins)).toHaveLength(3);
    expect(getEventType(registry, "sample.echo.requested").agent).toBe("sample/echo@1");
    expect(getEventType(registry, "sample.core-status.requested").agent).toBe("factory-status-report@1");
    expect(registry.edges["sample/echo@1"].recommendationField).toBe("message");
    expect(registry.schedules["sample-echo"].eventType).toBe("sample.echo.requested");
    expect(registry.packs.map((pack) => pack.name)).toEqual(["event-runtime", "sample"]);
  });

  test("merged validation accepts a loader with no filesystem access", () => {
    const resources = {
      "agents/echo.md": "Return the input unchanged.\n",
      "schemas/echo.input.json": JSON.stringify({ type: "object" }),
      "schemas/echo.output.json": JSON.stringify({ type: "object" }),
    };
    const definition = {
      id: "echo",
      version: 1,
      prompt: "agents/echo.md",
      input_schema: "schemas/echo.input.json",
      output_schema: "schemas/echo.output.json",
      workspace: { type: "ephemeral", retainOnFailure: false },
      capabilities: { filesystem: "read-only", services: [] },
      limits: { timeout_seconds: 30, attempts: 1 },
      mutating: false,
    };
    const pins = Object.fromEntries(Object.entries(resources).map(([name, bytes]) => [name, hashBytes(bytes)]));
    const loader = {
      listAgentDefs: () => [{ source: "memory:agents/echo.json", definition }],
      readPinned: (relative) => ({
        expected: pins[relative],
        bytes: resources[relative],
        source: `memory:${relative}`,
        path: `memory:${relative}`,
      }),
      readMap: (name) =>
        name === "event-types"
          ? {
              "memory.echo.requested": {
                agent: "memory/echo@1",
                adapter: "fake",
                idempotencyScope: ["correlationId"],
              },
            }
          : Object.create(null),
    };
    const registry = loadRegistry({
      packRoots: [{ kind: "memory", name: "memory", namespace: "memory", root: "memory:pack" }],
      loaderFor: (pack, options) => (pack.kind === "memory" ? loader : createFsPackLoader(pack, options)),
    });
    const def = getAgent(registry, "memory/echo@1");
    expect(def.promptPath).toBe("memory:agents/echo.md");
    expect(def.pins).toEqual(pins);
    expect(getEventType(registry, "memory.echo.requested").agent).toBe("memory/echo@1");
  });

  test("duplicate agent refs identify both source packs", () => {
    const other = tempPack({ name: "other", namespace: "sample" });
    expect(() => loadRegistry({ packRoots: [samplePack(), other] })).toThrow(
      /duplicate agent ref.*sample.*other/,
    );
  });

  test("map collisions identify both source packs", () => {
    for (const [file, key, label] of [
      ["event-types.json", "factory.status-report.requested", "event type"],
      ["edges.json", "disk-diagnose@1", "edge source"],
      ["schedules.json", "reaper", "schedule loop"],
    ]) {
      const pack = tempPack();
      writeFileSync(path.join(pack.path, file), JSON.stringify({ [key]: {} }));
      expect(() => loadRegistry({ packRoots: [pack] })).toThrow(
        new RegExp(`duplicate ${label}.*event-runtime.*sample`),
      );
    }
  });

  test("prototype-like map keys collide normally without polluting merged maps", () => {
    const first = tempPack();
    const second = tempPack({ name: "other", namespace: "other" });
    const protoEvent = '{"__proto__":{"observe":true}}';
    writeFileSync(path.join(first.path, "event-types.json"), protoEvent);
    writeFileSync(path.join(second.path, "event-types.json"), protoEvent);
    expect(() => loadRegistry({ packRoots: [first, second] })).toThrow(
      /duplicate event type "__proto__".*sample.*other/,
    );

    const registry = loadRegistry({ packRoots: [] });
    expect(Object.getPrototypeOf(registry.eventTypes)).toBeNull();
    expect(Object.getPrototypeOf(registry.edges)).toBeNull();
    expect(Object.getPrototypeOf(registry.schedules)).toBeNull();
    expect(getEventType(registry, "toString")).toBeNull();
  });

  test("inherited object names cannot satisfy event references", () => {
    const edgePack = tempPack();
    writeFileSync(
      path.join(edgePack.path, "edges.json"),
      JSON.stringify({
        "sample/echo@1": {
          recommendationField: "message",
          edges: { BAD: { eventType: "toString" } },
        },
      }),
    );
    expect(() => loadRegistry({ packRoots: [edgePack] })).toThrow(/targets unregistered event type toString/);

    const schedulePack = tempPack();
    writeFileSync(
      path.join(schedulePack.path, "schedules.json"),
      JSON.stringify({
        "inherited-event": {
          every: "60m",
          eventType: "constructor",
          approval: "watched",
          enabled: false,
        },
      }),
    );
    expect(() => loadRegistry({ packRoots: [schedulePack] })).toThrow(/fires unregistered event type constructor/);
  });

  test("exactly one pack owns the bare namespace", () => {
    const bare = tempPack({ name: "bare-extra", namespace: "" });
    expect(() => loadRegistry({ packRoots: [bare] })).toThrow(/exactly one pack must own the bare namespace.*event-runtime.*bare-extra/);
  });

  test("config-listed packs cannot admit mutating agents", () => {
    const pack = tempPack();
    const defFile = path.join(pack.path, "agents", "echo.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...def, mutating: true }));
    expect(() => loadRegistry({ packRoots: [pack] })).toThrow(/config-listed pack.*may not declare mutating: true.*WM-468/);
  });

  test("a pack agent that merely omits mutating is not refused by the pack rule (WM-470)", () => {
    // The pack restriction is on the declaration, not on its absence: only an
    // explicit `mutating: true` is refused (docs/kernel-and-packs.md). The
    // kernel's §14 admission rule is separate and still applies to every root,
    // so an omitting def must additionally be enforceable by construction.
    const pack = tempPack();
    const defFile = path.join(pack.path, "agents", "echo.json");
    const { mutating: _mutating, ...def } = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify(def));
    expect(() => loadRegistry({ packRoots: [pack] })).not.toThrow(/may not declare mutating: true/);
    writeFileSync(defFile, JSON.stringify({ ...def, command: ["true"] }));
    const registry = loadRegistry({ packRoots: [pack] });
    expect(getAgent(registry, "sample/echo@1").mutating).toBeUndefined();
  });

  test("pack manifest and pins fail closed, and explicit pack pinning repairs drift", () => {
    const pack = tempPack();
    const prompt = path.join(pack.path, "agents", "echo.md");
    writeFileSync(prompt, `${readFileSync(prompt, "utf8")}drift\n`);
    expect(() => loadRegistry({ packRoots: [pack] })).toThrow(/does not match pin/);
    expect(updatePins({ pack })).toEqual(["sample"]);
    expect(() => loadRegistry({ packRoots: [pack] })).not.toThrow();
    writeFileSync(path.join(pack.path, "pins.json"), "not-json\n");
    expect(updatePins({ pack })).toEqual(["sample"]);
    expect(() => loadRegistry({ packRoots: [pack] })).not.toThrow();

    const mismatched = tempPack({ name: "policy-name" });
    writeFileSync(
      path.join(mismatched.path, "pack.json"),
      JSON.stringify({ name: "manifest-name", version: "1.0.0", namespace: "sample" }),
    );
    expect(() => loadRegistry({ packRoots: [mismatched] })).toThrow(/does not match policy name/);
  });

  test("loadPackRoots reads only policy-listed roots and validates fail-closed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "event-policy-packs-"));
    mkdirSync(path.join(root, "config"), { recursive: true });
    const policy = path.join(root, "config", "policy.yaml");
    expect(loadPackRoots({ root })).toEqual([]);

    writeFileSync(policy, "packs:\n  - name: sample\n    path: vendor/sample\n    namespace: sample\n");
    expect(loadPackRoots({ root })).toEqual([
      { kind: "fs", name: "sample", path: path.join(root, "vendor", "sample"), namespace: "sample" },
    ]);
    writeFileSync(policy, "packs:\n  sample: vendor/sample\n");
    expect(() => loadPackRoots({ root })).toThrow(/packs.*array/);
    writeFileSync(policy, "packs:\n  - name: sample\n    path: one\n  - name: sample\n    path: two\n");
    expect(() => loadPackRoots({ root })).toThrow(/duplicate pack name/);
  });

  test("update-pins --pack rejects missing and unknown pack names", () => {
    const run = (...args) =>
      Bun.spawnSync({
        cmd: [process.execPath, "event-runtime/cli.mjs", "update-pins", ...args],
        cwd: path.dirname(RUNTIME_ROOT),
        stdout: "pipe",
        stderr: "pipe",
      });
    const missing = run("--pack");
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain("usage: update-pins [--pack NAME]");

    const unknown = run("--pack", "not-configured");
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr.toString()).toContain('unknown configured pack "not-configured"');
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

  test("artifact-view sidecars load beside their definition and are served off the pinned identity (WM-454)", () => {
    const registry = loadRegistry();
    // The committed views: present, validated, keyed by ref, not on the def.
    const merge = getArtifactView(registry, "merge-scan@2");
    expect(merge.file).toBe("agents/merge-scan.view.json");
    expect(merge.view.schemaVersion).toBe("factory.artifact-view/v1");
    expect(getArtifactView(registry, "triage-scan@1").view.status.path).toBe("/recommendation");
    expect(getArtifactView(registry, "reconcile@1")).toEqual({ file: null, view: null });
    expect(getArtifactView(registry, "ghost@9")).toEqual({ file: null, view: null });
    expect(registry.anomalies).toEqual([]);
    // Views are not part of the definition pin nor of the receipt defHash:
    // the def object never carries them, and the sidecar has no pin entry.
    const def = getAgent(registry, "merge-scan@2");
    expect(def.outputView).toBeUndefined();
    expect(Object.keys(def.pins)).not.toContain("agents/merge-scan.view.json");
    const { promptPath, inputSchema, outputSchema, ...pinnedIdentity } = def;
    expect(computeDefHash(def)).toBe(computeDefHash({ ...pinnedIdentity, promptPath, inputSchema, outputSchema }));
    // A .view.json file is never mistaken for a definition, and re-pinning
    // leaves it alone.
    expect([...registry.agents.keys()].some((ref) => ref.includes(".view"))).toBe(false);
    const root = tempRegistry();
    expect(updatePins({ root })).toEqual([]);
  });

  test("a view that drifts from its schema is a configuration anomaly, not a load error (WM-454)", () => {
    const root = tempRegistry();
    const viewFile = path.join(root, "agents", "merge-scan.view.json");
    const view = JSON.parse(readFileSync(viewFile, "utf8"));
    view.sections[0].columns.push("owner");
    view.status.path = "/verdict";
    writeFileSync(viewFile, JSON.stringify(view));
    const registry = loadRegistry({ root, modelTiers: PI_TIERS });
    // Served without a view; the anomaly names the agent, the file and the errors.
    expect(getArtifactView(registry, "merge-scan@2")).toEqual({ file: "agents/merge-scan.view.json", view: null });
    expect(registry.anomalies).toHaveLength(1);
    expect(registry.anomalies[0]).toContain("merge-scan@2");
    expect(registry.anomalies[0]).toContain("agents/merge-scan.view.json");
    expect(registry.anomalies[0]).toMatch(/"owner" does not resolve/);
    expect(registry.anomalies[0]).toMatch(/"\/verdict" does not resolve/);
    // Other agents' views are unaffected.
    expect(getArtifactView(registry, "triage-scan@1").view).not.toBeNull();
    // Unparseable JSON is the same class of anomaly.
    writeFileSync(viewFile, "{ not json");
    const again = loadRegistry({ root, modelTiers: PI_TIERS });
    expect(getArtifactView(again, "merge-scan@2").view).toBeNull();
    expect(again.anomalies[0]).toMatch(/unparseable/);
    // A schema-invalid document (bad `as`) is refused the same way.
    writeFileSync(viewFile, JSON.stringify({ ...view, sections: [{ path: "/plan", as: "chart" }] }));
    expect(loadRegistry({ root, modelTiers: PI_TIERS }).anomalies[0]).toMatch(/not in enum/);
  });
});
