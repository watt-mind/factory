import {
  tmpDir,
  trackTmpDir,
} from "../test-support/tmp.mjs?file=event-runtime-lib-api-registry-test-mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GH_SECRET,
  PV,
  SECRET,
  apiClient,
  deregisterWorker,
  envelope,
  existsSync,
  fake,
  heartbeat,
  http,
  isLoopbackHost,
  isLoopbackOrigin,
  janitorArgv,
  loadRegistry,
  loadRepos,
  makeServer as makeApiServer,
  mkdirSync,
  observedModelFromTranscript,
  openDb,
  path,
  planAdmittedEvents,
  readFileSync,
  registerWorker,
  rejection,
  repoNamesFromInput,
  registry,
  runOnce,
  sign,
  startApi,
  utimesSync,
  writeFileSync,
} from "./api-test-helpers.mjs";
import { DEFAULT_MAX_IN_FLIGHT, FACTORY_ROOT } from "./config.mjs";
import { agentsView, handleRegistryApiRoute } from "./api-registry.mjs";
import {
  KIND_EVENT_TYPE,
  KIND_MODEL_TIER_CELL,
  listOverrideJournal,
  putOverride,
} from "./runtime-overrides.mjs";

const makeServer = async (...args) => {
  const result = await makeApiServer(...args);
  trackTmpDir(path.dirname(result.db.filename));
  return result;
};

describe("agent and repository registry surfacing (OPS-212)", () => {
  test("GET /agents exposes definitions, prompt text, schemas, pins, and routing", async () => {
    const { server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      const { agents: defs, contracts } = await client.agents();
      const def = defs.find((d) => d.ref === "factory-status-report@1");
      expect(def.prompt).toContain("factory-status-report@1");
      expect(def.outputSchema.required).toContain("recommendedAction");
      expect(Object.keys(def.pins)).toHaveLength(3);
      expect(def.eventTypes[0].type).toBe("factory.status-report.requested");
      expect(def.mutating).toBe(false);
      // Model-tier routing (WM-135): declared intent plus the per-route
      // resolved value, straight off the committed registry + policy map.
      expect(def.modelTier).toBe("standard");
      expect(def.model).toBeNull();
      expect(def.eventTypes[0].resolvedModel).toBe(
        "openai-codex/gpt-5.6-terra",
      );
      const commandDef = defs.find((d) => d.ref === "reconcile@1");
      expect(commandDef.modelTier).toBeNull();
      expect(commandDef.eventTypes[0].resolvedModel).toBeNull();
      expect(def.declaredModelTier).toBe("standard");
      expect(def.eventTypes[0].declaredAdapter).toBe("pi");
      expect(
        contracts["factory.agent-result/v1"].properties.terminalState.enum,
      ).toContain("refused");
    } finally {
      server.close();
    }
  });

  test("GET /agents publishes the verified prompt snapshot, not the mutable path", () => {
    const isolated = loadRegistry();
    const def = isolated.agents.get("factory-status-report@1");
    const mutablePath = path.join(tmpDir("evrt-api-prompt-"), "prompt.md");
    writeFileSync(mutablePath, "replacement after registry load\n");
    def.promptPath = mutablePath;

    const published = agentsView(isolated).agents.find(
      (candidate) => candidate.ref === def.ref,
    );
    expect(published.prompt).toBe(def.promptText);
    expect(published.prompt).not.toContain("replacement after registry load");
  });

  test("GET /repos serves the repos.yaml registry, dispatch mode included (OPS-299)", async () => {
    const root = tmpDir("evrt-api-repos-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(
      path.join(root, "config", "repos.yaml"),
      `repos:\n  - name: dispatchable\n    path: ~/Develop/dispatchable\n    github: watt-mind/dispatchable\n    team: CLNT\n    base: develop\n    deploy_branch: master\n    worktree_down: bin/worktree-down.sh\n    worktree_root: ~/Develop/.worktrees/dispatchable\n    max_in_flight: 20\n    merge_ci:\n      workflow: CI\n      required_checks:\n        - Shadow runner fleet available\n        - Verify\n    escalate_paths:\n      - src/auth/**\n  - name: watched\n    path: ~/Develop/watched\n    team: OPS\n    report_only: true\n`,
    );
    const { server, port, close } = await makeServer({
      repos: () => loadRepos({ root }),
    });
    const client = apiClient({ port });
    try {
      const { repos: rows } = await client.repos();
      expect(rows.map((r) => r.name)).toEqual(["dispatchable", "watched"]);
      expect(rows[0]).toEqual({
        name: "dispatchable",
        path: path.join(process.env.HOME ?? "", "Develop/dispatchable"),
        github: "watt-mind/dispatchable",
        team: "CLNT",
        project: null,
        controlPlane: null,
        base: "develop",
        deployBranch: "master",
        reportOnly: false,
        maxInFlight: 20,
        effective: {
          maxInFlight: 20,
          maxInFlightSource: "repo",
        },
        smokeDeadlineSeconds: null,
        smokeWorkflow: null,
        smokeUrl: null,
        deployment: null,
        security: null,
        mergeCi: {
          workflow: "CI",
          requiredChecks: ["Shadow runner fleet available", "Verify"],
        },
        escalatePaths: ["src/auth/**"],
        ownedPathsPolicy: {
          direct: [],
          pinManifests: [],
        },
        worktreeRoot: path.join(
          process.env.HOME ?? "",
          "Develop/.worktrees/dispatchable",
        ),
        hasWorktreeUp: false,
        hasWorktreeDown: true,
        hasWorktreeWarm: false,
        verify: null,
      });
      expect(rows[1]).toMatchObject({
        reportOnly: true,
        maxInFlight: null,
        effective: {
          maxInFlight: DEFAULT_MAX_IN_FLIGHT,
          maxInFlightSource: "default",
        },
        mergeCi: null,
        escalatePaths: null,
        hasWorktreeDown: false,
      });
      // Wire names are deliberate camelCase projections, never raw YAML keys.
      expect(JSON.stringify(rows)).not.toContain("escalate_paths");
    } finally {
      close();
      server.close();
    }
  });

  test("GET /repos names a missing repos.yaml instead of a bare internal_error", async () => {
    const empty = tmpDir("evrt-api-norepos-");
    const { server, port, close } = await makeServer({
      repos: () => loadRepos({ root: empty }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("no repos config at");
      expect(body.error).not.toBe("internal_error");
    } finally {
      close();
      server.close();
    }
  });

  test("GET /repos surfaces malformed repos.yaml as RepoError instead of internal_error (OPS-346)", async () => {
    const malformed = tmpDir("evrt-api-badrepos-");
    mkdirSync(path.join(malformed, "config"), { recursive: true });
    writeFileSync(
      path.join(malformed, "config", "repos.yaml"),
      "repos: [ invalid: {",
    );
    const { server, port, close } = await makeServer({
      repos: () => loadRepos({ root: malformed }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("invalid YAML:");
      expect(body.error).not.toBe("internal_error");
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor dry-runs by default and never calls apply (OPS-301)", async () => {
    const calls = [];
    const fixture = new Map([
      [
        "dispatchable",
        {
          name: "dispatchable",
          reportOnly: false,
          worktreeDown: "bin/worktree-down.sh",
        },
      ],
    ]);
    const { server, port, close } = await makeServer({
      repos: () => fixture,
      janitor: async (name, opts) => {
        calls.push({ name, apply: opts.apply });
        return {
          name,
          reclaimable: [{ id: "OPS-1", state: "Done" }],
          kept: [],
          named: [],
          unknown: [],
          removed: [],
          refused: [],
        };
      },
    });
    const client = apiClient({ port });
    try {
      const body = await client.janitor("dispatchable");
      expect(body.actor).toBe("operator");
      expect(body.apply).toBe(false);
      expect(body.reclaimable).toEqual([{ id: "OPS-1", state: "Done" }]);
      expect(calls).toEqual([{ name: "dispatchable", apply: false }]);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor apply true reaches the injected janitor (OPS-301)", async () => {
    const calls = [];
    const fixture = new Map([
      [
        "dispatchable",
        {
          name: "dispatchable",
          reportOnly: false,
          worktreeDown: "bin/worktree-down.sh",
        },
      ],
    ]);
    const { server, port, close } = await makeServer({
      repos: () => fixture,
      janitor: async (name, opts) => {
        calls.push({ name, apply: opts.apply });
        return {
          name,
          reclaimable: [{ id: "OPS-1", state: "Done" }],
          removed: ["OPS-1"],
          refused: [],
          kept: [],
          named: [],
          unknown: [],
        };
      },
    });
    const client = apiClient({ port });
    try {
      const body = await client.janitor("dispatchable", { apply: true });
      expect(body.apply).toBe(true);
      expect(body.removed).toEqual(["OPS-1"]);
      expect(calls).toEqual([{ name: "dispatchable", apply: true }]);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor 404s an unknown repo without spawning (OPS-301)", async () => {
    let spawned = false;
    const { server, port, close } = await makeServer({
      repos: () =>
        new Map([
          [
            "dispatchable",
            {
              name: "dispatchable",
              reportOnly: false,
              worktreeDown: "bin/worktree-down.sh",
            },
          ],
        ]),
      janitor: async () => {
        spawned = true;
        return {};
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos/nope/janitor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown repo nope" });
      expect(spawned).toBe(false);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor apply on report_only without worktree_down is 409 (OPS-301)", async () => {
    let spawned = false;
    const { server, port, close } = await makeServer({
      repos: () =>
        new Map([
          [
            "watched",
            { name: "watched", reportOnly: true, worktreeDown: null },
          ],
        ]),
      janitor: async () => {
        spawned = true;
        return {};
      },
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/repos/watched/janitor`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apply: true }),
        },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(
        /report-only repo "watched" has no worktree_down/,
      );
      expect(spawned).toBe(false);
    } finally {
      close();
      server.close();
    }
  });

  test("POST /repos/:name/janitor rejects a non-boolean apply (OPS-301)", async () => {
    const { server, port, close } = await makeServer({
      repos: () =>
        new Map([
          [
            "dispatchable",
            {
              name: "dispatchable",
              reportOnly: false,
              worktreeDown: "bin/worktree-down.sh",
            },
          ],
        ]),
      janitor: async () => ({}),
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/repos/dispatchable/janitor`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apply: "please" }),
        },
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "apply must be a boolean" });
    } finally {
      close();
      server.close();
    }
  });

  test("janitorArgv never includes --force and adds --apply only when asked (OPS-301)", () => {
    const dry = janitorArgv("bj29");
    expect(dry).toContain("--json");
    expect(dry).toContain("bj29");
    expect(dry).not.toContain("--force");
    expect(dry).not.toContain("--apply");
    const apply = janitorArgv("bj29", { apply: true });
    expect(apply).toContain("--apply");
    expect(apply).not.toContain("--force");
    expect(apply.filter((a) => a === "--apply")).toHaveLength(1);
  });
});

describe("runtime overlay API (WM-887)", () => {
  const eventTypesFile = path.resolve(import.meta.dir, "../event-types.json");

  test("PUT/GET/DELETE event-type overlay; git file bytes are unchanged", async () => {
    const before = readFileSync(eventTypesFile);
    const { server, port, close } = await makeServer();
    try {
      const type = encodeURIComponent("factory.status-report.requested");
      const put = await fetch(
        `http://127.0.0.1:${port}/overrides/event-types/${type}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ adapter: "cursor" }),
        },
      );
      expect(put.status).toBe(200);
      const listed = await fetch(`http://127.0.0.1:${port}/overrides`);
      const body = await listed.json();
      expect(body.eventTypes["factory.status-report.requested"]).toEqual({
        adapter: "cursor",
      });
      const agents = await fetch(`http://127.0.0.1:${port}/agents`);
      const view = await agents.json();
      const def = view.agents.find((d) => d.ref === "factory-status-report@1");
      expect(def.eventTypes[0].declaredAdapter).toBe("pi");
      expect(def.eventTypes[0].adapter).toBe("cursor");
      expect(def.eventTypes[0].resolvedModel).toBe("cursor-grok-4.6-high");
      const del = await fetch(
        `http://127.0.0.1:${port}/overrides/event-types/${type}`,
        { method: "DELETE" },
      );
      expect((await del.json()).deleted).toBe(true);
      expect(readFileSync(eventTypesFile).equals(before)).toBe(true);
    } finally {
      close();
      server.close();
    }
  });

  test("unknown adapter is 422; agent overlay updates GET /agents effective tier", async () => {
    const { server, port, close } = await makeServer();
    try {
      const type = encodeURIComponent("factory.status-report.requested");
      const bad = await fetch(
        `http://127.0.0.1:${port}/overrides/event-types/${type}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ adapter: "nope" }),
        },
      );
      expect(bad.status).toBe(422);
      const ref = encodeURIComponent("factory-status-report@1");
      const put = await fetch(
        `http://127.0.0.1:${port}/overrides/agents/${ref}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelTier: "light" }),
        },
      );
      expect(put.status).toBe(200);
      const view = await (
        await fetch(`http://127.0.0.1:${port}/agents`)
      ).json();
      const def = view.agents.find((d) => d.ref === "factory-status-report@1");
      expect(def.declaredModelTier).toBe("standard");
      expect(def.modelTier).toBe("light");
      expect(def.eventTypes[0].resolvedModel).toBe("openai-codex/gpt-5.6-luna");
    } finally {
      close();
      server.close();
    }
  });

  test("policy model cells update independently, report restart semantics, and delete to tracked", async () => {
    const { server, port, close, db } = await makeServer();
    const endpoint = (adapter, tier) =>
      `http://127.0.0.1:${port}/overrides/config/models/${adapter}/${tier}`;
    try {
      const before = registry.modelTiers.pi.standard;
      const first = await fetch(endpoint("pi", "standard"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "runtime-pi-standard" }),
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        adapter: "pi",
        tier: "standard",
        trackedModel: before,
        runtimeModel: "runtime-pi-standard",
        effectiveModel: "runtime-pi-standard",
        source: "runtime",
        restartRequired: true,
      });
      expect(
        (
          await fetch(endpoint("claude", "light"), {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "runtime-claude-light" }),
          })
        ).status,
      ).toBe(200);

      const focused = await (
        await fetch(`http://127.0.0.1:${port}/overrides/config`)
      ).json();
      expect(focused.runtime.pi.standard).toBe("runtime-pi-standard");
      expect(focused.runtime.claude.light).toBe("runtime-claude-light");
      expect(focused.effective.pi.strong).toBe(
        registry.trackedModelTiers.pi.strong,
      );
      expect(Object.keys(focused).sort()).toEqual([
        "adapters",
        "effective",
        "runtime",
        "tiers",
        "tracked",
      ]);
      // Persistence does not mutate the running registry snapshot.
      expect(registry.modelTiers.pi.standard).toBe(before);

      const journal = listOverrideJournal(db).filter(
        (row) => row.kind === "modelTierCell",
      );
      expect(journal).toHaveLength(2);
      expect(journal.map((row) => row.key).sort()).toEqual([
        "claude:light",
        "pi:standard",
      ]);
      expect(journal.every((row) => row.actor === "operator")).toBe(true);

      const removed = await fetch(endpoint("pi", "standard"), {
        method: "DELETE",
      });
      expect(await removed.json()).toMatchObject({
        deleted: true,
        effectiveModel: before,
        source: "tracked",
        restartRequired: true,
      });
      const absent = await fetch(endpoint("pi", "standard"), {
        method: "DELETE",
      });
      expect(await absent.json()).toMatchObject({
        deleted: false,
        effectiveModel: before,
        restartRequired: true,
      });
    } finally {
      close();
      server.close();
    }
  });

  test("GET /config and GET /overrides/config reread the same tracked map", async () => {
    const root = tmpDir("evrt-api-model-map-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    const policy = path.join(root, "config", "policy.yaml");
    writeFileSync(policy, "models:\n  pi:\n    standard: disk-model-before\n");
    const previousRoot = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = root;
    const { server, port, close } = await makeServer({
      configRoot: root,
      repos: () => new Map(),
    });
    try {
      writeFileSync(policy, "models:\n  pi:\n    standard: disk-model-after\n");
      const config = await (
        await fetch(`http://127.0.0.1:${port}/config`)
      ).json();
      const overrides = await (
        await fetch(`http://127.0.0.1:${port}/overrides/config`)
      ).json();
      expect(
        config.sections.find((item) => item.id === "policy-models")
          .modelTierConfig.tracked.pi.standard,
      ).toBe("disk-model-after");
      expect(overrides.tracked.pi.standard).toBe("disk-model-after");
    } finally {
      close();
      server.close();
      if (previousRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
      else process.env.FACTORY_REPOS_ROOT = previousRoot;
    }
  });

  test("GET /overrides/config keeps strict corrupt-row behavior", async () => {
    const { server, port, db, close } = await makeServer();
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
      const response = await fetch(`http://127.0.0.1:${port}/overrides/config`);
      expect(response.status).toBe(500);
      expect((await response.json()).error).toContain(
        "delete or correct this runtime_overrides row",
      );
    } finally {
      close();
      server.close();
    }
  });

  test("GET /overrides/config maps a corrupt tracked policy.yaml to a 500 with a clear message", async () => {
    const root = tmpDir("evrt-api-corrupt-policy-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    const policy = path.join(root, "config", "policy.yaml");
    writeFileSync(policy, "models:\n  pi:\n    standard: ok\n");
    const previousRoot = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = root;
    const { server, port, close } = await makeServer({
      configRoot: root,
      repos: () => new Map(),
    });
    try {
      writeFileSync(policy, "models:\n  pi:\n    turbo: not-a-tier\n");
      const response = await fetch(`http://127.0.0.1:${port}/overrides/config`);
      expect(response.status).toBe(500);
      const { error } = await response.json();
      expect(error).toContain("tracked policy.yaml is unreadable");
      expect(error).toContain("models.pi.turbo is not a tier");
      const cell = await fetch(
        `http://127.0.0.1:${port}/overrides/config/models/pi/standard`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "x" }),
        },
      );
      expect(cell.status).toBe(500);
      expect((await cell.json()).error).toContain(
        "models.pi.turbo is not a tier",
      );
    } finally {
      close();
      server.close();
      if (previousRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
      else process.env.FACTORY_REPOS_ROOT = previousRoot;
    }
  });

  test("policy model cell endpoints reject invalid adapter, tier, and model patches", async () => {
    const { server, port, close } = await makeServer();
    try {
      const cases = [
        ["unknown/standard", { model: "x" }],
        ["pi/turbo", { model: "x" }],
        ["pi/standard", { model: "" }],
        ["pi/standard", { model: "x", extra: true }],
      ];
      for (const [pathPart, body] of cases) {
        const response = await fetch(
          `http://127.0.0.1:${port}/overrides/config/models/${pathPart}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        expect(response.status).toBe(422);
      }
      const malformed = await fetch(
        `http://127.0.0.1:${port}/overrides/config/models/%E0%A4%A/standard`,
        { method: "DELETE" },
      );
      expect(malformed.status).toBe(422);
      expect(await malformed.json()).toEqual({
        error: "model adapter and tier must use valid URL encoding",
      });
    } finally {
      close();
      server.close();
    }
  });
});

describe("overlay promotion routes (gh-860)", () => {
  const reg = loadRegistry();
  // Promotion resolves targets relative to reposRoot(); pin it to the checkout
  // the registry above was loaded from so a worker's FACTORY_REPOS_ROOT (the
  // checkout it serves) cannot put every target "outside the registry root".
  let previousReposRoot;
  beforeAll(() => {
    previousReposRoot = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = FACTORY_ROOT;
  });
  afterAll(() => {
    if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  });
  const reposFn = () =>
    loadRepos({
      root: (() => {
        const root = tmpDir("evrt-promo-repos-");
        mkdirSync(path.join(root, "config"), { recursive: true });
        writeFileSync(
          path.join(root, "config", "repos.yaml"),
          "repos:\n  - name: factory\n    path: /tmp/factory\n    github: watt-mind/factory\n    base: develop\n    worktree_up: bin/worktree-up.sh\n",
        );
        return root;
      })(),
    });

  function seed(db) {
    putOverride(db, {
      kind: KIND_EVENT_TYPE,
      key: "factory.status-report.requested",
      patch: { adapter: "cursor" },
      actor: "operator",
    });
  }

  async function invoke(method, pathname, { db, body, promotionSeams } = {}) {
    const captured = {};
    const send = (status, payload) => {
      captured.status = status;
      captured.body = payload;
      return true;
    };
    await handleRegistryApiRoute({
      route: `${method} ${pathname}`,
      req: { method },
      url: new URL(`http://x${pathname}`),
      send,
      readBody: async () => Buffer.from(JSON.stringify(body ?? {})),
      parseJson: (buf) => {
        try {
          return { value: JSON.parse(buf.toString() || "{}") };
        } catch (err) {
          return { error: err.message };
        }
      },
      registry: reg,
      repos: reposFn,
      actor: "operator",
      db,
      promotionSeams,
    });
    return captured;
  }

  test("GET /promotion/preview returns a digest and selectable rows", async () => {
    const db = openDb(":memory:");
    seed(db);
    const res = await invoke("GET", "/promotion/preview", { db });
    expect(res.status).toBe(200);
    expect(typeof res.body.digest).toBe("string");
    expect(
      res.body.selections.some(
        (s) => s.ref === "factory.status-report.requested",
      ),
    ).toBe(true);
    db.close();
  });

  test("POST /promotion/apply with an empty selection is a typed no-op", async () => {
    const db = openDb(":memory:");
    seed(db);
    const preview = await invoke("GET", "/promotion/preview", { db });
    const res = await invoke("POST", "/promotion/apply", {
      db,
      body: { repo: "factory", digest: preview.body.digest, keys: [] },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("noop");
    db.close();
  });

  test("POST /promotion/apply drives injected seams and returns the PR", async () => {
    const db = openDb(":memory:");
    seed(db);
    const preview = await invoke("GET", "/promotion/preview", { db });
    const key = preview.body.selections.find(
      (s) => s.ref === "factory.status-report.requested",
    ).key;
    const writes = new Map();
    const promotionSeams = {
      readTracked: (file) =>
        readFileSync(path.join(registry.root, "..", file), "utf8"),
      tracker: { ensure: () => ({ ticket: "gh-860-x" }) },
      worktree: {
        up: () => ({ dir: "/tmp/promo-x", branch: "promo/x" }),
      },
      readWorktree: (dir, file) =>
        writes.has(file)
          ? writes.get(file)
          : readFileSync(path.join(registry.root, "..", file), "utf8"),
      writeWorktree: (dir, file, text) => writes.set(file, text),
      git: { commit: () => {}, push: () => {} },
      forge: { openPr: () => ({ url: "u", number: 7 }) },
    };
    const res = await invoke("POST", "/promotion/apply", {
      db,
      body: { repo: "factory", digest: preview.body.digest, keys: [key] },
      promotionSeams,
    });
    expect(res.status).toBe(200);
    expect(res.body.pr).toEqual({ url: "u", number: 7 });
    expect(res.body.repo).toBe("factory");
    db.close();
  });

  test("POST /promotion/apply without configured seams fails closed (501)", async () => {
    const db = openDb(":memory:");
    seed(db);
    const preview = await invoke("GET", "/promotion/preview", { db });
    const key = preview.body.selections.find(
      (s) => s.ref === "factory.status-report.requested",
    ).key;
    const res = await invoke("POST", "/promotion/apply", {
      db,
      body: { repo: "factory", digest: preview.body.digest, keys: [key] },
    });
    expect(res.status).toBe(501);
    db.close();
  });

  test("POST /promotion/apply rejects a missing repo", async () => {
    const db = openDb(":memory:");
    seed(db);
    const res = await invoke("POST", "/promotion/apply", {
      db,
      body: { digest: "x", keys: ["k"] },
    });
    expect(res.status).toBe(422);
    db.close();
  });
});
