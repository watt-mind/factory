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
          maxInFlight: 3,
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
});
