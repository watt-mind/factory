import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-extensions-test-mjs";
import { describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapterRegistry } from "./adapters/index.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import { openDb } from "./db.mjs";
import {
  EXTENSION_MANIFEST,
  EXTENSION_SCHEMA,
  CORE_HARNESS_NAME,
  CORE_HARNESS_PLUGIN,
  ExtensionError,
  RESERVED_CONTRIBUTIONS,
  applyConfigDefaults,
  collectHarnessRoots,
  getExtensionConfig,
  harnessPluginName,
  loadExtensionRoots,
  loadExtensions,
  loadedExtensions,
  validateExtensionManifest,
} from "./extensions.mjs";
import { createHookRegistry, hookDecisionsFor } from "./hooks.mjs";
import { getAgent, loadRegistry } from "./registry.mjs";
import { validate } from "./schema.mjs";

const SAMPLE_EXTENSION = path.join(
  RUNTIME_ROOT,
  "test-support",
  "extensions",
  "sample",
);
const SAMPLE_PACK = path.join(RUNTIME_ROOT, "test-support", "packs", "sample");

/** A writable copy of the fixture, optionally with its manifest rewritten. */
function tempExtension(mutate = () => {}) {
  const dir = tmpDir("event-extension-");
  cpSync(SAMPLE_EXTENSION, dir, { recursive: true });
  const manifestFile = path.join(dir, EXTENSION_MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const next = mutate(manifest, dir) ?? manifest;
  writeFileSync(manifestFile, JSON.stringify(next, null, 2));
  return dir;
}

function policyFor(...dirs) {
  return { extensions: dirs.map((p) => ({ path: p })) };
}

/** Load with an empty base pack list so the fixture never collides with the checkout's policy. */
function load(
  policy,
  adapterRegistry = createAdapterRegistry(),
  hookRegistry = createHookRegistry(),
) {
  return loadExtensions({
    policy,
    adapterRegistry,
    hookRegistry,
    packRoots: [],
  }).then((result) => ({ ...result, adapterRegistry, hookRegistry }));
}

describe("factory-extension.json schema", () => {
  test("accepts the decided manifest shape and rejects bad names/versions", () => {
    const ok = {
      name: "wattmind/mobile",
      version: "1.0.0",
      factory: { min: "0.x" },
      contributes: {
        packs: ["./pack"],
        adapters: { argent: "./adapters/argent.mjs" },
      },
    };
    expect(validate(EXTENSION_SCHEMA, ok)).toEqual({ valid: true, errors: [] });
    expect(
      validate(EXTENSION_SCHEMA, { ...ok, name: "Mobile" }).errors.join(),
    ).toMatch(/\$\.name: does not match pattern/);
    expect(
      validate(EXTENSION_SCHEMA, { ...ok, version: "1.0" }).errors.join(),
    ).toMatch(/\$\.version: does not match pattern/);
    expect(
      validate(EXTENSION_SCHEMA, {
        ...ok,
        contributes: { adapters: { argent: "./argent.js" } },
      }).errors.join(),
    ).toMatch(/adapters\.argent: does not match pattern/);
    expect(
      validate(EXTENSION_SCHEMA, { ...ok, extra: 1 }).errors.join(),
    ).toMatch(/unknown property "extra"/);
    expect(
      validate(EXTENSION_SCHEMA, {
        ...ok,
        contributes: { widgets: [] },
      }).errors.join(),
    ).toMatch(/unknown property "widgets"/);
  });

  test("reserved contribution keys are accepted by the schema", () => {
    for (const key of RESERVED_CONTRIBUTIONS) {
      const manifest = {
        name: "a/b",
        version: "0.0.1",
        contributes: { [key]: { anything: true } },
      };
      expect(validate(EXTENSION_SCHEMA, manifest).valid).toBe(true);
    }
  });

  test("contributes.harness accepts floor/commands/skills/subagents and rejects extras", () => {
    const ok = {
      name: "factory/core",
      version: "0.1.0",
      contributes: {
        harness: {
          floor: "./floor.md",
          commands: "./commands",
          skills: "./skills",
          subagents: "./agents",
        },
      },
    };
    expect(validate(EXTENSION_SCHEMA, ok)).toEqual({ valid: true, errors: [] });
    expect(
      validate(EXTENSION_SCHEMA, {
        ...ok,
        contributes: { harness: { widgets: [] } },
      }).errors.join(),
    ).toMatch(/unknown property "widgets"/);
  });
});

describe("loadExtensionRoots", () => {
  test("absent block is empty; non-array fails closed; bad entries are anomalies", () => {
    expect(loadExtensionRoots({ policy: {} })).toEqual({
      roots: [],
      anomalies: [],
    });
    expect(() =>
      loadExtensionRoots({ policy: { extensions: { path: "x" } } }),
    ).toThrow(ExtensionError);
    const root = tmpDir("event-extension-policy-");
    const out = loadExtensionRoots({
      root,
      policy: {
        extensions: [
          "just-a-string",
          { path: "" },
          { path: "vendor/one", name: "nope" },
          { path: "vendor/one" },
          { path: "vendor/one" },
          { path: "~/ext" },
        ],
      },
    });
    expect(out.roots.map((r) => r.path)).toEqual([
      path.join(root, "vendor", "one"),
      path.join(os.homedir(), "ext"),
    ]);
    expect(out.anomalies).toHaveLength(4);
    expect(out.anomalies[0]).toMatch(/extensions\[0\] must be an object/);
    expect(out.anomalies[1]).toMatch(/extensions\[1\]\.path must be/);
    expect(out.anomalies[2]).toMatch(/unknown field "name"/);
    expect(out.anomalies[3]).toMatch(/duplicate extension path/);
  });

  test("reads policy.yaml under root/config when no policy object is given", () => {
    const root = tmpDir("event-extension-policy-");
    mkdirSync(path.join(root, "config"));
    writeFileSync(
      path.join(root, "config", "policy.yaml"),
      "extensions:\n  - path: ext/one\n",
    );
    expect(loadExtensionRoots({ root }).roots).toEqual([
      { path: path.join(root, "ext", "one"), index: 0 },
    ]);
  });
});

describe("validateExtensionManifest", () => {
  test("the fixture is valid and reports no warnings", () => {
    const out = validateExtensionManifest(SAMPLE_EXTENSION);
    expect(out.valid).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(out.manifest.name).toBe("factory/sample");
  });

  test("checks that contributed paths exist and stay inside the extension", () => {
    const dir = tempExtension((m) => {
      m.contributes.packs.push("./missing", "../escape");
      m.contributes.adapters["bad-path"] = "./adapters/nope.mjs";
      m.contributes.adapters["Bad Name"] = "./adapters/echo.mjs";
      m.contributes.panels.push("./nope", "../escape", "./panels");
    });
    const out = validateExtensionManifest(dir);
    expect(out.valid).toBe(false);
    // Panels (WM-840): directories only — documents are validated at load.
    expect(out.errors.join("\n")).toMatch(
      /panels\[1\] ".\/nope" is not a directory/,
    );
    expect(out.errors.join("\n")).toMatch(/panels\[2\] "..\/escape" escapes/);
    expect(out.errors.join("\n")).toMatch(
      /panels\[3\] ".\/panels" listed twice/,
    );
    expect(out.errors.join("\n")).toMatch(
      /packs\[1\] ".\/missing" has no pack.json/,
    );
    expect(out.errors.join("\n")).toMatch(/packs\[2\] "..\/escape" escapes/);
    expect(out.errors.join("\n")).toMatch(
      /adapters\.bad-path .* is not a file/,
    );
    expect(out.errors.join("\n")).toMatch(/key "Bad Name" must match/);
  });
});

describe("loadExtensions", () => {
  test("happy path: packs join the registry, adapters register with the extension as source", async () => {
    const out = await load(policyFor(SAMPLE_EXTENSION));
    expect(out.anomalies).toEqual([]);
    expect(out.extensions).toEqual([
      {
        name: "factory/sample",
        version: "1.0.0",
        path: SAMPLE_EXTENSION,
        packs: ["sample-ext"],
        adapters: ["echo"],
        hooks: [
          { point: "approve.before", id: "factory/sample:approve-before" },
        ],
        panels: [path.join(SAMPLE_EXTENSION, "panels")],
        reserved: [],
        config: {
          namespace: "sample",
          schema: "./config.schema.json",
          values: {
            greeting: "hello",
            maxParallel: 1,
            limits: { timeoutSeconds: 30 },
          },
        },
      },
    ]);
    expect(out.packRoots).toEqual([
      {
        kind: "fs",
        name: "sample-ext",
        path: path.join(SAMPLE_EXTENSION, "pack"),
      },
    ]);
    // Panels (WM-840): the directories are handed to the registry, which
    // loads and validates the documents (lib/panel-view.test.mjs covers that).
    expect(out.panelRoots).toEqual([
      {
        dir: path.join(SAMPLE_EXTENSION, "panels"),
        origin: "extension:factory/sample",
        base: SAMPLE_EXTENSION,
      },
    ]);
    // Adapters go through the registry: contract-checked, sandbox-guarded, sourced.
    const entry = out.adapterRegistry.list().find((row) => row.name === "echo");
    expect(entry).toEqual({
      name: "echo",
      source: "factory/sample",
      sandboxSupport: "unsupported",
    });
    const result = await out.adapterRegistry
      .get("echo")
      .execute({ spec: { input: { hello: "world" } }, def: {} });
    expect(result).toEqual({ ok: true, echoed: { hello: "world" } });
    // Packs go through the existing pack loader, namespaced as pack.json says.
    const registry = loadRegistry({ packRoots: out.packRoots });
    expect(getAgent(registry, "sample-ext/echo@1").pack).toBe("sample-ext");
    expect(registry.eventTypes["sample-ext.echo.requested"].adapter).toBe(
      "echo",
    );
  });

  test("policy packs come first in packRoots and an extension pack may not reuse their name", async () => {
    const samplePack = {
      kind: "fs",
      name: "sample",
      path: SAMPLE_PACK,
      namespace: "sample",
    };
    const clash = tempExtension((m, dir) => {
      writeFileSync(
        path.join(dir, "pack", "pack.json"),
        JSON.stringify({ name: "sample", version: "1.0.0", namespace: "x" }),
      );
    });
    const out = await loadExtensions({
      policy: policyFor(clash, SAMPLE_EXTENSION),
      adapterRegistry: createAdapterRegistry(),
      packRoots: [samplePack],
    });
    expect(out.packRoots.map((p) => p.name)).toEqual(["sample", "sample-ext"]);
    expect(out.anomalies).toHaveLength(1);
    expect(out.anomalies[0]).toMatch(
      /pack name "sample" is already configured.*extension skipped/,
    );
  });

  test("a missing or malformed manifest is an anomaly and other extensions still load", async () => {
    const empty = tmpDir("event-extension-empty-");
    const badJson = tmpDir("event-extension-badjson-");
    writeFileSync(path.join(badJson, EXTENSION_MANIFEST), "{ nope");
    const badSchema = tempExtension((m) => {
      m.name = "NoSlash";
    });
    const out = await load(
      policyFor(empty, badJson, badSchema, SAMPLE_EXTENSION),
    );
    expect(out.extensions.map((e) => e.name)).toEqual(["factory/sample"]);
    expect(out.anomalies).toHaveLength(3);
    expect(out.anomalies[0]).toMatch(
      new RegExp(`extension ${empty}: missing ${EXTENSION_MANIFEST}.*skipped`),
    );
    expect(out.anomalies[1]).toMatch(/invalid JSON/);
    expect(out.anomalies[2]).toMatch(/\$\.name: does not match pattern/);
    expect(out.adapterRegistry.has("echo")).toBe(true);
  });

  test("a duplicate pack namespace/agent is refused by the registry rules and skips the extension", async () => {
    const twin = tempExtension((m) => {
      m.name = "factory/twin";
      m.contributes.adapters = { "echo-two": "./adapters/echo.mjs" };
    });
    const out = await load(policyFor(SAMPLE_EXTENSION, twin));
    expect(out.extensions.map((e) => e.name)).toEqual(["factory/sample"]);
    expect(out.packRoots.map((p) => p.name)).toEqual(["sample-ext"]);
    expect(out.anomalies).toHaveLength(1);
    // The twin's pack.json still says "sample-ext": the pack-name check fires first.
    expect(out.anomalies[0]).toMatch(
      /pack name "sample-ext" is already configured/,
    );
    // Nothing of a skipped extension is registered — not even its good adapter.
    expect(out.adapterRegistry.has("echo-two")).toBe(false);

    // Same namespace under a different pack name: the registry's own duplicate
    // agent ref rule fires and names both packs.
    const renamed = tempExtension((m, dir) => {
      m.name = "factory/renamed";
      m.contributes.adapters = {};
      writeFileSync(
        path.join(dir, "pack", "pack.json"),
        JSON.stringify({
          name: "sample-renamed",
          version: "1.0.0",
          namespace: "sample-ext",
        }),
      );
    });
    const again = await load(policyFor(SAMPLE_EXTENSION, renamed));
    expect(again.extensions.map((e) => e.name)).toEqual(["factory/sample"]);
    expect(again.anomalies[0]).toMatch(
      /duplicate agent ref "sample-ext\/echo@1" from packs "sample-ext" and "sample-renamed".*skipped/,
    );
  });

  test("a mutating agent in an extension pack is refused like any configured pack", async () => {
    const mutating = tempExtension((m, dir) => {
      m.name = "factory/mutating";
      m.contributes.adapters = {};
      const defFile = path.join(dir, "pack", "agents", "echo.json");
      const def = JSON.parse(readFileSync(defFile, "utf8"));
      def.mutating = true;
      writeFileSync(defFile, JSON.stringify(def));
    });
    const out = await load(policyFor(mutating));
    expect(out.extensions).toEqual([]);
    expect(out.anomalies[0]).toMatch(/may not declare mutating: true/);
  });

  test("a bad adapter skips the whole extension: contract failure, import failure, and name collisions", async () => {
    const noSandbox = tempExtension((m, dir) => {
      m.name = "factory/no-sandbox";
      writeFileSync(
        path.join(dir, "adapters", "echo.mjs"),
        "export async function execute() { return {}; }\n",
      );
    });
    const syntaxError = tempExtension((m, dir) => {
      m.name = "factory/syntax";
      writeFileSync(
        path.join(dir, "adapters", "echo.mjs"),
        "export const = ;\n",
      );
    });
    const shadowsBuiltin = tempExtension((m) => {
      m.name = "factory/shadow";
      m.contributes.packs = [];
      m.contributes.adapters = { fake: "./adapters/echo.mjs" };
    });
    const out = await load(
      policyFor(noSandbox, syntaxError, shadowsBuiltin, SAMPLE_EXTENSION),
    );
    expect(out.extensions.map((e) => e.name)).toEqual(["factory/sample"]);
    expect(out.packRoots.map((p) => p.name)).toEqual(["sample-ext"]);
    expect(out.anomalies).toHaveLength(3);
    expect(out.anomalies[0]).toMatch(
      /adapter "echo" does not satisfy the adapter contract \(SANDBOX_SUPPORT\).*skipped/,
    );
    expect(out.anomalies[1]).toMatch(/adapter "echo" failed to import/);
    expect(out.anomalies[2]).toMatch(
      /adapter "fake" is already registered.*may not replace/,
    );
    // The built-in survived untouched and the fixture's echo won the name.
    expect(
      out.adapterRegistry.list().find((r) => r.name === "fake").source,
    ).toBe("builtin");
    expect(
      out.adapterRegistry.list().find((r) => r.name === "echo").source,
    ).toBe("factory/sample");
  });

  test("reserved keys load the rest and record a not-supported-yet anomaly", async () => {
    const dir = tempExtension((m) => {
      m.name = "factory/future";
      m.contributes.views = [{ id: "x" }];
    });
    const out = await load(policyFor(dir));
    expect(out.extensions[0].reserved).toEqual(["views"]);
    expect(out.extensions[0].adapters).toEqual(["echo"]);
    expect(out.packRoots.map((p) => p.name)).toEqual(["sample-ext"]);
    expect(out.anomalies).toEqual([
      expect.stringMatching(/contributes\.views is not supported yet/),
    ]);
  });

  test("without an adapter registry, adapters are validated but nothing is registered", async () => {
    const out = await loadExtensions({
      policy: policyFor(SAMPLE_EXTENSION),
      packRoots: [],
    });
    expect(out.extensions[0].adapters).toEqual(["echo"]);
    expect(out.anomalies).toEqual([]);
  });

  test("an unreadable policy.yaml extensions block fails closed", async () => {
    const root = tmpDir("event-extension-policy-");
    mkdirSync(path.join(root, "config"));
    writeFileSync(
      path.join(root, "config", "policy.yaml"),
      "extensions:\n  path: nope\n",
    );
    await expect(loadExtensions({ root, packRoots: [] })).rejects.toThrow(
      /"extensions" must be an array/,
    );
    rmSync(root, { recursive: true, force: true });
  });
});

describe("extension config (contributes.config)", () => {
  const withValues = (config) => ({
    extensions: [{ path: SAMPLE_EXTENSION, config }],
  });

  test("valid values are validated against the schema and defaults fill the gaps", async () => {
    const out = await load(
      withValues({
        greeting: "hey",
        apiToken: "t0k3n",
        limits: { retries: 2 },
      }),
    );
    expect(out.anomalies).toEqual([]);
    expect(out.extensions[0].config).toEqual({
      namespace: "sample",
      schema: "./config.schema.json",
      values: {
        greeting: "hey",
        maxParallel: 1,
        apiToken: "t0k3n",
        limits: { retries: 2, timeoutSeconds: 30 },
      },
    });
    // The effective object is what adapters/hooks/panels read, by extension name.
    expect(getExtensionConfig("factory/sample")).toEqual(
      out.extensions[0].config.values,
    );
    expect(getExtensionConfig("nobody/here")).toBeUndefined();
    expect(loadedExtensions().extensions[0].name).toBe("factory/sample");
    expect(loadedExtensions().disabled).toEqual([]);
  });

  test("an invalid value disables the extension whole and names the failing path", async () => {
    const out = await load(withValues({ maxParallel: 9, bogus: true }));
    expect(out.extensions).toEqual([]);
    expect(out.packRoots).toEqual([]);
    expect(out.adapterRegistry.has("echo")).toBe(false);
    expect(out.anomalies).toHaveLength(1);
    expect(out.anomalies[0]).toMatch(
      /factory\/sample@1\.0\.0: config does not match \.\/config\.schema\.json — \$\.maxParallel: above maximum 4; \$: unknown property "bogus" \(extension skipped\)/,
    );
    expect(getExtensionConfig("factory/sample")).toBeUndefined();
    expect(loadedExtensions().disabled).toEqual([
      {
        name: "factory/sample",
        version: "1.0.0",
        path: SAMPLE_EXTENSION,
        namespace: "sample",
        reason: expect.stringMatching(/\$\.maxParallel: above maximum 4/),
      },
    ]);
  });

  test("a wrong-typed policy config entry is an entry anomaly, like any other bad field", () => {
    const out = loadExtensionRoots({
      policy: { extensions: [{ path: "x", config: "nope" }] },
    });
    expect(out.roots).toEqual([]);
    expect(out.anomalies[0]).toMatch(
      /config must be an object \(entry skipped\)/,
    );
  });

  test("values without a declared schema, and a schema that is missing, escaping or unsupported, disable the extension", async () => {
    const undeclared = tempExtension((m) => {
      m.name = "factory/undeclared";
      delete m.contributes.config;
    });
    const missing = tempExtension((m) => {
      m.name = "factory/missing";
      m.contributes.config.schema = "./nope.json";
    });
    const escaping = tempExtension((m) => {
      m.name = "factory/escaping";
      m.contributes.config.schema = "../config.schema.json";
    });
    const unsupported = tempExtension((m, dir) => {
      m.name = "factory/unsupported";
      writeFileSync(
        path.join(dir, "config.schema.json"),
        JSON.stringify({ type: "object", anyOf: [] }),
      );
    });
    const out = await loadExtensions({
      policy: {
        extensions: [
          { path: undeclared, config: { greeting: "x" } },
          { path: missing },
          { path: escaping },
          { path: unsupported },
        ],
      },
      packRoots: [],
    });
    expect(out.extensions).toEqual([]);
    expect(out.anomalies).toEqual([
      expect.stringMatching(
        /factory\/undeclared@1\.0\.0: policy.yaml gives config values but the manifest declares no contributes\.config/,
      ),
      expect.stringMatching(
        /contributes\.config\.schema ".\/nope.json" is not a file/,
      ),
      expect.stringMatching(
        /contributes\.config\.schema "..\/config.schema.json" escapes/,
      ),
      expect.stringMatching(/unsupported schema keyword "anyOf"/),
    ]);
  });

  test("two extensions may not share a config namespace", async () => {
    const twin = tempExtension((m, dir) => {
      m.name = "factory/twin";
      m.contributes.packs = [];
      m.contributes.adapters = {};
      delete m.contributes.hooks;
    });
    const out = await load(policyFor(SAMPLE_EXTENSION, twin));
    expect(out.extensions.map((e) => e.name)).toEqual(["factory/sample"]);
    expect(out.anomalies[0]).toMatch(
      /config namespace "sample" is already used by factory\/sample/,
    );
  });

  test("applyConfigDefaults fills schema.items defaults on array values", () => {
    const schema = {
      type: "object",
      properties: {
        servers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              host: { type: "string" },
              port: { type: "integer", default: 443 },
              retries: { type: "integer", default: 2 },
            },
          },
        },
        tags: {
          type: "array",
          default: [{ label: "x" }],
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              weight: { type: "integer", default: 1 },
            },
          },
        },
      },
    };
    expect(
      applyConfigDefaults(schema, {
        servers: [{ host: "a.example" }, { host: "b.example", port: 8443 }],
      }),
    ).toEqual({
      servers: [
        { host: "a.example", port: 443, retries: 2 },
        { host: "b.example", port: 8443, retries: 2 },
      ],
      tags: [{ label: "x", weight: 1 }],
    });
    // A missing array is not invented when the schema has no default.
    expect(
      applyConfigDefaults({ type: "array", items: { default: 1 } }, undefined),
    ).toBeUndefined();
    // Existing arrays still walk items even without an object wrapper.
    expect(
      applyConfigDefaults(
        {
          type: "array",
          items: { type: "object", properties: { n: { default: 1 } } },
        },
        [{}],
      ),
    ).toEqual([{ n: 1 }]);
  });

  test("validate refuses a manifest whose config key is malformed", () => {
    const bad = tempExtension((m) => {
      m.contributes.config = { namespace: "Bad Space" };
    });
    const out = validateExtensionManifest(bad);
    expect(out.valid).toBe(false);
    expect(out.errors.join("\n")).toMatch(
      /config\.namespace: does not match pattern/,
    );
    expect(out.errors.join("\n")).toMatch(
      /config: missing required property "schema"/,
    );
  });
});

describe("extension hooks (contributes.hooks)", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");
  const ctx = (labels = [], extra = {}) => ({
    proposal: { id: "proposal-1", runId: "run-1" },
    spec: { agent: "dispatch@1", input: { repo: "factory" } },
    evidence: { ticket: { labels }, escalatePathIntersections: [] },
    policy: null,
    repo: "factory",
    now,
    ...extra,
  });

  test("schema: hooks map a known point to a .mjs module; unknown points and other files are violations", () => {
    const base = { name: "a/b", version: "0.0.1" };
    expect(
      validate(EXTENSION_SCHEMA, {
        ...base,
        contributes: { hooks: { "approve.before": "./hooks/x.mjs" } },
      }).valid,
    ).toBe(true);
    expect(
      validate(EXTENSION_SCHEMA, {
        ...base,
        contributes: { hooks: { "plan.before": "./hooks/x.mjs" } },
      }).errors.join(),
    ).toMatch(/hooks: unknown property "plan.before"/);
    expect(
      validate(EXTENSION_SCHEMA, {
        ...base,
        contributes: { hooks: { "approve.before": "./hooks/x.js" } },
      }).errors.join(),
    ).toMatch(/approve\.before: does not match pattern/);
    expect(
      validate(EXTENSION_SCHEMA, {
        ...base,
        contributes: { hooks: ["./hooks/x.mjs"] },
      }).valid,
    ).toBe(false);
  });

  test("validate checks hook paths exist and stay inside the extension", () => {
    const dir = tempExtension((m) => {
      m.contributes.hooks = { "approve.before": "./hooks/missing.mjs" };
    });
    expect(validateExtensionManifest(dir).errors.join("\n")).toMatch(
      /hooks\["approve\.before"\] ".\/hooks\/missing.mjs" is not a file/,
    );
    const escaping = tempExtension((m) => {
      m.contributes.hooks = { "approve.before": "../escape.mjs" };
    });
    expect(validateExtensionManifest(escaping).errors.join("\n")).toMatch(
      /hooks\["approve\.before"\] "..\/escape.mjs" escapes/,
    );
    expect(validateExtensionManifest(SAMPLE_EXTENSION).valid).toBe(true);
  });

  test("the fixture hook registers after the built-in with source extension:<name> and sees the extension config", async () => {
    const out = await load({
      extensions: [{ path: SAMPLE_EXTENSION, config: { greeting: "deny" } }],
    });
    expect(out.anomalies).toEqual([]);
    expect(out.extensions[0].hooks).toEqual([
      { point: "approve.before", id: "factory/sample:approve-before" },
    ]);
    expect(out.hookRegistry.list()).toEqual([
      {
        point: "approve.before",
        id: "factory:escalation-labels",
        source: "builtin",
      },
      {
        point: "approve.before",
        id: "factory/sample:approve-before",
        source: "extension:factory/sample",
      },
    ]);
    // ctx.config is getExtensionConfig("factory/sample") — defaults applied
    // over the policy values — so greeting: "deny" makes the fixture deny.
    expect(getExtensionConfig("factory/sample").greeting).toBe("deny");
    const db = openDb(":memory:");
    const verdict = out.hookRegistry.run("approve.before", ctx(), { db, now });
    expect(verdict).toMatchObject({
      decision: "deny",
      reason: "sample_greeting_deny",
      hookId: "factory/sample:approve-before",
      source: "extension:factory/sample",
    });
    // The built-in ran first (allow), then the extension hook (deny); both persisted.
    expect(
      hookDecisionsFor(db, "proposal-1").map((r) => [r.hookId, r.decision]),
    ).toEqual([
      ["factory:escalation-labels", "allow"],
      ["factory/sample:approve-before", "deny"],
    ]);
    // Built-in first means an escalated ticket is refused before any extension hook runs.
    expect(
      out.hookRegistry.run("approve.before", ctx(["ai:escalated"])),
    ).toMatchObject({ reason: "escalated_or_security" });

    // Reloading with the default config: allow, and the label rule of the fixture.
    const again = await load(policyFor(SAMPLE_EXTENSION));
    expect(again.hookRegistry.run("approve.before", ctx())).toMatchObject({
      decision: "allow",
    });
    expect(
      again.hookRegistry.run("approve.before", ctx(["sample:deny"])),
    ).toMatchObject({ decision: "deny", reason: "sample_label_deny" });
  });

  test("a hook module missing default or id disables the extension whole", async () => {
    for (const [file, why] of [
      ["./hooks/no-default.mjs", /must export a default function/],
      ["./hooks/no-id.mjs", /must export a string id/],
    ]) {
      const dir = tempExtension((m) => {
        m.name = "factory/broken";
        m.contributes.hooks = { "approve.before": file };
      });
      const out = await load(policyFor(dir));
      expect(out.extensions).toEqual([]);
      expect(out.packRoots).toEqual([]);
      expect(out.adapterRegistry.has("echo")).toBe(false);
      expect(out.hookRegistry.list().map((h) => h.id)).toEqual([
        "factory:escalation-labels",
      ]);
      expect(out.anomalies).toHaveLength(1);
      expect(out.anomalies[0]).toMatch(
        /factory\/broken@1\.0\.0: hook "approve\.before"/,
      );
      expect(out.anomalies[0]).toMatch(why);
      expect(out.anomalies[0]).toMatch(/\(extension skipped\)/);
      expect(out.disabled[0]).toMatchObject({
        name: "factory/broken",
        reason: expect.stringMatching(why),
      });
    }
    const missing = tempExtension((m) => {
      m.name = "factory/gone";
      m.contributes.hooks = { "approve.before": "./hooks/nope.mjs" };
    });
    const out = await load(policyFor(missing));
    expect(out.extensions).toEqual([]);
    expect(out.anomalies[0]).toMatch(
      /hooks\["approve\.before"\] .* is not a file/,
    );
  });

  test("a hook id another extension (or a built-in) already registered disables the newcomer; reloads replace, never duplicate", async () => {
    const twin = tempExtension((m) => {
      m.name = "factory/twin";
      m.contributes.packs = [];
      m.contributes.adapters = {};
      delete m.contributes.config;
    });
    const out = await load(policyFor(SAMPLE_EXTENSION, twin));
    expect(out.extensions.map((e) => e.name)).toEqual(["factory/sample"]);
    expect(out.anomalies).toEqual([
      expect.stringMatching(
        /factory\/twin@1\.0\.0: hook id "factory\/sample:approve-before" is already registered/,
      ),
    ]);
    expect(out.hookRegistry.list().map((h) => h.id)).toEqual([
      "factory:escalation-labels",
      "factory/sample:approve-before",
    ]);

    // Same registry, loaded again: the extension hook is replaced, not doubled.
    const again = await load(
      policyFor(SAMPLE_EXTENSION),
      createAdapterRegistry(),
      out.hookRegistry,
    );
    expect(again.anomalies).toEqual([]);
    expect(again.hookRegistry.list().map((h) => h.id)).toEqual([
      "factory:escalation-labels",
      "factory/sample:approve-before",
    ]);
    // And with the extension gone from policy, its hook is gone too.
    const none = await load(
      { extensions: [] },
      createAdapterRegistry(),
      out.hookRegistry,
    );
    expect(none.hookRegistry.list().map((h) => h.id)).toEqual([
      "factory:escalation-labels",
    ]);

    // A built-in id cannot be shadowed by an extension.
    const shadow = tempExtension((m, dir) => {
      m.name = "factory/shadow";
      m.contributes.packs = [];
      m.contributes.adapters = {};
      delete m.contributes.config;
      writeFileSync(
        path.join(dir, "hooks", "shadow.mjs"),
        'export const id = "factory:escalation-labels";\nexport default () => ({ decision: "allow" });\n',
      );
      m.contributes.hooks = { "approve.before": "./hooks/shadow.mjs" };
    });
    const shadowed = await load(policyFor(shadow));
    expect(shadowed.extensions).toEqual([]);
    expect(shadowed.anomalies[0]).toMatch(
      /hook id "factory:escalation-labels" is already registered/,
    );
  });
});

describe("cli extensions", () => {
  const run = (...args) =>
    Bun.spawnSync({
      cmd: [process.execPath, "event-runtime/cli.mjs", "extensions", ...args],
      cwd: path.dirname(RUNTIME_ROOT),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_REPOS_ROOT: undefined },
    });

  test("validate <path> checks a manifest without loading it", () => {
    const ok = run("validate", SAMPLE_EXTENSION);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toMatch(
      /factory\/sample@1\.0\.0: valid \(1 pack, 1 adapter, config namespace sample\)/,
    );

    const noConfig = tempExtension((m) => {
      m.name = "factory/plain";
      delete m.contributes.config;
    });
    const plain = run("validate", noConfig);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout.toString()).toMatch(
      /factory\/plain@1\.0\.0: valid \(1 pack, 1 adapter\)/,
    );
    expect(plain.stdout.toString()).not.toMatch(/config namespace/);

    const bad = tempExtension((m) => {
      m.version = "one";
    });
    const failed = run("validate", bad);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr.toString()).toMatch(
      /\$\.version: does not match pattern/,
    );

    const usage = run("validate");
    expect(usage.exitCode).toBe(1);
    expect(usage.stderr.toString()).toMatch(
      /usage: extensions validate <path>/,
    );
  });

  test("list prints name, version, path and contribution counts from a policy root", () => {
    const root = tmpDir("event-extension-cli-");
    mkdirSync(path.join(root, "config"));
    const broken = tmpDir("event-extension-cli-broken-");
    // The dry pack load reads the model-tier map from the same policy, so the
    // temp policy carries the checkout's `models:` block alongside `extensions:`.
    const { models } = Bun.YAML.parse(
      readFileSync(
        path.join(path.dirname(RUNTIME_ROOT), "config", "policy.yaml"),
        "utf8",
      ),
    );
    writeFileSync(
      path.join(root, "config", "policy.yaml"),
      Bun.YAML.stringify({
        models,
        extensions: [{ path: SAMPLE_EXTENSION }, { path: broken }],
      }),
    );
    const out = Bun.spawnSync({
      cmd: [process.execPath, "event-runtime/cli.mjs", "extensions", "list"],
      cwd: path.dirname(RUNTIME_ROOT),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_REPOS_ROOT: root },
    });
    expect(out.exitCode).toBe(0);
    const text = out.stdout.toString();
    expect(text).toMatch(
      /EXTENSION\s+VERSION\s+PACKS\s+ADAPTERS\s+NAMESPACE\s+PATH/,
    );
    expect(text).toMatch(
      new RegExp(
        `factory/sample\\s+1\\.0\\.0\\s+1\\s+1\\s+sample\\s+${SAMPLE_EXTENSION}`,
      ),
    );
    expect(out.stderr.toString()).toMatch(
      new RegExp(`anomaly: extension ${broken}: missing ${EXTENSION_MANIFEST}`),
    );

    const json = Bun.spawnSync({
      cmd: [
        process.execPath,
        "event-runtime/cli.mjs",
        "extensions",
        "list",
        "--json",
      ],
      cwd: path.dirname(RUNTIME_ROOT),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_REPOS_ROOT: root },
    });
    const parsed = JSON.parse(json.stdout.toString());
    expect(parsed.extensions[0].name).toBe("factory/sample");
    expect(parsed.extensions[0].config.namespace).toBe("sample");
    expect(parsed.anomalies).toHaveLength(1);
  });
});

function harnessExtension(mutate = () => {}) {
  const dir = tmpDir("event-harness-");
  mkdirSync(path.join(dir, "commands"));
  mkdirSync(path.join(dir, "skills", "demo"), { recursive: true });
  mkdirSync(path.join(dir, "agents"));
  writeFileSync(path.join(dir, "floor.md"), "# floor\n");
  writeFileSync(path.join(dir, "commands", "demo.md"), "# demo\n");
  writeFileSync(
    path.join(dir, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: demo skill\n---\n",
  );
  writeFileSync(
    path.join(dir, "agents", "demo-agent.md"),
    "---\nname: demo-agent\ndescription: A demo subagent.\n---\n\nbody\n",
  );
  const manifest = {
    name: "acme/tools",
    version: "1.0.0",
    contributes: {
      harness: {
        floor: "./floor.md",
        commands: "./commands",
        skills: "./skills",
        subagents: "./agents",
      },
    },
  };
  const next = mutate(manifest, dir) ?? manifest;
  writeFileSync(
    path.join(dir, EXTENSION_MANIFEST),
    JSON.stringify(next, null, 2),
  );
  return dir;
}

describe("contributes.harness (WM-849)", () => {
  const SHARED = path.join(path.dirname(RUNTIME_ROOT), "shared");

  test("the built-in shared/ pack is factory/core and validates", () => {
    const out = validateExtensionManifest(SHARED);
    expect(out.valid).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.manifest.name).toBe(CORE_HARNESS_NAME);
    expect(out.manifest.contributes.harness).toEqual({
      floor: "./floor.md",
      commands: "./commands",
      skills: "./skills",
      subagents: "./agents",
    });
    expect(harnessPluginName(CORE_HARNESS_NAME, { builtin: true })).toBe(
      CORE_HARNESS_PLUGIN,
    );
  });

  test("collectHarnessRoots puts shared/ first and skips policy extensions without harness", () => {
    const { roots, anomalies } = collectHarnessRoots({
      builtin: SHARED,
      policy: { extensions: [{ path: SAMPLE_EXTENSION }] },
    });
    expect(anomalies).toEqual([]);
    expect(roots[0].builtin).toBe(true);
    expect(roots[0].name).toBe(CORE_HARNESS_NAME);
    expect(roots[0].plugin).toBe(CORE_HARNESS_PLUGIN);
    expect(roots[0].prefix).toBeNull();
    expect(roots).toHaveLength(1);
  });

  test("a third-party harness pack is namespaced; plugin name core is reserved", async () => {
    const extra = harnessExtension();
    const collected = collectHarnessRoots({
      builtin: SHARED,
      policy: { extensions: [{ path: extra }] },
    });
    expect(collected.anomalies).toEqual([]);
    expect(collected.roots.map((r) => r.plugin)).toEqual([
      CORE_HARNESS_PLUGIN,
      "acme-tools",
    ]);
    expect(collected.roots[1].prefix).toBe("acme-tools");

    const stolen = harnessExtension((m) => {
      m.name = "factory/core";
    });
    const clash = collectHarnessRoots({
      builtin: SHARED,
      policy: { extensions: [{ path: stolen }] },
    });
    expect(clash.roots.map((r) => r.plugin)).toEqual([CORE_HARNESS_PLUGIN]);
    expect(clash.anomalies.join("\n")).toMatch(
      /harness name "factory\/core" is already contributed/,
    );

    const slugA = harnessExtension((m) => {
      m.name = "foo/bar-baz";
    });
    const slugB = harnessExtension((m) => {
      m.name = "foo-bar/baz";
    });
    const slugs = collectHarnessRoots({
      policy: { extensions: [{ path: slugA }, { path: slugB }] },
    });
    expect(slugs.roots.map((r) => r.plugin)).toEqual(["foo-bar-baz"]);
    expect(slugs.anomalies.join("\n")).toMatch(
      /harness plugin "foo-bar-baz" is already contributed/,
    );

    const loaded = await load(policyFor(extra));
    expect(loaded.anomalies).toEqual([]);
    expect(loaded.harnessRoots).toHaveLength(1);
    expect(loaded.harnessRoots[0].plugin).toBe("acme-tools");
    expect(loaded.extensions[0].harness).toEqual({
      plugin: "acme-tools",
      prefix: "acme-tools",
    });
  });

  test("harness paths must exist and stay inside the extension", () => {
    const dir = harnessExtension((m) => {
      m.contributes.harness.floor = "./missing.md";
      m.contributes.harness.commands = "../escape";
    });
    const out = validateExtensionManifest(dir);
    expect(out.valid).toBe(false);
    expect(out.errors.join("\n")).toMatch(/harness\.floor .* is not a file/);
    expect(out.errors.join("\n")).toMatch(/harness\.commands .* escapes/);
  });
});
