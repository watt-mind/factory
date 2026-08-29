import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-extensions-test-mjs";
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { packExtension } from "../cli/extensions.mjs";
import { createAdapterRegistry } from "./adapters/index.mjs";
import { RUNTIME_ROOT, resolveConfigPath } from "./config.mjs";
import { openDb } from "./db.mjs";
import {
  EXTENSION_MANIFEST,
  EXTENSION_SCHEMA,
  CORE_HARNESS_NAME,
  CORE_HARNESS_PLUGIN,
  ExtensionError,
  RESERVED_CONTRIBUTIONS,
  applyConfigDefaults,
  collectSecretFields,
  collectHarnessRoots,
  contributionCounts,
  discoverExtensionPackRoots,
  extensionSecretEnvVar,
  formatContributionCounts,
  getExtensionConfig,
  harnessPluginName,
  loadExtensionRoots,
  loadExtensions,
  loadedExtensions,
  looksLikePackageName,
  maskExtensionSecrets,
  resetExtensionSecretsCache,
  resolveExtensionPackage,
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

/**
 * Install the sample fixture as an npm package under a temp factory root
 * (`node_modules/@test/sample-ext` → realpath of a copy, WM-922).
 */
function sampleAsPackage({
  name = "@test/sample-ext",
  version = "1.2.3",
  factoryExtension,
  mutate,
} = {}) {
  const factoryRoot = tmpDir("event-extension-pkgfactory-");
  const installed = tmpDir("event-extension-pkginstall-");
  cpSync(SAMPLE_EXTENSION, installed, { recursive: true });
  const pkg = {
    name,
    version,
    type: "module",
    engines: { bun: ">=1.3" },
    keywords: ["factory-extension"],
    files: [
      "factory-extension.json",
      "pack",
      "adapters",
      "config.schema.json",
      "hooks",
      "connectors",
      "panels",
    ],
  };
  if (factoryExtension) pkg.factory = { extension: factoryExtension };
  mutate?.(pkg, installed, factoryRoot);
  writeFileSync(
    path.join(installed, "package.json"),
    JSON.stringify(pkg, null, 2),
  );
  const nm = path.join(factoryRoot, "node_modules", ...name.split("/"));
  mkdirSync(path.dirname(nm), { recursive: true });
  symlinkSync(installed, nm);
  return { factoryRoot, installed, nm, name, version };
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

describe("extension pack metadata discovery (gh-857)", () => {
  test("discovers path and package extension packs without importing adapters", () => {
    const pathExtension = tempExtension();
    const sentinel = path.join(tmpDir("event-extension-sentinel-"), "ran");
    writeFileSync(
      path.join(pathExtension, "adapters", "echo.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "ran"); export default {};`,
    );
    const pathPacks = discoverExtensionPackRoots({
      policy: policyFor(pathExtension),
    });
    expect(pathPacks).toEqual([
      {
        kind: "fs",
        name: "sample-ext",
        path: path.join(pathExtension, "pack"),
      },
    ]);
    expect(existsSync(sentinel)).toBe(false);

    const { factoryRoot, name, installed } = sampleAsPackage();
    const packagePacks = discoverExtensionPackRoots({
      root: factoryRoot,
      policy: { extensions: [{ package: name }] },
    });
    expect(packagePacks).toEqual([
      {
        kind: "fs",
        name: "sample-ext",
        path: path.join(realpathSync(installed), "pack"),
      },
    ]);
  });

  test("fails closed for invalid manifests and duplicate contributed pack names", () => {
    const escaped = tempExtension((manifest) => {
      manifest.contributes.packs = ["../outside"];
    });
    expect(() =>
      discoverExtensionPackRoots({ policy: policyFor(escaped) }),
    ).toThrow(/contributes\.packs\[0\].*escapes/);

    const first = tempExtension();
    const second = tempExtension();
    expect(() =>
      discoverExtensionPackRoots({ policy: policyFor(first, second) }),
    ).toThrow(/pack name "sample-ext" is already configured/);
    expect(() =>
      discoverExtensionPackRoots({
        policy: policyFor(first),
        packRoots: [{ kind: "fs", name: "sample-ext", path: SAMPLE_PACK }],
      }),
    ).toThrow(/pack name "sample-ext" is already configured/);
  });

  test("scopes discovery failures to the requested pack name", () => {
    const broken = tempExtension((manifest) => {
      manifest.contributes.packs = ["../outside"];
    });
    const healthy = tempExtension((manifest) => {
      manifest.name = "factory/healthy";
    });
    writeFileSync(
      path.join(healthy, "pack", "pack.json"),
      `${JSON.stringify({ name: "healthy-ext", version: "1.0.0", namespace: "healthy" })}\n`,
    );
    const policy = policyFor(broken, healthy);

    // Unscoped discovery still fails closed on the unrelated broken manifest.
    expect(() => discoverExtensionPackRoots({ policy })).toThrow(
      /contributes\.packs\[0\].*escapes/,
    );
    // A request for the healthy pack is not blocked by the broken sibling.
    expect(discoverExtensionPackRoots({ policy, name: "healthy-ext" })).toEqual(
      [{ kind: "fs", name: "healthy-ext", path: path.join(healthy, "pack") }],
    );
    // A miss surfaces the collected errors so the operator sees why.
    expect(() =>
      discoverExtensionPackRoots({ policy, name: "missing-ext" }),
    ).toThrow(/pack "missing-ext" not found; rejected: .*escapes/);
    // A clean miss stays a plain miss.
    expect(
      discoverExtensionPackRoots({ policy: policyFor(healthy), name: "nope" }),
    ).toEqual([]);

    // A duplicate of the requested name itself still fails closed, while a
    // duplicate elsewhere is skipped.
    const first = tempExtension();
    const second = tempExtension();
    const duplicated = policyFor(first, second, healthy);
    expect(() =>
      discoverExtensionPackRoots({ policy: duplicated, name: "sample-ext" }),
    ).toThrow(/pack name "sample-ext" is already configured/);
    expect(
      discoverExtensionPackRoots({ policy: duplicated, name: "healthy-ext" }),
    ).toEqual([
      { kind: "fs", name: "healthy-ext", path: path.join(healthy, "pack") },
    ]);
  });

  test("update-pins repairs a stale extension pack without executing it", async () => {
    const factoryRoot = tmpDir("event-extension-repair-root-");
    const extension = tempExtension();
    const sentinel = path.join(factoryRoot, "extension-imported");
    writeFileSync(
      path.join(extension, "adapters", "echo.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinel)}, "ran");
export const SANDBOX_SUPPORT = "unsupported";
export async function execute({ spec } = {}) {
  return { ok: true, echoed: spec?.input ?? null };
}
`,
    );
    writeFileSync(
      path.join(extension, "pack", "agents", "echo.md"),
      "drifted extension prompt\n",
    );
    mkdirSync(path.join(factoryRoot, "config"), { recursive: true });
    writeFileSync(
      path.join(factoryRoot, "config", "policy.yaml"),
      `extensions:\n  - path: ${JSON.stringify(extension)}\n`,
    );
    const pins = path.join(extension, "pack", "pins.json");
    const stalePins = readFileSync(pins, "utf8");
    const policy = policyFor(extension);
    const ordinaryLoad = () =>
      loadExtensions({
        root: factoryRoot,
        policy,
        adapterRegistry: createAdapterRegistry(),
        hookRegistry: createHookRegistry(),
        packRoots: [],
      });
    expect((await ordinaryLoad()).disabled[0].reason).toMatch(
      /does not match pin/,
    );

    const run = (...args) =>
      Bun.spawnSync({
        cmd: [
          process.execPath,
          "event-runtime/cli.mjs",
          "update-pins",
          ...args,
        ],
        cwd: path.dirname(RUNTIME_ROOT),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FACTORY_REPOS_ROOT: factoryRoot },
      });
    const checked = run("--pack", "sample-ext", "--check");
    expect(checked.exitCode).not.toBe(0);
    expect(checked.stderr.toString()).toContain("pins stale: sample-ext");
    expect(readFileSync(pins, "utf8")).toBe(stalePins);
    expect(existsSync(sentinel)).toBe(false);

    const repaired = run("--pack", "sample-ext");
    expect(repaired.exitCode).toBe(0);
    expect(repaired.stdout.toString()).toContain("re-pinned: sample-ext");
    expect(readFileSync(pins, "utf8")).not.toBe(stalePins);
    expect(existsSync(sentinel)).toBe(false);

    const loaded = await ordinaryLoad();
    expect(loaded.anomalies).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
  });
});

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

  test("contributes.connectors is an object of name → .mjs path", () => {
    const ok = {
      name: "a/b",
      version: "0.0.1",
      contributes: { connectors: { echo: "./connectors/echo.mjs" } },
    };
    expect(validate(EXTENSION_SCHEMA, ok)).toEqual({ valid: true, errors: [] });
    expect(
      validate(EXTENSION_SCHEMA, {
        ...ok,
        contributes: { connectors: { echo: "./echo.js" } },
      }).errors.join(),
    ).toMatch(/connectors\.echo: does not match pattern/);
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
    expect(out.anomalies[0]).toMatch(
      /extensions\[0\] must be an object with path or package/,
    );
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
      { path: path.join(root, "ext", "one"), index: 0, source: "path" },
    ]);
  });

  test("path and package together, or neither, are anomalies; version is display-only", () => {
    const root = tmpDir("event-extension-xor-");
    const out = loadExtensionRoots({
      root,
      policy: {
        extensions: [
          { config: { a: 1 } },
          { path: "vendor/one", package: "@watt-mind/factory-ext-one" },
          { package: "@watt-mind/factory-ext-missing", version: "9.9.9" },
          { package: "../not-a-package" },
          { package: "" },
        ],
      },
    });
    expect(out.roots).toEqual([]);
    expect(out.anomalies[0]).toMatch(
      /extensions\[0\] must have path or package \(entry skipped\)/,
    );
    expect(out.anomalies[1]).toMatch(
      /must have path or package, not both \(entry skipped\)/,
    );
    expect(out.anomalies[2]).toMatch(
      /package "@watt-mind\/factory-ext-missing" is not installed — npm i @watt-mind\/factory-ext-missing/,
    );
    expect(out.anomalies[3]).toMatch(/package must be a package name/);
    expect(out.anomalies[4]).toMatch(/package must be a non-empty string/);
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
    expect(out.errors.join("\n")).toMatch(/key "Bad Name" must match/);
    expect(out.errors.join("\n")).toMatch(
      /adapters\.bad-path .* is not a file/,
    );
  });

  test("a contributed path that is a symlink out of the extension is an escape", () => {
    const dir = tempExtension();
    const outside = tmpDir("event-extension-escape-target-");
    writeFileSync(
      path.join(outside, "pack.json"),
      JSON.stringify({ name: "escaped", version: "1.0.0", namespace: "x" }),
    );
    rmSync(path.join(dir, "pack"), { recursive: true, force: true });
    symlinkSync(outside, path.join(dir, "pack"));
    const out = validateExtensionManifest(dir);
    expect(out.valid).toBe(false);
    expect(out.errors.join("\n")).toMatch(/packs\[0\] "\.\/pack" escapes/);
  });

  test("connector paths must exist, stay inside, and match the name pattern", () => {
    const dir = tempExtension((m) => {
      m.contributes.connectors["missing"] = "./connectors/nope.mjs";
      m.contributes.connectors["escaped"] = "../escape.mjs";
      m.contributes.connectors["Bad Name"] = "./connectors/echo.mjs";
    });
    const out = validateExtensionManifest(dir);
    expect(out.valid).toBe(false);
    expect(out.errors.join("\n")).toMatch(
      /connectors\.missing .* is not a file/,
    );
    expect(out.errors.join("\n")).toMatch(/connectors\.escaped .* escapes/);
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
        source: "path",
        packs: ["sample-ext"],
        adapters: ["echo"],
        hooks: [
          { point: "approve.before", id: "factory/sample:approve-before" },
        ],
        connectors: [{ name: "echo", id: "factory/sample:echo" }],
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
    expect(out.extensions[0].connectors).toEqual([
      { name: "echo", id: "factory/sample:echo" },
    ]);
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
    expect(out.extensions[0].connectors).toEqual([
      { name: "echo", id: "factory/sample:echo" },
    ]);
    expect(out.anomalies).toEqual([]);
  });

  test("a bad connector module skips the whole extension; a views key still only warns", async () => {
    const noDefault = tempExtension((m, dir) => {
      m.name = "factory/no-start";
      writeFileSync(
        path.join(dir, "connectors", "echo.mjs"),
        'export const id = "factory/no-start:echo";\n',
      );
    });
    const skipped = await load(policyFor(noDefault));
    expect(skipped.extensions).toEqual([]);
    expect(skipped.anomalies[0]).toMatch(
      /connector "echo".*must export a default async function start/,
    );

    const noId = tempExtension((m, dir) => {
      m.name = "factory/no-id";
      writeFileSync(
        path.join(dir, "connectors", "echo.mjs"),
        "export default async function start() { return { stop() {}, health() { return { ok: true }; } }; }\n",
      );
    });
    const skippedId = await load(policyFor(noId));
    expect(skippedId.extensions).toEqual([]);
    expect(skippedId.anomalies[0]).toMatch(
      /connector "echo".*must export a string id/,
    );
  });

  test("connectors stay healthy but do not start outside the live environment", async () => {
    const dir = tempExtension((m, dirPath) => {
      m.name = "factory/environment-gate";
      writeFileSync(
        path.join(dirPath, "connectors", "echo.mjs"),
        `export const id = "factory/environment-gate:echo";
export default async function start() {
  globalThis.__environmentGateStarts = (globalThis.__environmentGateStarts ?? 0) + 1;
  return {
    async stop() {},
    health() { return { ok: true, detail: "real connector started" }; },
  };
}
`,
      );
    });
    const outcome = (environment) => {
      const script = `
import { createAdapterRegistry } from "./event-runtime/lib/adapters/index.mjs";
import { connectorStatus, startConnectors, stopConnectors } from "./event-runtime/lib/connectors.mjs";
import { openDb } from "./event-runtime/lib/db.mjs";
import { loadExtensions } from "./event-runtime/lib/extensions.mjs";
import { createHookRegistry } from "./event-runtime/lib/hooks.mjs";
import { loadRegistry } from "./event-runtime/lib/registry.mjs";

await loadExtensions({
  policy: { extensions: [{ path: ${JSON.stringify(dir)} }] },
  adapterRegistry: createAdapterRegistry(),
  hookRegistry: createHookRegistry(),
  packRoots: [],
});
const started = await startConnectors({
  db: openDb(":memory:"),
  registry: loadRegistry(),
});
console.log(JSON.stringify({
  starts: globalThis.__environmentGateStarts ?? 0,
  anomalies: started.anomalies,
  status: connectorStatus(),
}));
await stopConnectors();
`;
      const child = Bun.spawnSync({
        cmd: [process.execPath, "-e", script],
        cwd: path.dirname(RUNTIME_ROOT),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FACTORY_EVENT_ENV: environment },
      });
      expect(child.exitCode).toBe(0);
      return JSON.parse(child.stdout.toString());
    };

    const nonLive = outcome("worktree");
    expect(nonLive).toMatchObject({ starts: 0, anomalies: [] });
    expect(nonLive.status).toEqual([
      expect.objectContaining({
        extension: "factory/environment-gate",
        name: "echo",
        ok: true,
        detail: "not started (non-live env)",
      }),
    ]);

    const live = outcome("live");
    expect(live).toMatchObject({ starts: 1, anomalies: [] });
    expect(live.status[0]).toMatchObject({
      ok: true,
      detail: "real connector started",
    });
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

  test("format: secret resolves from env, then secrets.env, and never from policy.yaml", async () => {
    const dir = tempExtension((m) => {
      m.name = "factory/secretprobe";
      m.contributes.config.namespace = "secretprobe";
    });
    const envVar = extensionSecretEnvVar("secretprobe", "apiToken");
    expect(envVar).toBe("FACTORY_EXT_SECRETPROBE_API_TOKEN");

    const prevFile = process.env.FACTORY_EVENT_SECRETS_FILE;
    const prevEnv = process.env[envVar];
    const file = path.join(tmpDir("ext-secrets-"), "secrets.env");
    writeFileSync(file, `${envVar}=from-file\n`);
    chmodSync(file, 0o600);

    try {
      process.env.FACTORY_EVENT_SECRETS_FILE = file;
      delete process.env[envVar];
      resetExtensionSecretsCache();
      const fromFile = await load({
        extensions: [{ path: dir, config: { greeting: "hey" } }],
      });
      expect(fromFile.anomalies).toEqual([]);
      expect(getExtensionConfig("factory/secretprobe").apiToken).toBe(
        "from-file",
      );
      expect(
        loadedExtensions().extensions[0].config.secretMeta.apiToken,
      ).toEqual({ set: true, source: "secrets.env" });

      process.env[envVar] = "from-env";
      resetExtensionSecretsCache();
      const fromEnv = await load({
        extensions: [{ path: dir, config: { greeting: "hey" } }],
      });
      expect(getExtensionConfig("factory/secretprobe").apiToken).toBe(
        "from-env",
      );
      expect(
        loadedExtensions().extensions[0].config.secretMeta.apiToken,
      ).toEqual({ set: true, source: "env" });
    } finally {
      if (prevEnv === undefined) delete process.env[envVar];
      else process.env[envVar] = prevEnv;
      if (prevFile === undefined) delete process.env.FACTORY_EVENT_SECRETS_FILE;
      else process.env.FACTORY_EVENT_SECRETS_FILE = prevFile;
      resetExtensionSecretsCache();
    }

    const denied = await load(
      withValues({ greeting: "hey", apiToken: "in-policy" }),
    );
    expect(denied.extensions).toEqual([]);
    expect(denied.anomalies[0]).toMatch(
      /config\.apiToken must not be set in policy\.yaml — use env FACTORY_EXT_SAMPLE_API_TOKEN/,
    );
  });

  test("secret discovery covers fixed nested objects and rejects dynamic schema locations", async () => {
    const nestedSecretSchema = {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: {
            label: { type: "string" },
            value: { type: "string", format: "secret" },
          },
        },
      },
    };
    expect(collectSecretFields(nestedSecretSchema)).toEqual([
      { path: ["auth", "value"], key: "value" },
    ]);

    const nestedDir = tempExtension((manifest, extensionDir) => {
      manifest.name = "factory/nested-secret";
      manifest.contributes.config.namespace = "nested-secret";
      writeFileSync(
        path.join(extensionDir, "config.schema.json"),
        JSON.stringify(nestedSecretSchema),
      );
    });
    const nestedEnv = extensionSecretEnvVar("nested-secret", ["auth", "value"]);
    const previousNestedEnv = process.env[nestedEnv];
    try {
      process.env[nestedEnv] = "resolved-innocuous-secret";
      const nested = await load({
        extensions: [
          { path: nestedDir, config: { auth: { label: "primary" } } },
        ],
      });
      expect(nested.anomalies).toEqual([]);
      expect(nested.extensions[0].config.values).toEqual({
        auth: { label: "primary", value: "resolved-innocuous-secret" },
      });
      const nestedMeta =
        loadedExtensions().extensions[0].config.secretMeta["auth.value"];
      expect(nestedMeta).toEqual({
        set: true,
        source: "env",
      });
      expect(
        maskExtensionSecrets(
          nested.extensions[0].config.values,
          nestedSecretSchema,
          { "auth.value": nestedMeta },
        ),
      ).toEqual({
        auth: { label: "primary", value: { set: true, source: "env" } },
      });
    } finally {
      if (previousNestedEnv === undefined) delete process.env[nestedEnv];
      else process.env[nestedEnv] = previousNestedEnv;
    }

    const cases = [
      {
        name: "array of objects",
        schema: {
          type: "object",
          properties: {
            destinations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  value: { type: "string", format: "secret" },
                },
              },
            },
          },
        },
        error:
          /\$\.destinations\[\]\.value.*beneath schema\.items at \$\.destinations/,
      },
      {
        name: "nested arrays",
        schema: {
          type: "object",
          properties: {
            groups: {
              type: "array",
              items: {
                type: "array",
                items: { type: "string", format: "secret" },
              },
            },
          },
        },
        error: /\$\.groups\[\]\[\].*beneath schema\.items at \$\.groups/,
      },
      {
        name: "additional properties",
        schema: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              value: { type: "string", format: "secret" },
            },
          },
        },
        error: /\$\.\*\.value.*beneath schema\.additionalProperties at \$/,
      },
    ];

    for (const item of cases) {
      const dir = tempExtension((manifest, extensionDir) => {
        manifest.name = `factory/${item.name.replaceAll(" ", "-")}`;
        manifest.contributes.config.namespace = item.name.replaceAll(" ", "-");
        writeFileSync(
          path.join(extensionDir, "config.schema.json"),
          JSON.stringify(item.schema),
        );
      });
      const out = await load({
        extensions: [{ path: dir, config: {} }],
      });
      expect(out.extensions, item.name).toEqual([]);
      expect(out.anomalies[0], item.name).toMatch(item.error);
      expect(out.anomalies[0], item.name).toMatch(
        /dynamic secret locations are unsupported/,
      );
    }
  });

  test("ordinary non-secret arrays remain supported", async () => {
    const dir = tempExtension((manifest, extensionDir) => {
      manifest.name = "factory/array-config";
      manifest.contributes.config.namespace = "array-config";
      writeFileSync(
        path.join(extensionDir, "config.schema.json"),
        JSON.stringify({
          type: "object",
          additionalProperties: false,
          properties: {
            destinations: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "value"],
                properties: {
                  label: { type: "string" },
                  value: { type: "string" },
                },
              },
            },
          },
        }),
      );
    });
    const destinations = [{ label: "prod", value: "ordinary" }];
    const out = await load({
      extensions: [{ path: dir, config: { destinations } }],
    });
    expect(out.anomalies).toEqual([]);
    expect(out.extensions[0].config.values.destinations).toEqual(destinations);
  });

  test("rejects prototype-polluting schema paths before loading or masking", async () => {
    const marker = "factoryExtensionPrototypePollution";
    delete Object.prototype[marker];

    try {
      for (const segment of ["__proto__", "prototype", "constructor"]) {
        const schema = {
          type: "object",
          properties: {
            [segment]: {
              type: "object",
              properties: {
                [marker]: { type: "string", format: "secret" },
              },
            },
          },
        };
        expect(() => maskExtensionSecrets({}, schema)).toThrow(
          `config schema path contains forbidden segment "${segment}"`,
        );
        expect(Object.prototype[marker]).toBeUndefined();
      }

      const dir = tempExtension((_manifest, extensionDir) => {
        writeFileSync(
          path.join(extensionDir, "config.schema.json"),
          JSON.stringify({
            type: "object",
            properties: {
              ["__proto__"]: {
                type: "object",
                properties: {
                  [marker]: { type: "string", format: "secret" },
                },
              },
            },
          }),
        );
      });
      const out = await load({ extensions: [{ path: dir }] });
      expect(out.extensions).toEqual([]);
      expect(out.anomalies[0]).toMatch(
        /config schema path contains forbidden segment "__proto__"/,
      );
      expect(Object.prototype[marker]).toBeUndefined();
    } finally {
      delete Object.prototype[marker];
    }
  });

  test("secret masking never descends through an inherited config record", () => {
    const inheritedKey = "factoryInheritedExtensionConfig";
    const inherited = {};
    Object.defineProperty(Object.prototype, inheritedKey, {
      value: inherited,
      configurable: true,
    });

    try {
      const masked = maskExtensionSecrets(
        {},
        {
          type: "object",
          properties: {
            [inheritedKey]: {
              type: "object",
              properties: {
                token: { type: "string", format: "secret" },
              },
            },
          },
        },
        { [`${inheritedKey}.token`]: { set: true, source: "env" } },
      );
      expect(inherited).toEqual({});
      expect(Object.hasOwn(masked, inheritedKey)).toBe(true);
      expect(masked[inheritedKey].token).toEqual({
        set: true,
        source: "env",
      });
    } finally {
      delete Object.prototype[inheritedKey];
    }
  });

  test("a group/world-readable secrets.env warns once, is ignored (not read), and does not fail the load", () => {
    // os.homedir() is fixed at process start (Bun does not re-read $HOME at
    // runtime), so a temp HOME has to be a real subprocess env, not an
    // in-process process.env write — the same reason the "cli extensions"
    // tests below spawn the CLI instead of calling loadExtensions() directly.
    const dir = tempExtension((m) => {
      m.name = "factory/secretmode";
      m.contributes.config.namespace = "secretmode";
    });
    const envVar = extensionSecretEnvVar("secretmode", "apiToken");
    const home = tmpDir("ext-secrets-home-");
    mkdirSync(path.join(home, ".factory"), { recursive: true });
    const file = path.join(home, ".factory", "secrets.env");
    writeFileSync(file, `${envVar}=from-permissive-file\n`);
    chmodSync(file, 0o644);

    const root = tmpDir("ext-secrets-policyroot-");
    mkdirSync(path.join(root, "config"));
    const { models } = Bun.YAML.parse(
      readFileSync(
        resolveConfigPath("policy", {
          root: path.dirname(RUNTIME_ROOT),
          warn: false,
        }),
        "utf8",
      ),
    );
    writeFileSync(
      path.join(root, "config", "policy.yaml"),
      Bun.YAML.stringify({
        models,
        extensions: [{ path: dir, config: { greeting: "hey" } }],
      }),
    );

    const out = Bun.spawnSync({
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
      env: {
        ...process.env,
        HOME: home,
        FACTORY_REPOS_ROOT: root,
        FACTORY_EVENT_SECRETS_FILE: undefined,
        [envVar]: undefined,
      },
    });
    expect(out.exitCode).toBe(0);
    const stderr = out.stderr.toString();
    // Permissive mode means the file is ignored, not read: the extension
    // still loads (this is a warning, never a fault) with the secret unset.
    expect(stderr).toContain(file);
    expect(stderr).toMatch(/group\/world-readable/);
    expect(stderr).not.toContain("from-permissive-file");
    const parsed = JSON.parse(out.stdout.toString());
    expect(parsed.anomalies).toEqual([]);
    expect(parsed.extensions[0].config.namespace).toBe("secretmode");
    expect(parsed.extensions[0].config.values.apiToken).toBeUndefined();
  });

  test("loading an extension with an env-backed secret never prints the raw value (serve logs loadExtensions() output at start)", async () => {
    const envVar = extensionSecretEnvVar("sample", "apiToken");
    const SECRET_LITERAL = "raw-secret-should-never-be-logged-77bb1";
    const prevEnv = process.env[envVar];
    const logged = [];
    const spies = ["log", "warn", "error", "info", "debug"].map((method) => {
      const original = console[method];
      console[method] = (...args) => logged.push(args.join(" "));
      return () => {
        console[method] = original;
      };
    });
    try {
      process.env[envVar] = SECRET_LITERAL;
      resetExtensionSecretsCache();
      const out = await load(withValues({ greeting: "hey" }));
      expect(out.extensions).toHaveLength(1);
      expect(getExtensionConfig("factory/sample").apiToken).toBe(
        SECRET_LITERAL,
      );
      expect(logged.some((line) => line.includes(SECRET_LITERAL))).toBe(false);
    } finally {
      for (const restore of spies) restore();
      if (prevEnv === undefined) delete process.env[envVar];
      else process.env[envVar] = prevEnv;
      resetExtensionSecretsCache();
    }
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

describe("contributionCounts (WM-865)", () => {
  test("counts hooks, panels and config on a manifest and a loaded extension", () => {
    expect(contributionCounts(null)).toEqual({
      packs: 0,
      adapters: 0,
      hooks: 0,
      panels: 0,
      config: 0,
    });
    expect(
      contributionCounts({
        contributes: {
          packs: ["./pack"],
          adapters: { echo: "./adapters/echo.mjs" },
          hooks: { "approve.before": "./hooks/x.mjs" },
          panels: ["./panels"],
          config: { namespace: "sample", schema: "./config.schema.json" },
        },
      }),
    ).toEqual({ packs: 1, adapters: 1, hooks: 1, panels: 1, config: 1 });
    expect(
      contributionCounts({
        packs: ["sample-ext"],
        adapters: ["echo"],
        hooks: [
          { point: "approve.before", id: "factory/sample:approve-before" },
        ],
        panels: ["/tmp/panels"],
        config: null,
      }),
    ).toEqual({ packs: 1, adapters: 1, hooks: 1, panels: 1, config: 0 });
    expect(formatContributionCounts(contributionCounts({}))).toBe(
      "0 packs, 0 adapters, 0 hooks, 0 panels, 0 configs",
    );
    expect(
      formatContributionCounts({
        packs: 1,
        adapters: 1,
        hooks: 1,
        panels: 1,
        config: 1,
      }),
    ).toBe("1 pack, 1 adapter, 1 hook, 1 panel, 1 config");
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
      /factory\/sample@1\.0\.0: valid \(1 pack, 1 adapter, 1 hook, 1 panel, 1 config, config namespace sample\)/,
    );

    const noConfig = tempExtension((m) => {
      m.name = "factory/plain";
      delete m.contributes.config;
    });
    const plain = run("validate", noConfig);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout.toString()).toMatch(
      /factory\/plain@1\.0\.0: valid \(1 pack, 1 adapter, 1 hook, 1 panel, 0 configs\)/,
    );
    expect(plain.stdout.toString()).not.toMatch(/config namespace/);

    const stripped = tempExtension((m) => {
      m.name = "factory/bare";
      m.contributes = {};
    });
    const bare = run("validate", stripped);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout.toString()).toMatch(
      /factory\/bare@1\.0\.0: valid \(0 packs, 0 adapters, 0 hooks, 0 panels, 0 configs\)/,
    );

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
        resolveConfigPath("policy", {
          root: path.dirname(RUNTIME_ROOT),
          warn: false,
        }),
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
      /EXTENSION\s+VERSION\s+PACKS\s+ADAPTERS\s+HOOKS\s+PANELS\s+CONFIG\s+NAMESPACE\s+PATH/,
    );
    expect(text).toMatch(
      new RegExp(
        `factory/sample\\s+1\\.0\\.0\\s+1\\s+1\\s+1\\s+1\\s+1\\s+sample\\s+${SAMPLE_EXTENSION}`,
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
    expect(parsed.extensions[0].connectors).toEqual([
      { name: "echo", id: "factory/sample:echo" },
    ]);
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
    expect(loaded.harnessRoots.map((root) => root.plugin)).toEqual([
      CORE_HARNESS_PLUGIN,
      "acme-tools",
    ]);
    expect(loaded.harnessRoots[0].builtin).toBe(true);
    expect(loaded.harnessRoots[1].plugin).toBe("acme-tools");
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

  test("missing in-tree paths stay in-tree through a symlinked extension root", () => {
    const dir = tempExtension((m) => {
      m.contributes.adapters = { echo: "./adapters/nope.mjs" };
      m.contributes.hooks = { "approve.before": "../escape.mjs" };
      m.contributes.harness = { floor: "./missing.md" };
    });
    const linked = path.join(tmpDir("event-extension-link-"), "extension");
    symlinkSync(dir, linked, "dir");

    const out = validateExtensionManifest(linked);
    expect(out.valid).toBe(false);
    expect(out.errors.join("\n")).toMatch(/adapters\.echo .* is not a file/);
    expect(out.errors.join("\n")).toMatch(/harness\.floor .* is not a file/);
    expect(out.errors.join("\n")).toMatch(
      /hooks\["approve\.before"\] .* escapes the extension directory/,
    );
  });
});

describe("extension packages (WM-922)", () => {
  test("looksLikePackageName accepts @scope/name and unscoped names, not paths", () => {
    expect(looksLikePackageName("@watt-mind/factory-ext-buzz")).toBe(true);
    expect(looksLikePackageName("@test/sample-ext")).toBe(true);
    expect(looksLikePackageName("factory-ext-buzz")).toBe(true);
    expect(looksLikePackageName("./vendor/ext")).toBe(false);
    expect(looksLikePackageName("vendor/ext")).toBe(false);
    expect(looksLikePackageName("~/ext")).toBe(false);
    expect(looksLikePackageName("../escape")).toBe(false);
  });

  test("the sample fixture loads as a package via a node_modules symlink", async () => {
    const { factoryRoot, installed, name, version } = sampleAsPackage();
    const resolved = resolveExtensionPackage(name, { root: factoryRoot });
    expect(resolved.source).toBe("package");
    expect(resolved.package).toBe(name);
    expect(resolved.packageVersion).toBe(version);
    expect(resolved.path).toBe(realpathSync(installed));

    const adapterRegistry = createAdapterRegistry();
    const out = await loadExtensions({
      root: factoryRoot,
      policy: {
        extensions: [{ package: name, version: "ignored-display-only" }],
      },
      adapterRegistry,
      hookRegistry: createHookRegistry(),
      packRoots: [],
    });
    expect(out.anomalies).toEqual([]);
    expect(out.extensions).toHaveLength(1);
    expect(out.extensions[0]).toMatchObject({
      name: "factory/sample",
      version: "1.0.0",
      path: realpathSync(installed),
      source: "package",
      package: name,
      packageVersion: version,
      packs: ["sample-ext"],
      adapters: ["echo"],
    });
    expect(adapterRegistry.has("echo")).toBe(true);
    expect(loadedExtensions().extensions[0]).toMatchObject({
      source: "package",
      package: name,
      packageVersion: version,
      path: realpathSync(installed),
    });
  });

  test("factory.extension points at a subdir; a subdir that escapes is refused", () => {
    const nestedRoot = tmpDir("event-extension-nested-pkg-");
    const pkgDir = tmpDir("event-extension-nested-install-");
    const extDir = path.join(pkgDir, "ext");
    cpSync(SAMPLE_EXTENSION, extDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@test/nested-ext",
        version: "0.4.0",
        factory: { extension: "./ext" },
      }),
    );
    mkdirSync(path.join(nestedRoot, "node_modules", "@test"), {
      recursive: true,
    });
    symlinkSync(
      pkgDir,
      path.join(nestedRoot, "node_modules", "@test", "nested-ext"),
    );
    const resolved = resolveExtensionPackage("@test/nested-ext", {
      root: nestedRoot,
    });
    expect(resolved.path).toBe(realpathSync(extDir));
    expect(resolved.packageVersion).toBe("0.4.0");

    const escapedRoot = tmpDir("event-extension-escaped-pkg-");
    const escapedPkg = tmpDir("event-extension-escaped-install-");
    writeFileSync(
      path.join(escapedPkg, "package.json"),
      JSON.stringify({
        name: "@test/escaped-ext",
        version: "0.0.1",
        factory: { extension: "../outside" },
      }),
    );
    mkdirSync(path.join(escapedRoot, "node_modules", "@test"), {
      recursive: true,
    });
    symlinkSync(
      escapedPkg,
      path.join(escapedRoot, "node_modules", "@test", "escaped-ext"),
    );
    expect(() =>
      resolveExtensionPackage("@test/escaped-ext", { root: escapedRoot }),
    ).toThrow(/factory\.extension "\.\.\/outside" escapes/);
  });

  test("a package whose contributed pack is a symlink out of the package is an escape", () => {
    const { factoryRoot, installed, name } = sampleAsPackage();
    const outside = tmpDir("event-extension-pkg-escape-");
    writeFileSync(
      path.join(outside, "pack.json"),
      JSON.stringify({ name: "escaped", version: "1.0.0", namespace: "x" }),
    );
    rmSync(path.join(installed, "pack"), { recursive: true, force: true });
    symlinkSync(outside, path.join(installed, "pack"));
    const resolved = resolveExtensionPackage(name, { root: factoryRoot });
    const out = validateExtensionManifest(resolved.path);
    expect(out.valid).toBe(false);
    expect(out.errors.join("\n")).toMatch(/packs\[0\] "\.\/pack" escapes/);
  });

  test("extensions validate accepts a package name via the existing CLI", () => {
    const { factoryRoot, name } = sampleAsPackage();
    const ok = Bun.spawnSync({
      cmd: [
        process.execPath,
        "event-runtime/cli.mjs",
        "extensions",
        "validate",
        name,
      ],
      cwd: path.dirname(RUNTIME_ROOT),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_REPOS_ROOT: factoryRoot },
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toMatch(
      /factory\/sample@1\.0\.0: valid \(1 pack, 1 adapter, 1 hook, 1 panel, 1 config, config namespace sample\)/,
    );

    const missing = Bun.spawnSync({
      cmd: [
        process.execPath,
        "event-runtime/cli.mjs",
        "extensions",
        "validate",
        "@watt-mind/factory-ext-nope",
      ],
      cwd: path.dirname(RUNTIME_ROOT),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FACTORY_REPOS_ROOT: factoryRoot },
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toMatch(
      /is not installed — npm i @watt-mind\/factory-ext-nope/,
    );
  });

  test("extensions pack rejects mismatched or incomplete npm metadata", () => {
    const dir = tempExtension();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@test/pack-ext",
        version: "0.1.0",
        type: "module",
        files: ["factory-extension.json", "pack", "adapters"],
      }),
    );
    const diagnostics = [];
    for (const report of [
      [{ name: "factory/sample", version: "1.0.0", files: [] }],
      [{ name: "@test/pack-ext", version: "0.1.0" }],
      [{}],
    ]) {
      expect(() =>
        packExtension(dir, {
          spawn: () => ({
            status: 0,
            stdout: JSON.stringify(report),
            stderr: "",
          }),
          exit: (code) => {
            throw new Error(`exit:${code}`);
          },
          error: (message) => diagnostics.push(message),
        }),
      ).toThrow("exit:1");
    }
    expect(diagnostics.join("\n")).toContain("npm_pack_metadata_invalid");
    expect(diagnostics.join("\n")).toContain("@test/pack-ext@0.1.0");
  });

  test("extensions pack uses an isolated npm cache and explicit target", () => {
    const dir = tempExtension();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@test/pack-ext", version: "0.1.0" }),
    );
    let invocation;
    packExtension(dir, {
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        return {
          status: 0,
          // Workspace-aware npm may key the one metadata object by package.
          stdout: JSON.stringify({
            "@test/pack-ext": {
              name: "@test/pack-ext",
              version: "0.1.0",
              files: [{ path: "package.json" }],
            },
          }),
          stderr: "",
        };
      },
    });
    expect(invocation.command).toBe("npm");
    expect(invocation.args).toContain(".");
    expect(invocation.args).toContain("--cache");
    expect(invocation.args).toContain("--ignore-scripts");
    const cache = invocation.args[invocation.args.indexOf("--cache") + 1];
    expect(cache).toContain("factory-npm-pack-");
    expect(existsSync(cache)).toBe(false);
    expect(invocation.options.cwd).toBe(dir);
  });

  test("extensions pack validates then lists npm pack --dry-run files", () => {
    const dir = tempExtension();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@test/pack-ext",
        version: "0.1.0",
        type: "module",
        files: ["factory-extension.json", "pack", "adapters"],
      }),
    );
    const packed = Bun.spawnSync({
      cmd: [process.execPath, "event-runtime/cli/extensions.mjs", "pack", dir],
      cwd: path.dirname(RUNTIME_ROOT),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (packed.exitCode !== 0) {
      throw new Error(
        `extensions pack CLI exited ${packed.exitCode}: ${packed.stderr.toString().trim() || "no stderr"}`,
      );
    }
    // The CLI parses `npm pack --dry-run --json` structurally and prints its
    // own stable summary, so this asserts the code's behavior — not npm's
    // human text, which varies by npm version (object-keyed vs array report).
    const text = packed.stdout.toString();
    const summary = text.match(
      /@test\/pack-ext@0\.1\.0: would pack (\d+) files/,
    );
    expect(summary).not.toBeNull();
    // A real file set was resolved from the manifest's `files` list, not the
    // empty/fallback shape a mis-parsed report would yield.
    expect(Number(summary[1])).toBeGreaterThan(0);
    // The listing still names each packed path, so a genuinely broken pack
    // (missing the manifest or a contributed dir) would fail here.
    expect(text).toMatch(/^ {2}factory-extension\.json$/m);
    expect(text).toMatch(/^ {2}adapters\/echo\.mjs$/m);
    expect(text).toMatch(/^ {2}package\.json$/m);
  });
});
