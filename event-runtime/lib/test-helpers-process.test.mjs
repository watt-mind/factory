import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

const HELPER_URL = new URL("./test-helpers-process.mjs", import.meta.url).href;
const HELPER = JSON.stringify(HELPER_URL);

// Every scenario runs in its own detached bun process so the child is a group
// leader (pgid === pid) and so stubbing getpgid/PATH cannot leak into the suite.
// Async spawn, not spawnSync: Bun 1.3.x (the CI pin) silently ignores
// `detached` on spawnSync, leaving the child in the runner's group — inside the
// handoff sandbox's PID namespace that group is then invisible (ps reports
// pgid 0), and outside it a scenario could signal the real runner (WM-1137).
function runIsolated(script) {
  return new Promise((resolve) => {
    const child = spawn("bun", ["-e", script], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group already exited between the timeout firing and the kill.
      }
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr, error });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

const BREAK_PS = `process.env.PATH = "/definitely-missing";`;
const HIDE_GETPGID = `process.getpgid = undefined;`;

describe("tracked test process safety (WM-1982)", () => {
  test("refuses the runner process group resolved through ps", async () => {
    // Bun does not implement process.getpgid, so this is the production path.
    // Asserted from a nested, non-detached grandchild so that its own PID
    // differs from the group's PGID: only the ps resolver can refuse it, not
    // the `entry.pid === process.pid` identity guard.
    const inner = `
      import { spawnSync } from "node:child_process";
      const { trackProcess } = await import(${HELPER});
      const lookup = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
        encoding: "utf8",
      });
      const pgid = Number(lookup.stdout?.trim());
      if (lookup.status !== 0 || !Number.isInteger(pgid) || pgid <= 0) {
        throw new Error("could not resolve isolated runner process group");
      }
      if (pgid === process.pid) {
        throw new Error("nested runner unexpectedly leads its own group");
      }
      try {
        trackProcess(pgid, { group: true });
      } catch (error) {
        if (error.message.includes("refusing to track the test runner process group " + pgid)) {
          process.exit(0);
        }
        throw error;
      }
      throw new Error("registered the isolated runner process group");
    `;
    const result = await runIsolated(`
      import { spawnSync } from "node:child_process";
      const nested = spawnSync("bun", ["-e", ${JSON.stringify(inner)}], {
        encoding: "utf8",
      });
      if (nested.stderr) process.stderr.write(nested.stderr);
      process.exit(nested.status === 0 ? 0 : 1);
    `);

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).not.toContain("registered the isolated runner");
  });

  test("prefers getpgid over ps when the runtime provides it", async () => {
    // ps is made unusable, so only the getpgid branch can supply the PGID.
    const result = await runIsolated(`
      const { trackProcess } = await import(${HELPER});
      const fakePgid = 424242;
      process.getpgid = () => fakePgid;
      ${BREAK_PS}
      try {
        trackProcess(fakePgid, { group: true });
      } catch (error) {
        if (error.message.includes("refusing to track the test runner process group " + fakePgid)) {
          process.exit(0);
        }
        throw error;
      }
      throw new Error("getpgid resolver did not refuse the runner process group");
    `);

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).not.toContain("did not refuse");
  });

  test("tracks normally when neither getpgid nor ps can resolve the runner group", async () => {
    const result = await runIsolated(`
      import { spawn } from "node:child_process";
      const { trackProcess, cleanupTrackedProcesses } = await import(${HELPER});
      const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
      child.unref();
      ${HIDE_GETPGID}
      ${BREAK_PS}
      const entry = trackProcess(child.pid, { group: true });
      if (entry.pid !== child.pid) throw new Error("tracked the wrong pid");
      await cleanupTrackedProcesses({ graceMs: 0 });
      process.exit(0);
    `);

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).not.toContain(
      "could not resolve test runner process group",
    );
    expect(result.stderr).not.toContain("refusing to track");
  });

  test("refuses the runner PID itself when no resolver is available", async () => {
    const result = await runIsolated(`
      const { trackProcess } = await import(${HELPER});
      ${HIDE_GETPGID}
      ${BREAK_PS}
      try {
        trackProcess(process.pid);
      } catch (error) {
        if (error.message.includes("refusing to track the test runner process group")) {
          process.exit(0);
        }
        throw error;
      }
      throw new Error("registered the isolated runner PID");
    `);

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).not.toContain("registered the isolated runner PID");
  });

  test("trackProcessGroupsMatching skips rows carrying the runner's own group", async () => {
    // The unique token appears only in this child's own `ps` command line, so
    // the scanner is guaranteed to see a row whose PGID is the runner's.
    const token = `wm1982-scan-${process.pid}-${Date.now()}`;
    const result = await runIsolated(`
      const marker = ${JSON.stringify(token)};
      const { trackProcessGroupsMatching, cleanupTrackedProcesses } = await import(${HELPER});
      trackProcessGroupsMatching(marker);
      // If the runner's own group had been tracked this would SIGTERM us.
      await cleanupTrackedProcesses({ graceMs: 0 });
      console.log("survived");
      process.exit(0);
    `);

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("survived");
    expect(result.stderr).not.toContain("refusing to track");
  });

  test("trackMarkedFakeRuntimeGroups skips a non-detached marked fixture", async () => {
    const result = await runIsolated(`
      import { spawn } from "node:child_process";
      const marker = "wm1982-marked-" + process.pid;
      const { trackMarkedFakeRuntimeGroups, cleanupTrackedProcesses } = await import(${HELPER});
      // Shares this process's group (no detached:true), and its command line
      // matches the fake-runtime scanner's shape plus the owner marker.
      const child = spawn("/bin/sleep", ["30"], {
        argv0: "bun event-runtime/cli.mjs serve --adapter-override fake factory-test-" + marker,
        stdio: "ignore",
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      trackMarkedFakeRuntimeGroups(marker);
      await cleanupTrackedProcesses({ graceMs: 0 });
      console.log("survived");
      try { process.kill(child.pid, "SIGKILL"); } catch {}
      process.exit(0);
    `);

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("survived");
    expect(result.stderr).not.toContain("refusing to track");
  });
});
