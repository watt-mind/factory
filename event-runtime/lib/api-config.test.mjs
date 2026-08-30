import {
  tmpDir,
  trackTmpDir,
} from "../test-support/tmp.mjs?file=event-runtime-lib-api-config-test-mjs";
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configView, redactSecrets } from "./api-config.mjs";
import { makeServer as makeApiServer } from "./api-test-helpers.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import {
  EXTENSION_MANIFEST,
  extensionSecretEnvVar,
  loadExtensions,
  resetExtensionSecretsCache,
} from "./extensions.mjs";
import { reposView } from "./repos.mjs";
import { openDb } from "./db.mjs";
import { KIND_MODEL_TIER_CELL, putOverride } from "./runtime-overrides.mjs";

const SAMPLE_EXTENSION = path.join(
  RUNTIME_ROOT,
  "test-support",
  "extensions",
  "sample",
);

const makeServer = async (...args) => {
  const result = await makeApiServer(...args);
  trackTmpDir(path.dirname(result.db.filename));
  return result;
};

function repo(name = "factory") {
  return {
    name,
    path: `/src/${name}`,
    github: `watt-mind/${name}`,
    team: "WM",
    project: null,
    base: "develop",
    deployBranch: "master",
    reportOnly: false,
    maxInFlight: 3,
    smokeDeadlineSeconds: null,
    mergeCi: null,
    worktreeRoot: `/worktrees/${name}`,
    worktreeUp: "up.sh",
    worktreeDown: null,
    worktreeWarm: null,
    verify: "bun test",
  };
}

function fixtureRoot() {
  const root = tmpDir("evrt-config-view-");
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(
    path.join(root, "config", "policy.yaml"),
    [
      "workers:",
      "  max: 4",
      "models:",
      "  pi:",
      "    standard: pi/model",
      "unknown_private_block:",
      "  token: never-publish-this",
      "notify:",
      "  command: echo",
      "  webhookToken: leaked-notify-token",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(root, "config", "nodes.yaml"),
    [
      "nodes:",
      "  lab:",
      "    host: lab.local",
      "    user: runner",
      "    env:",
      "      API_TOKEN: super-secret-value",
      "      FACTORY_EVENT_PORT: 7777",
      "    labels:",
      "      arch: arm64",
      "    adapters: [pi]",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(root, "config", "schedule.yaml"),
    [
      "defaults:",
      "  repo: factory",
      "  harness: pi",
      "jobs:",
      "  - name: triage",
      "    every: 5m",
      "    command: do-not-publish",
      "",
    ].join("\n"),
  );
  return root;
}

function registry() {
  return {
    agents: new Map([["triage@1", {}]]),
    eventTypes: {
      "factory.triage.requested": { agent: "triage@1", adapter: "pi" },
    },
    edges: { "triage@1": { edges: { ready: {}, blocked: {} } } },
    schedules: { triage: {} },
  };
}

describe("GET /config view", () => {
  test("is routed by the control API", async () => {
    const root = fixtureRoot();
    const { server, port, close } = await makeServer({
      configRoot: root,
      repos: () => new Map([["factory", repo()]]),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/config`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.policyVersion).toBe("git:test-pv");
      expect(body.sections.map((section) => section.id)).toContain("nodes");
    } finally {
      close();
      server.close();
    }
  });

  test("returns the stable shape, source annotations, counts, and reload classes", () => {
    const view = configView({
      root: fixtureRoot(),
      registry: registry(),
      repos: () => new Map([["factory", repo()]]),
      policyVersion: "git:test",
      now: Date.parse("2026-08-18T10:00:00.000Z"),
      registryLoadedAt: "2026-08-18T09:59:00.000Z",
    });

    expect(view.generatedAt).toBe("2026-08-18T10:00:00.000Z");
    expect(view.policyVersion).toBe("git:test");
    expect(view.registry).toEqual({
      loadedAt: "2026-08-18T09:59:00.000Z",
      agentCount: 1,
      eventTypeCount: 1,
      edgeCount: 2,
      scheduleCount: 1,
    });
    expect(view.sections.map((section) => section.id)).toEqual([
      "repos",
      "policy",
      "policy-models",
      "nodes",
      "schedule",
      "registry",
      "extensions",
    ]);
    expect(view.sections.map((section) => section.reload)).toEqual([
      "hot",
      "hot",
      "restart",
      "cli-only",
      "cli-only",
      "restart",
      "restart",
    ]);
    expect(
      view.sections.every(
        (section) => section.source.file && section.source.kind,
      ),
    ).toBe(true);

    const repoEntries = view.sections.find(
      (section) => section.id === "repos",
    ).entries;
    const publishedRepoFields = Object.keys(
      reposView(new Map([["factory", repo()]]))[0],
    )
      .filter((key) => key !== "name")
      .map((key) => `factory.${key}`);
    expect(repoEntries.map((entry) => entry.key)).toEqual(publishedRepoFields);

    const policy = view.sections.find((section) => section.id === "policy");
    expect(policy.entries.find((entry) => entry.key === "workers").reload).toBe(
      "hot",
    );
    expect(policy.entries.some((entry) => entry.key === "models")).toBe(false);
    const models = view.sections.find(
      (section) => section.id === "policy-models",
    );
    expect(models.modelTierConfig.tracked.pi.standard).toBe("pi/model");
    expect(models.modelTierConfig.effective.pi.standard).toBe("pi/model");
    const eventType = view.sections
      .find((section) => section.id === "registry")
      .entries.find((entry) => entry.key.includes("factory.triage.requested"));
    expect(eventType.value).toBe("pi");
  });

  test("Policy Models exposes only tracked/runtime/effective model cells", () => {
    const db = openDb(":memory:");
    putOverride(db, {
      kind: KIND_MODEL_TIER_CELL,
      key: "pi:standard",
      patch: { model: "runtime/model" },
      actor: "operator",
    });
    const view = configView({
      db,
      root: fixtureRoot(),
      registry: registry(),
      repos: () => new Map(),
      policyVersion: "git:test",
      now: 0,
    });
    const section = view.sections.find((item) => item.id === "policy-models");
    expect(section.modelTierConfig.tracked.pi.standard).toBe("pi/model");
    expect(section.modelTierConfig.runtime.pi.standard).toBe("runtime/model");
    expect(section.modelTierConfig.effective.pi.standard).toBe("runtime/model");
    const wire = JSON.stringify(section);
    expect(wire).not.toContain("workers");
    expect(wire).not.toContain("never-publish-this");
    expect(wire).not.toContain("leaked-notify-token");
    db.close();
  });

  test("keeps the config inventory available when a model-tier cell is corrupt", async () => {
    const { server, port, db, close } = await makeServer({
      configRoot: fixtureRoot(),
    });
    putOverride(db, {
      kind: KIND_MODEL_TIER_CELL,
      key: "pi:strong",
      patch: { model: "runtime-strong" },
      actor: "operator",
    });
    db.query(
      `INSERT INTO runtime_overrides (kind, key, patch_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      KIND_MODEL_TIER_CELL,
      "pi:standard",
      JSON.stringify({ model: "" }),
      new Date(0).toISOString(),
      "test",
    );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/config`);
      expect(response.status).toBe(200);
      const body = await response.json();
      const section = body.sections.find((item) => item.id === "policy-models");
      expect(section.modelTierConfig.runtime.pi.strong).toBe("runtime-strong");
      expect(section.modelTierConfig.problems).toEqual([
        {
          key: "pi:standard",
          error: expect.stringContaining("model must be a non-empty string"),
        },
      ]);
      expect(body.sections.map((item) => item.id)).toContain("registry");
    } finally {
      close();
      server.close();
    }
  });

  test("uses explicit allow-lists and publishes node env keys, never values", () => {
    const view = configView({
      root: fixtureRoot(),
      registry: registry(),
      repos: () => new Map([["factory", repo()]]),
      policyVersion: "git:test",
      now: 0,
    });
    const wire = JSON.stringify(view);
    const policy = view.sections.find((section) => section.id === "policy");
    const nodes = view.sections.find((section) => section.id === "nodes");
    const schedule = view.sections.find((section) => section.id === "schedule");

    expect(
      policy.entries.some((entry) => entry.key === "unknown_private_block"),
    ).toBe(false);
    expect(wire).not.toContain("never-publish-this");
    expect(wire).not.toContain("super-secret-value");
    expect(wire).not.toContain("leaked-notify-token");
    const notify = policy.entries.find((entry) => entry.key === "notify");
    expect(notify.value).toEqual({
      command: "echo",
      webhookToken: "[redacted]",
    });
    expect(
      nodes.entries.find((entry) => entry.key === "lab.env.keys").value,
    ).toEqual(["API_TOKEN", "FACTORY_EVENT_PORT"]);
    expect(
      schedule.entries.find((entry) => entry.key === "jobs.triage").value,
    ).toEqual({
      cadence: "5m",
      harness: "pi",
    });
    expect(wire).not.toContain("do-not-publish");
  });

  test("publishes extension config: namespace, effective values, schema, and disabled reasons", () => {
    const view = configView({
      root: fixtureRoot(),
      registry: registry(),
      repos: () => new Map(),
      policyVersion: "git:test",
      now: 0,
      extensions: {
        extensions: [
          {
            name: "factory/sample",
            version: "1.0.0",
            path: "/ext/sample",
            packs: ["sample-ext"],
            adapters: ["echo"],
            connectors: [{ name: "echo", id: "factory/sample:echo" }],
            hooks: [
              {
                point: "approve.before",
                id: "factory/sample:approve-before",
              },
            ],
            panels: ["/ext/sample/panels"],
            config: {
              namespace: "sample",
              schema: "./config.schema.json",
              schemaJson: { type: "object", properties: {} },
              values: {
                greeting: "hello",
                apiToken: "super-secret-value",
                limits: { timeoutSeconds: 30, signingKey: "k" },
              },
            },
          },
          {
            name: "factory/plain",
            version: "0.1.0",
            path: "/ext/plain",
            config: null,
          },
        ],
        disabled: [
          {
            name: "factory/broken",
            version: "2.0.0",
            path: "/ext/broken",
            namespace: "broken",
            reason:
              "factory/broken@2.0.0: config does not match ./config.schema.json — $.maxParallel: above maximum 4",
          },
        ],
      },
    });
    const section = view.sections.find((s) => s.id === "extensions");
    expect(section.title).toBe("Extensions");
    expect(section.source).toEqual({
      file: "config/policy.yaml",
      kind: "yaml",
    });
    expect(section.reload).toBe("restart");
    expect(section.extensions).toEqual([
      {
        name: "factory/sample",
        version: "1.0.0",
        path: "/ext/sample",
        namespace: "sample",
        reload: "restart",
        schema: { type: "object", properties: {} },
        values: {
          greeting: "hello",
          apiToken: "[redacted]",
          limits: { timeoutSeconds: 30, signingKey: "[redacted]" },
        },
        anomaly: null,
        contributions: {
          packs: 1,
          adapters: 1,
          connectors: 1,
          hooks: 1,
          panels: 1,
        },
      },
      {
        name: "factory/plain",
        version: "0.1.0",
        path: "/ext/plain",
        namespace: null,
        reload: "restart",
        schema: null,
        values: null,
        anomaly: null,
        contributions: {
          packs: 0,
          adapters: 0,
          connectors: 0,
          hooks: 0,
          panels: 0,
        },
      },
      {
        name: "factory/broken",
        version: "2.0.0",
        path: "/ext/broken",
        namespace: "broken",
        reload: "restart",
        schema: null,
        values: null,
        anomaly: expect.stringMatching(/\$\.maxParallel: above maximum 4/),
        contributions: {
          packs: 0,
          adapters: 0,
          connectors: 0,
          hooks: 0,
          panels: 0,
        },
      },
    ]);
    // Entries mirror the same rows so search and generic rendering keep working.
    expect(section.entries.map((e) => e.key)).toEqual([
      "sample",
      "factory/plain",
      "broken",
    ]);
    expect(section.entries[0].value.apiToken).toBe("[redacted]");
    expect(section.entries[2].note).toMatch(/disabled/);
    expect(JSON.stringify(view)).not.toContain("super-secret-value");
  });

  test("publishes format: secret as { set, source } and never the resolved value", () => {
    const view = configView({
      root: fixtureRoot(),
      registry: registry(),
      repos: () => new Map(),
      policyVersion: "git:test",
      now: 0,
      extensions: {
        extensions: [
          {
            name: "factory/sample",
            version: "1.0.0",
            path: "/ext/sample",
            config: {
              namespace: "sample",
              schema: "./config.schema.json",
              schemaJson: {
                type: "object",
                properties: {
                  greeting: { type: "string" },
                  apiToken: { type: "string", format: "secret" },
                },
              },
              values: { greeting: "hello", apiToken: "super-secret-value" },
              secretMeta: { apiToken: { set: true, source: "env" } },
            },
          },
        ],
        disabled: [],
      },
    });
    const section = view.sections.find((s) => s.id === "extensions");
    expect(section.extensions[0].values).toEqual({
      greeting: "hello",
      apiToken: { set: true, source: "env" },
    });
    expect(JSON.stringify(view)).not.toContain("super-secret-value");
  });

  test("GET /config cannot publish an innocently named secret beneath array items", async () => {
    const dir = tmpDir("evrt-array-secret-extension-");
    cpSync(SAMPLE_EXTENSION, dir, { recursive: true });
    const manifestFile = path.join(dir, EXTENSION_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.name = "factory/array-secret";
    manifest.contributes.config.namespace = "array-secret";
    writeFileSync(manifestFile, JSON.stringify(manifest));
    writeFileSync(
      path.join(dir, "config.schema.json"),
      JSON.stringify({
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
      }),
    );
    const secret = "plaintext-that-must-not-reach-config";
    const loaded = await loadExtensions({
      policy: {
        extensions: [
          {
            path: dir,
            config: {
              destinations: [{ label: "prod", value: secret }],
            },
          },
        ],
      },
      packRoots: [],
    });
    expect(loaded.extensions).toEqual([]);
    expect(loaded.disabled[0].reason).toMatch(
      /\$\.destinations\[\]\.value.*dynamic secret locations are unsupported/,
    );

    const view = configView({
      root: fixtureRoot(),
      registry: registry(),
      repos: () => new Map(),
      policyVersion: "git:test",
      now: 0,
    });
    const section = view.sections.find((item) => item.id === "extensions");
    expect(section.extensions[0].values).toBeNull();
    expect(section.extensions[0].anomaly).toMatch(
      /dynamic secret locations are unsupported/,
    );
    expect(JSON.stringify(view)).not.toContain(secret);
  });

  test("defaults to the extensions the process loaded (lib/extensions.mjs snapshot)", async () => {
    await loadExtensions({
      policy: {
        extensions: [
          {
            path: SAMPLE_EXTENSION,
            config: { greeting: "yo" },
          },
        ],
      },
      packRoots: [],
    });
    const view = configView({
      root: fixtureRoot(),
      registry: registry(),
      repos: () => new Map(),
      policyVersion: "git:test",
      now: 0,
    });
    const section = view.sections.find((s) => s.id === "extensions");
    expect(section.extensions).toHaveLength(1);
    expect(section.extensions[0].namespace).toBe("sample");
    expect(section.extensions[0].values).toEqual({
      greeting: "yo",
      maxParallel: 1,
      apiToken: { set: false, source: null },
      limits: { timeoutSeconds: 30 },
    });
    expect(section.extensions[0].schema.properties.greeting.default).toBe(
      "hello",
    );
    expect(section.extensions[0].schema.properties.apiToken.format).toBe(
      "secret",
    );
    expect(section.extensions[0].contributions).toEqual({
      packs: 1,
      adapters: 1,
      connectors: 1,
      hooks: 1,
      panels: 1,
    });
  });

  test("GET /config over real HTTP: an env-backed secret value never appears in the response body, only { set, source }", async () => {
    const SECRET_LITERAL = "raw-secret-should-never-leak-9f31a2";
    const envVar = extensionSecretEnvVar("sample", "apiToken");
    expect(envVar).toBe("FACTORY_EXT_SAMPLE_API_TOKEN");
    const prevEnv = process.env[envVar];
    process.env[envVar] = SECRET_LITERAL;
    resetExtensionSecretsCache();
    let apiServer;
    try {
      await loadExtensions({
        policy: {
          extensions: [{ path: SAMPLE_EXTENSION, config: { greeting: "hi" } }],
        },
        packRoots: [],
      });
      apiServer = await makeServer({ configRoot: fixtureRoot() });
      const response = await fetch(apiServer.url("/config"));
      expect(response.status).toBe(200);
      const text = await response.text();
      // Grep the raw response text, not just the parsed value, for the literal.
      expect(text).not.toContain(SECRET_LITERAL);
      const body = JSON.parse(text);
      const section = body.sections.find((s) => s.id === "extensions");
      const sample = section.extensions.find(
        (ext) => ext.name === "factory/sample",
      );
      expect(sample.values.apiToken).toEqual({ set: true, source: "env" });
    } finally {
      apiServer?.close();
      if (prevEnv === undefined) delete process.env[envVar];
      else process.env[envVar] = prevEnv;
      resetExtensionSecretsCache();
    }
  });

  test("GET /config serves a disabled malicious schema without prototype pollution", async () => {
    const marker = "factoryConfigApiPrototypePollution";
    const extensionDir = tmpDir("evrt-config-malicious-extension-");
    cpSync(SAMPLE_EXTENSION, extensionDir, { recursive: true });
    const schemaFile = path.join(extensionDir, "config.schema.json");
    const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
    schema.properties = {
      ["__proto__"]: {
        type: "object",
        properties: {
          [marker]: { type: "string", format: "secret" },
        },
      },
    };
    writeFileSync(schemaFile, JSON.stringify(schema));

    delete Object.prototype[marker];
    let apiServer;
    try {
      const loaded = await loadExtensions({
        policy: { extensions: [{ path: extensionDir }] },
        packRoots: [],
      });
      expect(loaded.extensions).toEqual([]);
      expect(loaded.anomalies[0]).toMatch(
        /config schema path contains forbidden segment "__proto__"/,
      );

      apiServer = await makeServer({ configRoot: fixtureRoot() });
      const response = await fetch(apiServer.url("/config"));
      expect(response.status).toBe(200);
      const body = await response.json();
      const section = body.sections.find((item) => item.id === "extensions");
      expect(section.extensions[0].anomaly).toMatch(
        /config schema path contains forbidden segment "__proto__"/,
      );
      expect(Object.prototype[marker]).toBeUndefined();
    } finally {
      apiServer?.close();
      delete Object.prototype[marker];
    }
  });

  test("GET /config redacts secret-looking keys in the policy section, not only extension values", () => {
    const view = configView({
      root: fixtureRoot(),
      registry: registry(),
      repos: () => new Map(),
      policyVersion: "git:test",
      now: 0,
    });
    const policy = view.sections.find((section) => section.id === "policy");
    expect(
      policy.entries.find((entry) => entry.key === "notify").value,
    ).toEqual({
      command: "echo",
      webhookToken: "[redacted]",
    });
    expect(JSON.stringify(view)).not.toContain("leaked-notify-token");
  });

  test("redactSecrets masks token/secret/key/password keys at any depth and leaves the rest", () => {
    expect(
      redactSecrets({
        host: "api.example",
        API_TOKEN: "a",
        nested: { password: "b", list: [{ secretThing: "c", ok: 1 }] },
        privateKey: "",
        monkey: null,
      }),
    ).toEqual({
      host: "api.example",
      API_TOKEN: "[redacted]",
      nested: {
        password: "[redacted]",
        list: [{ secretThing: "[redacted]", ok: 1 }],
      },
      privateKey: "",
      monkey: null,
    });
    expect(redactSecrets("plain")).toBe("plain");
  });
});
