import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-cli-process-cleanup-test-mjs";
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupTrackedProcesses,
  processOwnerWatchdogSource,
  spawnTracked,
  trackProcessGroupForPid,
} from "../lib/test-helpers-process.mjs";

const EVENT_RUNTIME = fileURLToPath(new URL("..", import.meta.url));
const LIVE_STACK = fileURLToPath(
  new URL("../../bin/live-stack.sh", import.meta.url),
);

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      /* intentionally ignored */
    }
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await Bun.sleep(10);
  }
  throw new Error(`pid ${pid} did not exit`);
}

function testFiles(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(target));
    else if (entry.name.endsWith(".test.mjs")) found.push(target);
  }
  return found;
}

describe("tracked test processes (WM-654)", () => {
  test("refuses to register the test runner's own process group", () => {
    expect(() => trackProcessGroupForPid(process.pid)).toThrow(
      "refusing to track the test runner process group",
    );
  });

  test("spawn failures report error without throwing before listeners attach", async () => {
    const child = spawnTracked("factory-wm654-command-does-not-exist", [], {
      stdio: "ignore",
    });
    const error = await new Promise((resolve) => child.once("error", resolve));
    expect(error.code).toBe("ENOENT");
  });

  test("detached fixtures self-destruct when their test owner disappears", async () => {
    const dir = tmpDir("evrt-owner-watch-");
    const script = path.join(dir, "fixture.mjs");
    writeFileSync(
      script,
      `${processOwnerWatchdogSource(2_147_483_646)}\nsetInterval(() => {}, 10_000);\n`,
      "utf8",
    );
    const child = spawnTracked("bun", [script], { stdio: "ignore" });
    const result = await new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    expect(result).toEqual({ code: null, signal: "SIGKILL" });
  });

  test("cleanup kills a spawned wrapper and its long-lived grandchild", async () => {
    const dir = tmpDir("evrt-tracked-group-");
    const pidFile = path.join(dir, "grandchild.pid");
    const child = spawnTracked(
      "bash",
      [
        "-c",
        `sleep 60 & printf '%s\\n' "$!" > ${JSON.stringify(pidFile)}; wait`,
      ],
      { stdio: "ignore" },
    );
    const grandchildPid = Number(await waitForFile(pidFile));
    expect(processExists(child.pid)).toBe(true);
    expect(processExists(grandchildPid)).toBe(true);

    await cleanupTrackedProcesses();

    await waitForExit(child.pid);
    await waitForExit(grandchildPid);
  });

  test("live-stack down warns and kills old fake-adapter test runtimes", async () => {
    const dir = tmpDir("evrt-stale-fake-");
    const fakeCli = path.join(dir, "event-runtime", "cli.mjs");
    mkdirSync(path.dirname(fakeCli), { recursive: true });
    writeFileSync(fakeCli, "setInterval(() => {}, 10_000);\n", "utf8");
    const child = spawnTracked(
      "bun",
      [fakeCli, "serve", "--adapter-override", "fake"],
      { stdio: "ignore" },
    );

    const result = spawnSync("bash", [LIVE_STACK, "down"], {
      cwd: path.dirname(EVENT_RUNTIME),
      encoding: "utf8",
      env: {
        ...process.env,
        FACTORY_EVENT_HOME: path.join(dir, "home"),
        FACTORY_RUN_DIR: path.join(dir, "run"),
        FACTORY_FAKE_RUNTIME_MAX_AGE_MINUTES: "0",
      },
    });

    expect(`${result.stdout}${result.stderr}`).toContain(
      `killing stale fake-adapter test runtime pid ${child.pid}`,
    );
    expect(result.status).toBe(0);
    await waitForExit(child.pid);
  });

  test("live-stack down leaves unmarked fake-adapter runtimes alone", async () => {
    const dir = tmpDir("evrt-unmarked-fake-");
    const fakeCli = path.join(dir, "event-runtime", "cli.mjs");
    mkdirSync(path.dirname(fakeCli), { recursive: true });
    writeFileSync(fakeCli, "setInterval(() => {}, 10_000);\n", "utf8");
    const args = [fakeCli, "serve", "--adapter-override", "fake"];
    const child = spawn("bun", args, {
      detached: process.platform !== "win32",
      stdio: "ignore",
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== "FACTORY_TEST_TRACKED_PROCESS",
        ),
      ),
    });
    try {
      const result = spawnSync("bash", [LIVE_STACK, "down"], {
        cwd: path.dirname(EVENT_RUNTIME),
        encoding: "utf8",
        env: {
          ...process.env,
          FACTORY_EVENT_HOME: path.join(dir, "home"),
          FACTORY_RUN_DIR: path.join(dir, "run"),
          FACTORY_FAKE_RUNTIME_MAX_AGE_MINUTES: "0",
        },
      });
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        `fake-adapter test runtime pid ${child.pid}`,
      );
      expect(processExists(child.pid)).toBe(true);
    } finally {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
      await waitForExit(child.pid);
    }
  });

  test("event-runtime tests never spawn cli.mjs serve/work without spawnTracked", () => {
    const offenders = [];
    const directSpawn = new RegExp("\\bspawn\\s*\\(", "g");
    for (const file of testFiles(EVENT_RUNTIME)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(directSpawn)) {
        const call = source.slice(match.index, match.index + 800);
        const closesAt = call.indexOf(");");
        const invocation = closesAt >= 0 ? call.slice(0, closesAt) : call;
        if (
          /(?:\bCLI\b|cli\.mjs)/.test(invocation) &&
          /["'](?:serve|work)["']/.test(invocation)
        ) {
          offenders.push(path.relative(EVENT_RUNTIME, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
