/**
 * bun test orchestrator/doctor.test.mjs
 *
 * WM-670: the UX critic's browser gate was silently dead for a day because
 * pi's chrome-devtools extension launched Chrome headed on a display-less
 * Linux runner. These tests pin the two doctor checks that make that visible:
 * the headless wrapper really binds a DevTools port, and the extension is
 * pointed at it. Fakes stand in for Chrome wherever the outcome must be
 * deterministic; the one real launch is skipped when no browser is installed
 * or when headless Chrome does not bind a DevTools port in time (WM-861:
 * unbounded spawnSync of the real macOS app bundle hung `bun test` forever).
 */
import { test, expect, describe } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  browserLaunchCheck,
  browserMissingDependency,
  piChromeDevtoolsCheck,
  CHROME_HEADLESS_WRAPPER,
} from "./doctor-browser.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
// The wrapper from THIS checkout, not the installed factory root — a worktree
// must test its own copy of the script.
const WRAPPER = path.join(HERE, "..", "bin", "chrome-headless.sh");

const scratch = () => mkdtempSync(path.join(tmpdir(), "doctor-test-"));
const fakeChrome = (dir, body) => {
  const p = path.join(dir, "chrome");
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

describe("bin/chrome-headless.sh", () => {
  test("is shipped and executable", () => {
    expect(existsSync(WRAPPER)).toBe(true);
    expect(CHROME_HEADLESS_WRAPPER.endsWith("bin/chrome-headless.sh")).toBe(
      true,
    );
  });

  test("passes every caller argument through after the headless/sandbox flags", () => {
    const dir = scratch();
    const argsFile = path.join(dir, "args");
    const chrome = fakeChrome(dir, `printf '%s\\n' "$@" > ${argsFile}`);
    const r = Bun.spawnSync(
      [WRAPPER, "--remote-debugging-port=0", "about:blank"],
      {
        env: { ...process.env, CHROME_BIN: chrome },
        timeout: 5_000,
      },
    );
    expect(r.exitCode).toBe(0);
    const args = readFileSync(argsFile, "utf8").trim().split("\n");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--disable-dev-shm-usage");
    // Caller args come last, so the extension's port/profile/URL survive.
    expect(args.slice(-2)).toEqual([
      "--remote-debugging-port=0",
      "about:blank",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("exits 127 with a named cause when no browser exists", () => {
    // CHROME_BIN="" disables PATH *and* /Applications lookup. Starving PATH
    // alone is not enough on macOS: resolve_chrome still finds the app bundle
    // and exec's Chrome, and spawnSync with no timeout hangs the whole suite.
    const r = Bun.spawnSync(["/bin/bash", WRAPPER, "about:blank"], {
      env: { HOME: process.env.HOME, PATH: "/nonexistent", CHROME_BIN: "" },
      stderr: "pipe",
      timeout: 5_000,
    });
    expect(r.exitCode).toBe(127);
    expect(new TextDecoder().decode(r.stderr)).toMatch(
      /no Chromium-family browser found/,
    );
  });

  test("empty CHROME_BIN skips discovery even when a browser is on PATH", () => {
    const dir = scratch();
    fakeChrome(dir, `exit 0`);
    const r = Bun.spawnSync(["/bin/bash", WRAPPER, "about:blank"], {
      env: {
        HOME: process.env.HOME,
        PATH: `${dir}:/usr/bin:/bin`,
        CHROME_BIN: "",
      },
      stderr: "pipe",
      timeout: 5_000,
    });
    expect(r.exitCode).toBe(127);
    expect(new TextDecoder().decode(r.stderr)).toMatch(
      /no Chromium-family browser found/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("a hanging CHROME_BIN cannot block spawnSync indefinitely", () => {
    const dir = scratch();
    const chrome = fakeChrome(dir, `exec sleep 60`);
    const started = Date.now();
    const r = Bun.spawnSync([WRAPPER, "about:blank"], {
      env: { ...process.env, CHROME_BIN: chrome },
      timeout: 800,
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(r.success).toBe(false);
    expect(r.exitCode === 0).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("browserMissingDependency", () => {
  test("names a missing shared library", () => {
    expect(
      browserMissingDependency(
        "chrome: error while loading shared libraries: libnss3.so: cannot open shared object file",
        127,
      ),
    ).toMatch(/^shared library libnss3\.so/);
  });
  test("names the missing display (headed launch on a headless box)", () => {
    expect(
      browserMissingDependency(
        "[1:1:ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:257] Missing X server or $DISPLAY\n[1:1:ERROR:ui/aura/env.cc:246] The platform failed to initialize.  Exiting.",
        1,
      ),
    ).toMatch(/display.*--headless/);
  });
  test("names the sandbox flag", () => {
    expect(
      browserMissingDependency(
        "Failed to move to new namespace: PID namespaces supported",
        1,
      ),
    ).toMatch(/--no-sandbox/);
  });
  test("names a missing browser on exit 127", () => {
    expect(browserMissingDependency("", 127)).toMatch(
      /Chromium-family browser/,
    );
  });
  test("returns null for noise", () => {
    expect(
      browserMissingDependency("Failed to connect to the bus", 0),
    ).toBeNull();
  });
});

describe("browserLaunchCheck", () => {
  test("fails, naming the display, when the launched browser dies like the critic's did", async () => {
    const dir = scratch();
    const chrome = fakeChrome(
      dir,
      `echo '[1:1:ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:257] Missing X server or $DISPLAY' >&2; echo '[1:1:ERROR:ui/aura/env.cc:246] The platform failed to initialize.  Exiting.' >&2; exit 1`,
    );
    const r = await browserLaunchCheck({
      wrapper: WRAPPER,
      timeoutMs: 5000,
      env: { ...process.env, CHROME_BIN: chrome },
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/before DevTools became available/);
    expect(r.missing).toMatch(/display/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails, naming the library, when Chrome cannot load a shared object", async () => {
    const dir = scratch();
    const chrome = fakeChrome(
      dir,
      `echo 'chrome: error while loading shared libraries: libgbm.so.1: cannot open shared object file: No such file or directory' >&2; exit 127`,
    );
    const r = await browserLaunchCheck({
      wrapper: WRAPPER,
      timeoutMs: 5000,
      env: { ...process.env, CHROME_BIN: chrome },
    });
    // exit 127 from a *found* binary that lacks a library is still a fail with the lib named
    expect(r.missing).toMatch(/libgbm\.so\.1/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("skips cleanly when no browser is installed", async () => {
    const r = await browserLaunchCheck({
      wrapper: WRAPPER,
      timeoutMs: 5000,
      env: {
        HOME: process.env.HOME,
        PATH: "/usr/bin:/bin",
        CHROME_BIN: path.join(scratch(), "missing-chrome"),
      },
    });
    expect(r.status).toBe("skip");
    expect(r.missing).toMatch(/Chromium-family browser/);
  });

  test("passes when the browser writes DevToolsActivePort", async () => {
    // A fake Chrome that behaves like the real one: parses --user-data-dir,
    // writes the port file, then idles until killed.
    const dir = scratch();
    const chrome = fakeChrome(
      dir,
      `for a in "$@"; do case "$a" in --user-data-dir=*) d="\${a#--user-data-dir=}";; esac; done
printf '41234\\n/devtools/browser/x\\n' > "$d/DevToolsActivePort"; exec sleep 30`,
    );
    const r = await browserLaunchCheck({
      wrapper: WRAPPER,
      timeoutMs: 5000,
      env: { ...process.env, CHROME_BIN: chrome },
    });
    expect(r.status).toBe("pass");
    expect(r.port).toBe(41234);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails when the browser never binds within the timeout", async () => {
    const dir = scratch();
    const pidFile = path.join(dir, "pid");
    const chrome = fakeChrome(
      dir,
      `echo $$ > "${pidFile}"
exec sleep 30`,
    );
    const r = await browserLaunchCheck({
      wrapper: WRAPPER,
      timeoutMs: 800,
      env: { ...process.env, CHROME_BIN: chrome },
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/not written within 800ms/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    let alive;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      alive = e?.code === "EPERM";
    }
    expect(alive).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails when the wrapper itself is missing", async () => {
    const r = await browserLaunchCheck({
      wrapper: "/nonexistent/chrome-headless.sh",
    });
    expect(r.status).toBe("fail");
    expect(r.missing).toMatch(/chrome-headless\.sh/);
  });

  test("the real browser, when installed, binds a DevTools port headless in under 10s", async () => {
    const started = Date.now();
    const r = await browserLaunchCheck({ wrapper: WRAPPER, timeoutMs: 8000 });
    // No browser, or one that does not become ready in time (macOS Chrome
    // hanging on a permission prompt / GPU process): skip rather than fail
    // or block the runner. Deterministic launch behaviour is pinned above
    // with fake binaries.
    if (r.status !== "pass") return;
    expect(r.port).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});

describe("piChromeDevtoolsCheck", () => {
  const wrapper = WRAPPER;
  test("fails on display-less Linux when the extension is unconfigured, with the exact fix", () => {
    const agentDir = scratch();
    const r = piChromeDevtoolsCheck({
      agentDir,
      wrapper,
      env: {},
      os: "linux",
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/Missing X server/);
    expect(r.fix).toContain(path.join(agentDir, "pi-chrome-devtools.json"));
    expect(r.fix).toContain(`"executablePath":"${wrapper}"`);
  });
  test("skips (warns) when unconfigured but a display exists / not Linux", () => {
    const agentDir = scratch();
    expect(
      piChromeDevtoolsCheck({
        agentDir,
        wrapper,
        env: { DISPLAY: ":0" },
        os: "linux",
      }).status,
    ).toBe("skip");
    expect(
      piChromeDevtoolsCheck({ agentDir, wrapper, env: {}, os: "darwin" })
        .status,
    ).toBe("skip");
  });
  test("passes when browser.executablePath points at the wrapper", () => {
    const agentDir = scratch();
    writeFileSync(
      path.join(agentDir, "pi-chrome-devtools.json"),
      JSON.stringify({ browser: { executablePath: wrapper } }),
    );
    const r = piChromeDevtoolsCheck({
      agentDir,
      wrapper,
      env: {},
      os: "linux",
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("browser.executablePath");
  });
  test("passes via PI_CHROME_DEVTOOLS_BROWSER too", () => {
    const r = piChromeDevtoolsCheck({
      agentDir: scratch(),
      wrapper,
      env: { PI_CHROME_DEVTOOLS_BROWSER: wrapper },
      os: "linux",
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("PI_CHROME_DEVTOOLS_BROWSER");
  });
  test("fails when the configured executable does not exist or is not executable", () => {
    const agentDir = scratch();
    writeFileSync(
      path.join(agentDir, "pi-chrome-devtools.json"),
      JSON.stringify({ browser: { executablePath: "/nonexistent/chrome" } }),
    );
    expect(
      piChromeDevtoolsCheck({ agentDir, wrapper, env: {}, os: "linux" }).status,
    ).toBe("fail");
    const notExec = path.join(agentDir, "chrome");
    writeFileSync(notExec, "");
    writeFileSync(
      path.join(agentDir, "pi-chrome-devtools.json"),
      JSON.stringify({ browser: { executablePath: notExec } }),
    );
    const r = piChromeDevtoolsCheck({
      agentDir,
      wrapper,
      env: {},
      os: "linux",
    });
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/chmod \+x/);
  });
  test("fails on an unparsable settings file", () => {
    const agentDir = scratch();
    writeFileSync(path.join(agentDir, "pi-chrome-devtools.json"), "{ not json");
    expect(
      piChromeDevtoolsCheck({ agentDir, wrapper, env: {}, os: "linux" }).status,
    ).toBe("fail");
  });
});

describe("Linear budget line (WM-878)", () => {
  test("formats remaining/limit and UTC reset clock, and warns below 300", async () => {
    const {
      formatLinearBudgetLine,
      linearBudgetStatus,
      parseRateLimitHeaders,
      LINEAR_BUDGET_WARN_REMAINING,
    } = await import("../tools/linear.mjs");
    expect(formatLinearBudgetLine(null)).toBe(
      "Linear budget: unknown (no recent API call)",
    );
    expect(
      formatLinearBudgetLine({
        remaining: 1842,
        limit: 2500,
        resetAt: "2026-08-19T15:07:00.000Z",
      }),
    ).toBe("Linear budget: 1842/2500 remaining, resets 15:07");
    expect(
      linearBudgetStatus({ remaining: LINEAR_BUDGET_WARN_REMAINING }),
    ).toBe("pass");
    expect(
      linearBudgetStatus({ remaining: LINEAR_BUDGET_WARN_REMAINING - 1 }),
    ).toBe("warn");
    const headers = new Headers({
      "X-RateLimit-Requests-Remaining": "12",
      "X-RateLimit-Requests-Limit": "2500",
      "X-RateLimit-Requests-Reset": "1787150400",
    });
    const parsed = parseRateLimitHeaders(headers);
    expect(parsed.remaining).toBe(12);
    expect(parsed.limit).toBe(2500);
    expect(parsed.resetAt).toBe(new Date(1787150400 * 1000).toISOString());
  });
});
