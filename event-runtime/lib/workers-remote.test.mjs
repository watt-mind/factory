import { test, expect, describe } from "bun:test";
import {
  buildSshArgv,
  executeSsh,
  probeRemoteNode,
  deployRemoteWorker,
  startRemoteWorker,
  stopRemoteWorker,
  updateRemoteWorker,
  RemoteWorkerConfigError,
} from "./workers-remote.mjs";

describe("ssh argv builder", () => {
  test("buildSshArgv constructs correct arguments", () => {
    const node = {
      name: "node1",
      host: "192.168.1.50",
      user: "worker",
      port: 2200,
    };
    const argv = buildSshArgv(node, "echo hello", {
      batchMode: true,
      connectTimeout: 3,
    });
    expect(argv).toEqual([
      "-p",
      "2200",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=3",
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
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
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

  test("probeRemoteNode expands remote probe variables and returns exact telemetry", () => {
    const mockSpawn = (args) => {
      const probeScript = args.at(-1);
      expect(probeScript).toContain(
        'echo "PROBE_RESULT:$HEAD_SHA|$BRANCH|$DIRTY|$ARCH|$OS|$BUN_VER|$WORKER_PIDS"',
      );
      expect(probeScript).not.toContain("$$HEAD_SHA");
      return {
        exitCode: 0,
        stdout:
          "PROBE_RESULT:0123456789abcdef0123456789abcdef01234567|feat/remote-probe|2|arm64|Darwin|1.3.14|501,777",
        stderr: "",
      };
    };

    const result = probeRemoteNode(testNode, {
      localTrunkSha: "0123456789abcdef0123456789abcdef01234567",
      spawnFn: mockSpawn,
    });

    expect(result.connected).toBe(true);
    expect(result.outdated).toBe(false);
    expect(result.skewStatus).toBe("synced");
    expect(result.workerActive).toBe(true);
    expect(result.workerPids).toEqual([501, 777]);
    expect(result.details.headSha).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(result.details.branch).toBe("feat/remote-probe");
    expect(result.details.dirtyCount).toBe(2);
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
      stdout:
        "Updating branch develop...\nInstalling dependencies...\nDEPLOY_SUCCESS\n",
      stderr: "",
    });

    const res = deployRemoteWorker(node, { spawnFn: mockSpawn });
    expect(res.ok).toBe(true);
    expect(res.error).toBe(null);
  });

  test("deployRemoteWorker freezes installs and shell-quotes configured values", () => {
    let deployScript = null;
    const ref = 'x"; echo pwned; "';
    const repoUrl = "ssh://git@example.test/worker's-factory.git";
    const res = deployRemoteWorker(
      { ...node, repoUrl },
      {
        ref,
        spawnFn: (args) => {
          deployScript = args.at(-1);
          return { exitCode: 0, stdout: "DEPLOY_SUCCESS\n", stderr: "" };
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(deployScript).toContain("bun install --frozen-lockfile");
    expect(deployScript).toContain(`git checkout '${ref}'`);
    expect(deployScript).toContain(`git pull --ff-only origin '${ref}'`);
    expect(deployScript).toContain(
      "git clone 'ssh://git@example.test/worker'\"'\"'s-factory.git' .",
    );
    expect(deployScript).not.toContain(`git checkout ${ref}`);
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

  test("startRemoteWorker shell-quotes environment, labels, and adapters", () => {
    let startScript = null;
    const res = startRemoteWorker(
      {
        ...node,
        env: { TOKEN: "cost$5 and 'quotes'" },
        labels: { node: "mini; echo pwned" },
        adapters: ["claude; echo pwned"],
      },
      {
        spawnFn: (args) => {
          startScript = args.at(-1);
          return { exitCode: 0, stdout: "START_SUCCESS:88123\n", stderr: "" };
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(startScript).toContain(
      "export TOKEN='cost$5 and '\"'\"'quotes'\"'\"'';",
    );
    expect(startScript).toContain("--labels 'node=mini; echo pwned'");
    expect(startScript).toContain("--adapters 'claude; echo pwned'");
  });

  test("startRemoteWorker rejects an invalid environment key before SSH", () => {
    let spawnCalls = 0;
    expect(() =>
      startRemoteWorker(
        { ...node, env: { "NOT-VALID": "value" } },
        {
          spawnFn: () => {
            spawnCalls += 1;
            return { exitCode: 0, stdout: "START_SUCCESS:1", stderr: "" };
          },
        },
      ),
    ).toThrow(RemoteWorkerConfigError);
    expect(spawnCalls).toBe(0);
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
      if (callCount === 1)
        return { exitCode: 0, stdout: "STOP_SUCCESS:1", stderr: "" };
      if (callCount === 2)
        return { exitCode: 0, stdout: "DEPLOY_SUCCESS", stderr: "" };
      if (callCount === 3)
        return { exitCode: 0, stdout: "START_SUCCESS:99201", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const res = updateRemoteWorker(node, { spawnFn: mockSpawn });
    expect(res.ok).toBe(true);
    expect(res.pid).toBe(99201);
    expect(callCount).toBe(3);
  });
});
