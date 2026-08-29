import {
  tmpDir,
  trackTmpDir,
} from "../test-support/tmp.mjs?file=event-runtime-lib-api-test-mjs";
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
import { cpSync } from "node:fs";
import { emitDueTicks } from "./schedules.mjs";
import { createInboxItem } from "./inbox.mjs";
import { decisionRequestHash } from "./decision.mjs";
import { hashJson } from "./canonical.mjs";
import {
  registerTestProcessCleanup,
  spawnTracked,
} from "./test-helpers-process.mjs";

registerTestProcessCleanup(import.meta.url);

const makeServer = async (...args) => {
  const result = await makeApiServer(...args);
  trackTmpDir(path.dirname(result.db.filename));
  return result;
};

describe("inbox decision API (WM-390)", () => {
  const request = {
    schemaVersion: "factory.decision-request/v1",
    question: "Dismiss this item?",
    options: [{ id: "dismiss", label: "Dismiss", effect: "dismiss" }],
  };

  test("detail, decide, conflicts, and retry use typed statuses", async () => {
    const s = await makeServer({ now: () => 1000 });
    try {
      createInboxItem(
        s.db,
        {
          kind: "BLOCKED",
          title: "decision",
          decision: request,
        },
        { id: "api_decision" },
      );

      const detail = await fetch(s.url("/inbox/api_decision"));
      expect(detail.status).toBe(200);
      expect((await detail.json()).item.decision).toEqual(request);
      expect((await fetch(s.url("/inbox/missing"))).status).toBe(404);

      const stale = await fetch(s.url("/inbox/api_decision/decide"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "factory.decision-response/v1",
          requestHash: "sha256:" + "0".repeat(64),
          optionId: "dismiss",
          fields: {},
        }),
      });
      expect(stale.status).toBe(409);
      expect((await stale.json()).error).toBe("stale_request");

      const malformed = await fetch(s.url("/inbox/api_decision/decide"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestHash: decisionRequestHash(request),
          optionId: "dismiss",
          fields: {},
        }),
      });
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error).toBe("invalid_response");

      const decided = await fetch(s.url("/inbox/api_decision/decide"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "factory.decision-response/v1",
          requestHash: decisionRequestHash(request),
          optionId: "dismiss",
          fields: {},
        }),
      });
      expect(decided.status).toBe(200);
      expect(await decided.json()).toMatchObject({
        item: { resolvedBy: "operator:dismiss", decidedBy: "operator" },
        effect: { kind: "dismiss", outcome: "applied" },
      });

      const appliedRetry = await fetch(
        s.url("/inbox/api_decision/decide/retry"),
        { method: "POST" },
      );
      expect(appliedRetry.status).toBe(409);
      expect((await appliedRetry.json()).error).toBe("already_applied");

      const again = await fetch(s.url("/inbox/api_decision/decide"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestHash: decisionRequestHash(request),
          optionId: "dismiss",
          fields: {},
        }),
      });
      expect(again.status).toBe(409);
      expect((await again.json()).error).toBe("already_decided");

      const undecided = createInboxItem(
        s.db,
        {
          kind: "BLOCKED",
          title: "not answered",
          decision: request,
        },
        { id: "not_decided" },
      );
      const retry = await fetch(s.url(`/inbox/${undecided.id}/decide/retry`), {
        method: "POST",
      });
      expect(retry.status).toBe(409);
      expect((await retry.json()).error).toBe("not_decided");
    } finally {
      s.close();
    }
  });

  test("authorise admits an inbox-sourced dispatch through the ordinary intake", async () => {
    const nowMs = Date.parse("2026-08-18T12:00:00.000Z");
    const testRegistry = { ...registry, agents: new Map(registry.agents) };
    testRegistry.agents.set("dispatch@1", {
      ...registry.agents.get("dispatch@1"),
      // Keep this API/intake proof local: worktree dispatch eligibility is
      // independently covered by dispatch tests and requires live Linear.
      workspace: { type: "ephemeral" },
    });
    const s = await makeServer({
      now: () => nowMs,
      registry: testRegistry,
      inboxLinear: {
        get: () => ({ description: "## Owned Paths\n- src/feature/**\n" }),
      },
    });
    const authorise = {
      schemaVersion: "factory.decision-request/v1",
      question: "May the agent proceed?",
      options: [
        {
          id: "authorise",
          label: "Authorise",
          effect: "authorise",
          scope: {
            paths: ["src/feature/**"],
            summary: "Implement the approved feature",
          },
        },
      ],
    };
    try {
      createInboxItem(
        s.db,
        {
          kind: "ESCALATED",
          title: "Authorise dispatch",
          refs: { issue: "WM-313", repo: "factory", runId: "run_refused" },
          decision: authorise,
        },
        { id: "api_authorise" },
      );
      const res = await fetch(s.url("/inbox/api_authorise/decide"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "factory.decision-response/v1",
          requestHash: decisionRequestHash(authorise),
          optionId: "authorise",
          fields: {},
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        item: { resolvedBy: "operator:authorise" },
        effect: { outcome: "applied", detail: "dispatched" },
      });
      const admitted = s.db
        .query(
          "SELECT source, event_id, correlation_id, envelope_json FROM events WHERE source = 'inbox'",
        )
        .get();
      expect(admitted).toMatchObject({
        source: "inbox",
        event_id: "api_authorise",
        correlation_id: "api_authorise",
      });
      expect(s.onEvents).toContain("admitted");
      const envelope = JSON.parse(admitted.envelope_json);
      expect(envelope.payload.humanDecision).toMatchObject({
        schemaVersion: "factory.human-decision/v1",
        inboxItemId: "api_authorise",
        authorisation: {
          ticket: "WM-313",
          repo: "factory",
          refusedRunId: "run_refused",
        },
      });
      expect(
        planAdmittedEvents(s.db, testRegistry, {
          now: nowMs,
          policyVersion: PV,
        }),
      ).toMatchObject({ planned: 1, failed: 0 });
      const spec = JSON.parse(
        s.db.query("SELECT spec_json FROM runs").get().spec_json,
      );
      expect(spec.input.humanDecision.inboxItemId).toBe("api_authorise");
      expect(spec.inputHash).not.toBe(
        hashJson({ repo: "factory", ticket: "WM-313" }),
      );
    } finally {
      s.close();
    }
  });
});
describe("schedule trigger metadata (WM-259)", () => {
  test("run and trigger return the unchanged next scheduled tick", async () => {
    const nowMs = Date.parse("2026-08-17T11:35:00.000Z");
    const scheduleRegistry = {
      ...registry,
      schedules: {
        reaper: {
          ...registry.schedules.reaper,
          every: "60m",
          enabled: true,
          payload: { repo: "factory" },
        },
      },
    };
    const s = await makeServer({
      registry: scheduleRegistry,
      now: () => nowMs,
    });
    try {
      emitDueTicks(s.db, scheduleRegistry, {
        now: Date.parse("2026-08-17T11:00:00.000Z"),
      });

      for (const action of ["run", "trigger"]) {
        const res = await fetch(s.url(`/schedules/reaper/${action}`), {
          method: "POST",
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.schedule).toMatchObject({
          loop: "reaper",
          repo: "factory",
          lastSlot: "2026-08-17T11:00:00.000Z",
          nextDue: "2026-08-17T12:00:00.000Z",
          stopped: false,
        });
      }

      const operatorEvents = s.db
        .query(
          `SELECT envelope_json FROM events WHERE source = 'operator' ORDER BY event_id`,
        )
        .all()
        .map((row) => JSON.parse(row.envelope_json));
      expect(operatorEvents).toHaveLength(2);
      expect(
        operatorEvents.every((event) => event.payload.repo === "factory"),
      ).toBe(true);

      const schedules = await (await fetch(s.url("/schedules"))).json();
      expect(schedules.schedules[0]).toMatchObject({
        lastSlot: "2026-08-17T11:00:00.000Z",
        nextDue: "2026-08-17T12:00:00.000Z",
        stopped: false,
      });
    } finally {
      s.close();
    }
  });

  test("Ship uses the existing schedule route and correlates its proposal to RC READY", async () => {
    // Client ship loops (ship-bj29) live in the instance overlay, not the
    // public kernel's schedules.json (#1052). Supply an explicit ship-bj29
    // fixture so this exercises the ship route hermetically instead of
    // depending on a client loop being tracked in the kernel registry.
    const shipRegistry = {
      ...registry,
      schedules: {
        "ship-bj29": {
          every: "7d",
          eventType: "factory.ship.requested",
          payload: { repo: "bj29" },
          catchUp: "none",
          singleton: true,
          approval: "watched",
          enabled: false,
        },
      },
    };
    const s = await makeServer({
      registry: shipRegistry,
      now: () => Date.parse("2026-08-18T12:00:00Z"),
    });
    try {
      createInboxItem(
        s.db,
        {
          kind: "RC READY",
          title: "bj29 is ready to ship",
          refs: { repo: "bj29" },
        },
        { id: "rc-ready-api" },
      );
      const response = await fetch(s.url("/schedules/ship-bj29/run"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ loop: "ship-bj29", admitted: true });
      expect(typeof body.proposalId).toBe("string");
      expect(
        JSON.parse(
          s.db
            .query(
              "SELECT refs_json FROM inbox_items WHERE id = 'rc-ready-api'",
            )
            .get().refs_json,
        ),
      ).toEqual({ repo: "bj29", proposalId: body.proposalId });
    } finally {
      s.close();
    }
  });
});

describe("artifact-view sidecar on GET /agents (WM-454)", () => {
  test("every agent item carries outputView/outputViewFile; views are objects where a sidecar exists, null elsewhere", async () => {
    const { server, port } = await makeServer();
    const client = apiClient({ port });
    try {
      const { agents: defs } = await client.agents();
      for (const def of defs) {
        expect(def).toHaveProperty("outputView");
        expect(def).toHaveProperty("outputViewFile");
      }
      const merge = defs.find((d) => d.ref === "merge-scan@2");
      expect(merge.outputViewFile).toBe("agents/merge-scan.view.json");
      expect(merge.outputView.schemaVersion).toBe("factory.artifact-view/v1");
      expect(merge.outputView.status.path).toBe("/recommendation");
      expect(merge.view).toEqual({ source: "agent" });
      const triage = defs.find((d) => d.ref === "triage-scan@1");
      expect(triage.outputView.summary).toBe("/summary");
      const dispatch = defs.find((d) => d.ref === "dispatch@1");
      expect(dispatch.view).toEqual({ source: "agent" });
      expect(dispatch.outputView.subject).toBe(
        "Dispatch {/ticket} · {/repo} · {model}",
      );
      expect(dispatch.outputView.input.sections[0].formats.ticket).toBe(
        "issue",
      );
      expect(dispatch.outputView.summary).toBe("/summary");
      expect(dispatch.outputView.status.path).toBe("/outcome");
      expect(dispatch.outputView.sections.map((s) => s.path)).toEqual([
        "",
        "/verification",
        "/uxCritique",
      ]);
      const command = defs.find((d) => d.ref === "reconcile@1");
      expect(command.view).toEqual({ source: "contract" });
      expect(command.outputViewFile).toBe(
        "agents/views/factory.command-result.v1.view.json",
      );
      expect(command.outputView.title).toBe("Command");
      const bare = defs.find((d) => d.ref === "disk-diagnose@1");
      expect(bare.outputView).toBeNull();
      expect(bare.outputViewFile).toBeNull();
      expect(bare.view).toBeNull();
      // Not part of the pinned identity.
      expect(Object.keys(merge.pins)).not.toContain(
        "agents/merge-scan.view.json",
      );
      // web/src/types.ts AgentDef names both fields (kept in step by hand;
      // AgentDef is not pinned by the OPS-284 parity test).
      const typesSrc = readFileSync(
        path.resolve(import.meta.dir, "../web/src/types.ts"),
        "utf8",
      );
      const agentDef = typesSrc.slice(
        typesSrc.indexOf("export interface AgentDef {"),
      );
      expect(agentDef).toContain("outputViewFile?");
      expect(agentDef).toContain("outputView?");
      expect(agentDef).toContain('source: "agent" | "contract"');
    } finally {
      server.close();
    }
  });

  test("a drifted view is served as null and named in /status.anomalies.configuration", async () => {
    const root = tmpDir("evrt-view-");
    for (const dir of ["agents", "schemas"]) {
      cpSync(path.join(registry.root, dir), path.join(root, dir), {
        recursive: true,
      });
    }
    cpSync(
      path.join(registry.root, "event-types.json"),
      path.join(root, "event-types.json"),
    );
    const viewFile = path.join(root, "agents", "triage-scan.view.json");
    const view = JSON.parse(readFileSync(viewFile, "utf8"));
    view.summary = "/tldr";
    writeFileSync(viewFile, JSON.stringify(view));
    const drifted = loadRegistry({ root, modelTiers: registry.modelTiers });
    const { server, port } = await makeServer({ registry: drifted });
    const client = apiClient({ port });
    try {
      const { agents: defs } = await client.agents();
      const triage = defs.find((d) => d.ref === "triage-scan@1");
      expect(triage.outputView).toBeNull();
      expect(triage.outputViewFile).toBe("agents/triage-scan.view.json");
      const status = await client.status();
      const anomaly = status.anomalies.configuration.find((a) =>
        a.includes("triage-scan@1"),
      );
      expect(anomaly).toContain("agents/triage-scan.view.json");
      expect(anomaly).toMatch(/"\/tldr" does not resolve/);
    } finally {
      server.close();
    }
  });
});

describe("spec subject on GET /runs/:id and /proposals (WM-897)", () => {
  const spec = {
    schemaVersion: "factory.run-spec/v1",
    runId: "run_subject",
    agent: "dispatch@1",
    input: { repo: "factory", ticket: "WM-862" },
    inputHash: "sha256:input",
    workspace: { type: "none" },
    adapter: "cursor",
    promptVersion: "test",
    policyVersion: PV,
    outputContract: "factory.dispatch-result/v1",
    capabilities: [],
    timeoutSeconds: 60,
    maxAttempts: 1,
    idempotencyKey: "idem-subject",
    model: "cursor-grok-4.6-high",
  };

  test("GET /runs/:id exposes the rendered subject", async () => {
    const s = await makeServer();
    try {
      s.db
        .query(
          `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'COMPLETED', 1, ?, ?)`,
        )
        .run(
          "run_subject",
          "idem-subject",
          JSON.stringify(spec),
          "sha256:spec",
          "2026-08-19T12:00:00.000Z",
          "2026-08-19T12:00:00.000Z",
        );
      const res = await fetch(s.url("/runs/run_subject"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.subject).toBe(
        "Dispatch WM-862 · factory · cursor-grok-4.6-high",
      );
    } finally {
      s.close();
    }
  });

  test("GET /proposals and GET /proposals/:id expose the rendered subject", async () => {
    const s = await makeServer();
    try {
      s.db
        .query(
          `INSERT INTO proposals
             (id, event_source, event_id, decision, status, created_at, ttl_seconds, spec_json)
           VALUES (?, 'test', 'ev-subject', 'run', 'open', ?, 3600, ?)`,
        )
        .run("prop_subject", "2026-08-19T12:00:00.000Z", JSON.stringify(spec));
      const list = await fetch(s.url("/proposals?status=all"));
      expect(list.status).toBe(200);
      const listed = (await list.json()).proposals.find(
        (p) => p.id === "prop_subject",
      );
      expect(listed.subject).toBe(
        "Dispatch WM-862 · factory · cursor-grok-4.6-high",
      );
      const detail = await fetch(s.url("/proposals/prop_subject"));
      expect(detail.status).toBe(200);
      expect((await detail.json()).proposal.subject).toBe(
        "Dispatch WM-862 · factory · cursor-grok-4.6-high",
      );
    } finally {
      s.close();
    }
  });
});

describe("environment identity (webui chip)", () => {
  test("health and status expose the env the server was started with", async () => {
    const dir = tmpDir("evrt-env-");
    const db = openDb(path.join(dir, "runtime.db"));
    const server = startApi({
      db,
      registry,
      secret: SECRET,
      policyVersion: PV,
      port: 0,
      env: { name: "dev", home: dir, adapter: "fake" },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    const client = apiClient({ port: server.address().port });
    try {
      const health = await client.health();
      expect(health.env).toEqual({ name: "dev", home: dir, adapter: "fake" });
      expect((await client.status()).env.name).toBe("dev");
    } finally {
      server.close();
    }
  });
});

describe("serve PID lock (OPS-458)", () => {
  test("acquireServeLock acquires lock in empty runtime home and releaseServeLock removes it", async () => {
    const { acquireServeLock, releaseServeLock, serveLockPath } =
      await import("../cli.mjs");
    const home = tmpDir("evrt-lock-");
    const lock = acquireServeLock(home, 7381);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(7381);

    const lockFile = serveLockPath(home);
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(lockFile)).toBe(true);
    const data = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(data.pid).toBe(process.pid);
    expect(data.port).toBe(7381);

    releaseServeLock(home);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("acquireServeLock fails when locked by a live process with clear PID and port", async () => {
    const { acquireServeLock, releaseServeLock, serveLockPath } =
      await import("../cli.mjs");
    const home = tmpDir("evrt-lock-");
    const lockFile = serveLockPath(home);
    const { writeFileSync } = await import("node:fs");
    const { spawn } = await import("node:child_process");

    // Spawn a dummy process to be a live owner
    const sleeper = spawn("sleep", ["60"]);
    try {
      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: sleeper.pid,
          port: 7381,
          startedAt: new Date().toISOString(),
        }),
        "utf8",
      );
      expect(() => acquireServeLock(home, 7382)).toThrow(
        /already locked by PID \d+ \(port 7381\)/,
      );
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  test("acquireServeLock reclaims a stale lock from a dead process", async () => {
    const { acquireServeLock, releaseServeLock, serveLockPath } =
      await import("../cli.mjs");
    const home = tmpDir("evrt-lock-");
    const lockFile = serveLockPath(home);
    const { writeFileSync, readFileSync } = await import("node:fs");

    // Use a PID that does not exist
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 99999999,
        port: 7381,
        startedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const lock = acquireServeLock(home, 7385);
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(7385);
    const data = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(data.pid).toBe(process.pid);
    expect(data.port).toBe(7385);
    releaseServeLock(home);
  });

  test("concurrent duplicate serve on same home fails second instance and releasing first allows next", async () => {
    const home = tmpDir("evrt-lock-cli-");
    // Ask the OS for genuinely free ports instead of pid-modulo arithmetic:
    // 59500/59700 + pid % 200 collides on a busy CI host and fails at listen
    // before the lock assertion runs (WM-740). Hold both listeners until both
    // ports are known so the same call never returns duplicates. Serve rejects
    // --port 0, so the probes are released before spawn.
    const probes = [
      Bun.serve({ port: 0, fetch: () => new Response("") }),
      Bun.serve({ port: 0, fetch: () => new Response("") }),
    ];
    const [port1, port2] = probes.map((p) => String(p.port));
    for (const p of probes) p.stop(true);
    const CLI = path.resolve(import.meta.dir, "../cli.mjs");

    const serve1 = spawnTracked("bun", [CLI, "serve", "--port", port1], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out1 = "";
    serve1.stdout.on("data", (b) => {
      out1 += b;
    });
    serve1.stderr.on("data", (b) => {
      out1 += b;
    });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !out1.includes("control API on")) {
      await Bun.sleep(100);
    }
    expect(out1).toContain("control API on");

    // Second serve targeting same home should fail immediately
    const serve2 = spawnTracked("bun", [CLI, "serve", "--port", port2], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out2 = "";
    serve2.stdout.on("data", (b) => {
      out2 += b;
    });
    serve2.stderr.on("data", (b) => {
      out2 += b;
    });
    const exitCode2 = await new Promise((resolve) =>
      serve2.on("exit", resolve),
    );
    expect(exitCode2).not.toBe(0);
    expect(out2).toContain("already locked by PID");

    // Kill serve1
    serve1.kill("SIGTERM");
    await new Promise((resolve) => serve1.on("exit", resolve));

    // Now a third serve should succeed
    const serve3 = spawnTracked("bun", [CLI, "serve", "--port", port2], {
      env: { ...process.env, FACTORY_EVENT_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out3 = "";
    serve3.stdout.on("data", (b) => {
      out3 += b;
    });
    serve3.stderr.on("data", (b) => {
      out3 += b;
    });

    const deadline3 = Date.now() + 8000;
    while (Date.now() < deadline3 && !out3.includes("control API on")) {
      await Bun.sleep(100);
    }
    try {
      expect(out3).toContain("control API on");
    } finally {
      serve3.kill("SIGTERM");
      await new Promise((resolve) => serve3.on("exit", resolve));
    }
  });
});
