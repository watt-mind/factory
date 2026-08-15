/**
 * Real-VM invariant tests (WM-185).
 *
 * These boot an actual Gondolin microVM and are the only proof that the
 * sandbox does what the RFC claims. They assert the three properties that
 * matter, each of which would be a security failure if it regressed:
 *
 *   1. the workspace really is the host directory (writes cross the boundary)
 *   2. egress is default-deny (a non-allowlisted host does not get reached)
 *   3. the guest never holds a real credential, only a placeholder
 *
 * They SKIP rather than fail where the hypervisor is unavailable (CI runners
 * without /dev/kvm, a laptop without QEMU) — a skip says "unverified here",
 * while a failure would say "broken", and only one of those is true.
 *
 * First boot on a machine loads ~200MB of guest assets, so the timeout is
 * generous; warm boots measured 51-93ms on macOS arm64.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KILL_GRACE_MS, preflight, runInSandbox } from "./gondolin.mjs";

const report = preflight();
const itVM = report.available ? test : test.skip;
if (!report.available) {
  console.warn(`[WM-185] skipping real-VM invariant tests — ${report.reason}`);
}

const VM_TIMEOUT_MS = 180_000;
const workspace = () => mkdtempSync(path.join(os.tmpdir(), "evrt-sandbox-"));

describe("gondolin sandbox invariants", () => {
  itVM(
    "the guest workspace is the host directory, in both directions",
    async () => {
      const dir = workspace();
      writeFileSync(path.join(dir, "from-host.txt"), "host wrote this\n");

      let stdout = "";
      const result = await runInSandbox({
        policy: { provider: "gondolin" },
        command: "cat /workspace/from-host.txt && echo 'guest wrote this' > /workspace/from-guest.txt",
        shell: true,
        workspaceDir: dir,
        timeoutMs: 60_000,
        onStdout: (chunk) => {
          stdout += chunk;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(stdout).toContain("host wrote this");
      expect(readFileSync(path.join(dir, "from-guest.txt"), "utf8")).toBe("guest wrote this\n");
    },
    VM_TIMEOUT_MS,
  );

  itVM(
    "a non-allowlisted host is refused, and an allowlisted one is not",
    async () => {
      const dir = workspace();
      let blocked = "";
      const blockedRun = await runInSandbox({
        policy: { provider: "gondolin", allowedHosts: ["api.github.com"] },
        // -m keeps a hypothetical hang from eating the whole test timeout;
        // observed behaviour is a fast 403 from the host proxy.
        command: "curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.com/ || echo CURL_FAILED",
        shell: true,
        workspaceDir: dir,
        timeoutMs: 60_000,
        onStdout: (chunk) => {
          blocked += chunk;
        },
      });
      expect(blockedRun.exitCode).toBe(0);
      // Either the proxy refuses it (403) or the connection never completes —
      // what must never appear is a 200 from a host nobody allowed.
      expect(blocked).not.toContain("200");
      expect(blocked === "" || /403|CURL_FAILED|000/.test(blocked)).toBe(true);

      let allowed = "";
      const allowedRun = await runInSandbox({
        policy: { provider: "gondolin", allowedHosts: ["example.com"] },
        command: "curl -sS -m 30 -o /dev/null -w '%{http_code}' https://example.com/",
        shell: true,
        workspaceDir: dir,
        timeoutMs: 60_000,
        onStdout: (chunk) => {
          allowed += chunk;
        },
      });
      expect(allowedRun.exitCode).toBe(0);
      expect(allowed).toContain("200");
    },
    VM_TIMEOUT_MS,
  );

  itVM(
    "the guest holds a placeholder, never the real secret",
    async () => {
      const dir = workspace();
      const REAL = "lin_api_wm185_must_never_reach_the_guest";
      let stdout = "";

      const result = await runInSandbox({
        policy: {
          provider: "gondolin",
          allowedHosts: ["api.linear.app"],
          secrets: { LINEAR_API_KEY: { hosts: ["api.linear.app"], env: "WM185_TEST_SECRET" } },
        },
        // Read it from the environment AND from the raw process environ, so a
        // future SDK change that leaks the value anywhere in the guest fails here.
        command: 'printenv LINEAR_API_KEY; tr "\\0" "\\n" < /proc/self/environ',
        shell: true,
        workspaceDir: dir,
        timeoutMs: 60_000,
        hostEnv: { ...process.env, WM185_TEST_SECRET: REAL },
        onStdout: (chunk) => {
          stdout += chunk;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(stdout).not.toContain(REAL);
      expect(stdout).toContain("GONDOLIN_SECRET_");
    },
    VM_TIMEOUT_MS,
  );

  itVM(
    "a guest command that overruns its timeout is aborted in the guest, not just killed from outside",
    async () => {
      const dir = workspace();
      const started = Date.now();
      const result = await runInSandbox({
        policy: { provider: "gondolin" },
        command: "sleep 60",
        shell: true,
        workspaceDir: dir,
        timeoutMs: 5_000,
      });
      const elapsed = Date.now() - started;

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
      // Two mechanisms can produce timedOut: the runner aborting the guest
      // command at timeoutMs, and the parent's backstop killing the runner at
      // timeoutMs + KILL_GRACE_MS. Asserting the deadline distinguishes them —
      // without it, disabling the inner abort still passes (observed), and the
      // test would be certifying a fallback it did not mean to test.
      expect(elapsed).toBeLessThan(5_000 + KILL_GRACE_MS);
    },
    VM_TIMEOUT_MS,
  );
});
