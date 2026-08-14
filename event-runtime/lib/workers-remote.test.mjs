import { test, expect, describe } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadNodesConfig,
  buildSshArgv,
  executeSsh,
  probeRemoteNode,
  deployRemoteWorker,
  startRemoteWorker,
  stopRemoteWorker,
  updateRemoteWorker,
  NodeConfigError,
} from "./workers-remote.mjs";

describe("nodes config loader", () => {
  test("loadNodesConfig parses valid nodes.yaml correctly", () => {
    const dir = path.join(tmpdir(), `test-nodes-${Date.now()}`);
    mkdirSync(path.join(dir, "config"), { recursive: true });
    writeFileSync(
      path.join(dir, "config", "nodes.yaml"),
      `
nodes:
  mac-mini:
    host: "mac-mini.local"
    user: "dev"
    port: 2222
    factory_root: "~/Develop/factory"
    branch: "main"
    env:
      FACTORY_EVENT_PORT: 7381
    labels:
      node: "mac-mini"
      arch: "arm64"
    adapters:
      - "claude"
      - "command"
`,
    );

    try {
      const nodes = loadNodesConfig({ root: dir });
      expect(nodes.size).toBe(1);
      const node = nodes.get("mac-mini");
      expect(node).toEqual({
        name: "mac-mini",
        host: "mac-mini.local",
        user: "dev",
        port: 2222,
        factoryRoot: "~/Develop/factory",
        branch: "main",
        env: { FACTORY_EVENT_PORT: 7381 },
        labels: { node: "mac-mini", arch: "arm64" },
        adapters: ["claude", "command"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadNodesConfig handles missing file gracefully", () => {
    const nodes = loadNodesConfig({ configPath: "/nonexistent/nodes.yaml" });
    expect(nodes.size).toBe(0);
  });

  test("loadNodesConfig rejects invalid node definitions", () => {
    const dir = path.join(tmpdir(), `test-nodes-err-${Date.now()}`);
    mkdirSync(path.join(dir, "config"), { recursive: true });
    writeFileSync(
      path.join(dir, "config", "nodes.yaml"),
      `
nodes:
  bad-node:
    port: "invalid"
`,
    );

    try {
      expect(() => loadNodesConfig({ root: dir })).toThrow(NodeConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ssh argv builder", () => {
  test("buildSshArgv constructs correct arguments", () => {
    const node = {
      name: "node1",
      host: "192.168.1.50",
      user: "worker",
      port: 2200,
    };
    const argv = buildSshArgv(node, "echo hello", { batchMode: true, connectTimeout: 3 });
    expect(argv).toEqual([
      "-p", "2200",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=3",
      "worker@192.168.1.50",
      "echo hello",
    ]);
  });

  test("buildSshArgv handles default port and omitted user", () => {
    const node = {
      name: "node2",
      host: "box.internal",
      user: null,
      port: 22,
    };
    const argv = buildSshArgv(node, ["git", "status"]);
    expect(argv).toEqual([
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=5",
      "box.internal",
      "git status",
    ]);
  });
});

describe("remote probe and version skew", () => {
  const testNode = {
    name: "mini",
    host: "mini.local",
    user: "dev",
    port: 22,
    factoryRoot: "~/Develop/factory",
    labels: { arch: "arm64" },
    adapters: ["claude"],
  };

  test("probeRemoteNode detects synced remote worker", () => {
    const mockSpawn = () => ({
      exitCode: 0,
      stdout: "PROBE_RESULT:abc12345|develop|0|arm64|Darwin|1.3.14|45001",
      stderr: "",
    });

    const result = probeRemoteNode(testNode, {
      localTrunkSha: "abc12345",
      spawnFn: mockSpawn,
    });

    expect(result.connected).toBe(true);
    expect(result.outdated).toBe(false);
    expect(result.skewStatus).toBe("synced");
    expect(result.workerActive).toBe(true);
    expect(result.workerPids).toEqual([45001]);
    expect(result.details.headSha).toBe("abc12345");
  });

  test("probeRemoteNode detects outdated version skew", () => {
    const mockSpawn = () => ({
      exitCode: 0,
      stdout: "PROBE_RESULT:oldsha99|develop|0|arm64|Darwin|1.3.14|",
      stderr: "",
    });

    const result = probeRemoteNode(testNode, {
      localTrunkSha: "newsha00",
      spawnFn: mockSpawn,
    });

    expect(result.connected).toBe(true);
    expect(result.outdated).toBe(true);
    expect(result.skewStatus).toBe("outdated");
    expect(result.workerActive).toBe(false);
    expect(result.workerPids).toEqual([]);
  });

  test("probeRemoteNode handles unreachable node", () => {
    const mockSpawn = () => ({
      exitCode: 255,
      stdout: "",
      stderr: "ssh: connect to host mini.local port 22: Operation timed out",
    });

    const result = probeRemoteNode(testNode, {
      localTrunkSha: "abc",
      spawnFn: mockSpawn,
    });

    expect(result.connected).toBe(false);
    expect(result.skewStatus).toBe("unreachable");
    expect(result.error).toContain("timed out");
  });
});

describe("remote lifecycle operations", () => {
  const node = {
    name: "mini",
    host: "mini.local",
    user: "dev",
    port: 22,
    factoryRoot: "~/Develop/factory",
    branch: "develop",
    env: { FACTORY_EVENT_PORT: 7381 },
    labels: { node: "mini" },
    adapters: ["claude"],
  };

  test("deployRemoteWorker executes deploy script successfully", () => {
    const mockSpawn = () => ({
      exitCode: 0,
      stdout: "Updating branch develop...\nInstalling dependencies...\nDEPLOY_SUCCESS\n",
      stderr: "",
    });

    const res = deployRemoteWorker(node, { spawnFn: mockSpawn });
    expect(res.ok).toBe(true);
    expect(res.error).toBe(null);
  });

  test("startRemoteWorker parses launched PID", () => {
    const mockSpawn = () => ({
      exitCode: 0,
      stdout: "START_SUCCESS:88123\n",
      stderr: "",
    });

    const res = startRemoteWorker(node, { spawnFn: mockSpawn });
    expect(res.ok).toBe(true);
    expect(res.pid).toBe(88123);
  });

  test("stopRemoteWorker handles stop signal and drain", () => {
    const mockSpawn = () => ({
      exitCode: 0,
      stdout: "STOP_SUCCESS:1\n",
      stderr: "",
    });

    const res = stopRemoteWorker(node, { spawnFn: mockSpawn });
    expect(res.ok).toBe(true);
  });

  test("updateRemoteWorker chains stop, deploy, and start", () => {
    let callCount = 0;
    const mockSpawn = () => {
      callCount += 1;
      if (callCount === 1) return { exitCode: 0, stdout: "STOP_SUCCESS:1", stderr: "" };
      if (callCount === 2) return { exitCode: 0, stdout: "DEPLOY_SUCCESS", stderr: "" };
      if (callCount === 3) return { exitCode: 0, stdout: "START_SUCCESS:99201", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const res = updateRemoteWorker(node, { spawnFn: mockSpawn });
    expect(res.ok).toBe(true);
    expect(res.pid).toBe(99201);
    expect(callCount).toBe(3);
  });
});
