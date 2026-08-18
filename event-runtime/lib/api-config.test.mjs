import {
  tmpDir,
  trackTmpDir,
} from "../test-support/tmp.mjs?file=event-runtime-lib-api-config-test-mjs";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configView } from "./api-config.mjs";
import { makeServer as makeApiServer } from "./api-test-helpers.mjs";
import { reposView } from "./repos.mjs";

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
      "nodes",
      "schedule",
      "registry",
    ]);
    expect(view.sections.map((section) => section.reload)).toEqual([
      "hot",
      "hot",
      "cli-only",
      "cli-only",
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
    expect(policy.entries.find((entry) => entry.key === "models").reload).toBe(
      "restart",
    );
    const eventType = view.sections
      .find((section) => section.id === "registry")
      .entries.find((entry) => entry.key.includes("factory.triage.requested"));
    expect(eventType.value).toBe("pi");
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
});
