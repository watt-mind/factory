/**
 * Browser-launch checks for orchestrator/doctor.mjs (WM-670).
 *
 * The UX critic is a mandatory gate for web PRs, and on this host it was
 * silently a no-op for a day: pi's chrome-devtools extension
 * (@narumitw/pi-chrome-devtools) auto-launches `google-chrome` with a fixed
 * argument list that has no --headless flag, so on a display-less Linux runner
 * Chrome died at startup —
 *
 *   ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc Missing X server or $DISPLAY
 *   ERROR:ui/aura/env.cc The platform failed to initialize.  Exiting.
 *
 * — the extension reported "Auto-launched browser exited before DevTools
 * became available", and every web PR shipped NOT-ASSESSED. The fix points the
 * extension at bin/chrome-headless.sh; these two checks keep that from
 * regressing unnoticed:
 *
 *   browserLaunchCheck    — the wrapper really launches headless, binds a
 *                           DevTools port and serves about:blank (<10s).
 *   piChromeDevtoolsCheck — the extension is pointed at it (browser.executablePath
 *                           in ~/.pi/agent/pi-chrome-devtools.json, or
 *                           PI_CHROME_DEVTOOLS_BROWSER).
 *
 * Kept out of doctor.mjs so doctor.test.mjs can import them without running
 * the whole doctor (which fetches remotes and queries Linear).
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, platform, tmpdir } from "node:os";
import path from "node:path";
import { factoryRoot } from "../lib/factory-root.mjs";

export const CHROME_HEADLESS_WRAPPER = path.join(
  factoryRoot(),
  "bin/chrome-headless.sh",
);
export const PI_CHROME_DEVTOOLS_SETTINGS = "pi-chrome-devtools.json";

const expand = (p) => String(p ?? "").replace(/^~/, homedir());

/**
 * Kill the wrapper, Chrome, and any helper that still holds this profile.
 * SIGKILL on the child alone is not enough on macOS: Chrome forks GPU/helper
 * processes, and a leftover descendant keeps `bun test` from ever exiting.
 * Profiles are mkdtemp'd under `factory-doctor-chrome-`; refuse to pkill
 * without that marker so a bad path cannot sweep unrelated browsers.
 */
function reapBrowserProcess(child, profile) {
  const pid = child?.pid;
  if (pid) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* not a group leader, or already gone */
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (
    typeof profile === "string" &&
    profile.includes("factory-doctor-chrome")
  ) {
    try {
      spawnSync("pkill", ["-9", "-f", "--", `--user-data-dir=${profile}`], {
        stdio: "ignore",
        timeout: 2000,
      });
    } catch {
      /* pkill absent or nothing matched */
    }
  }
}

/**
 * Name the dependency a failed Chrome launch is missing, from its stderr.
 * Returns null when the output has no recognizable cause.
 */
export function browserMissingDependency(stderr, exitCode) {
  const text = String(stderr ?? "");
  const lib = text.match(/error while loading shared libraries: ([^:\s]+)/);
  if (lib)
    return `shared library ${lib[1]} (install the package that provides it, e.g. libnss3 libatk-bridge2.0-0 libgbm1 libasound2)`;
  if (/Missing X server or \$DISPLAY/.test(text))
    return "a display — the browser was launched without --headless (bin/chrome-headless.sh not in the launch path)";
  if (
    /Running as root without --no-sandbox|Failed to move to new namespace|No usable sandbox|setuid sandbox/i.test(
      text,
    )
  )
    return "--no-sandbox (Chrome's own sandbox cannot start on this host)";
  if (/Failed to create shared memory|\/dev\/shm/i.test(text))
    return "--disable-dev-shm-usage (/dev/shm too small)";
  if (
    exitCode === 127 ||
    /no Chromium-family browser found|not found/i.test(text)
  )
    return "a Chromium-family browser (google-chrome / chromium not installed)";
  return null;
}

/**
 * Launch the headless wrapper exactly the way the critic's extension does —
 * dynamic DevTools port, isolated temp profile, about:blank — and wait for
 * Chrome to write DevToolsActivePort. That file appearing IS what "exited
 * before DevTools became available" was missing. Resolves (never throws) to:
 *   { status: "pass", executable, port, ms }
 *   { status: "skip", detail, missing }   — no browser installed at all
 *   { status: "fail", detail, missing }   — launched but died / never bound
 */
export function browserLaunchCheck({
  wrapper = CHROME_HEADLESS_WRAPPER,
  timeoutMs = 8000,
  env = process.env,
} = {}) {
  return new Promise((resolve) => {
    if (!existsSync(wrapper)) {
      resolve({
        status: "fail",
        detail: `${wrapper} missing`,
        missing: "bin/chrome-headless.sh (git pull the factory repo)",
      });
      return;
    }
    const profile = mkdtempSync(path.join(tmpdir(), "factory-doctor-chrome-"));
    const portFile = path.join(profile, "DevToolsActivePort");
    const started = Date.now();
    let stderr = "";
    let settled = false;
    let poll = null;
    let timer = null;
    const child = spawn(
      wrapper,
      [
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      {
        env,
        stdio: ["ignore", "ignore", "pipe"],
        // New process group so SIGKILL cannot miss Chrome helpers, and so we
        // never signal the bun test runner that spawned us.
        detached: process.platform !== "win32",
      },
    );
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(waitForReap);
        try {
          child.stderr?.destroy();
        } catch {
          /* already closed */
        }
        try {
          child.unref?.();
        } catch {
          /* already unref'd */
        }
        // Chrome's helpers hold the profile briefly after the kill; sweep it
        // a moment later, best effort — it lives under tmpdir either way.
        setTimeout(() => {
          try {
            rmSync(profile, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }, 200).unref?.();
        resolve(result);
      };
      // Reap the zombie before resolving so bun test is not left holding a
      // defunct child. Cap the wait: a stuck wait would hang the suite the
      // same way an unbounded Chrome launch does.
      const waitForReap = setTimeout(release, 500);
      child.once("close", release);
      child.once("exit", release);
      reapBrowserProcess(child, profile);
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        release();
      }
    };
    child.on("error", (e) =>
      finish({
        status: "fail",
        detail: `spawn failed: ${e.message}`,
        missing:
          browserMissingDependency(
            e.message,
            e.code === "ENOENT" ? 127 : null,
          ) ?? "an executable bin/chrome-headless.sh",
      }),
    );
    child.on("exit", (code, sig) => {
      const missing = browserMissingDependency(stderr, code);
      if (code === 127 || /no Chromium-family browser found/.test(stderr)) {
        finish({
          status: "skip",
          detail:
            "no Chromium-family browser installed — the UX critic will report NOT-ASSESSED until one is",
          missing,
        });
        return;
      }
      const tail = stderr
        .trim()
        .split("\n")
        .filter((l) => !/dbus|UPower/i.test(l))
        .slice(-2)
        .join(" | ")
        .slice(0, 300);
      finish({
        status: "fail",
        detail: `browser exited (code ${code ?? sig}) before DevTools became available${tail ? `: ${tail}` : ""}`,
        missing,
      });
    });
    poll = setInterval(() => {
      if (!existsSync(portFile)) return;
      let port;
      try {
        port = Number(readFileSync(portFile, "utf8").split(/\r?\n/, 1)[0]);
      } catch {
        return;
      }
      if (!Number.isInteger(port) || port <= 0) return;
      finish({
        status: "pass",
        executable: wrapper,
        port,
        ms: Date.now() - started,
      });
    }, 100);
    timer = setTimeout(
      () =>
        finish({
          status: "fail",
          detail: `DevToolsActivePort not written within ${timeoutMs}ms`,
          missing: browserMissingDependency(stderr, null),
        }),
      timeoutMs,
    );
  });
}

/**
 * Is pi's chrome-devtools extension pointed at the headless wrapper? Reads
 * only the inputs it is given, so tests can feed it a temp agent dir.
 *   { status: "pass" | "fail" | "skip", detail, fix }
 */
export function piChromeDevtoolsCheck({
  agentDir = process.env.PI_CODING_AGENT_DIR
    ? expand(process.env.PI_CODING_AGENT_DIR)
    : path.join(homedir(), ".pi", "agent"),
  wrapper = CHROME_HEADLESS_WRAPPER,
  env = process.env,
  os = platform(),
} = {}) {
  const settingsPath = path.join(agentDir, PI_CHROME_DEVTOOLS_SETTINGS);
  const fix = `write ${settingsPath}: {"browser":{"executablePath":"${wrapper}"}}   (or export PI_CHROME_DEVTOOLS_BROWSER=${wrapper})`;
  const fromEnv = env.PI_CHROME_DEVTOOLS_BROWSER || null;
  let fromFile = null;
  let parseError = null;
  if (existsSync(settingsPath)) {
    try {
      const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
      fromFile = doc?.browser?.executablePath ?? null;
    } catch (e) {
      parseError = e.message;
    }
  }
  const source = fromEnv
    ? "PI_CHROME_DEVTOOLS_BROWSER"
    : "browser.executablePath";
  const executable = fromEnv || fromFile;
  if (parseError && !fromEnv)
    return {
      status: "fail",
      detail: `${settingsPath} is not valid JSON: ${parseError}`,
      fix,
    };
  if (executable) {
    if (!existsSync(executable))
      return {
        status: "fail",
        detail: `${source} → ${executable} does not exist`,
        fix,
      };
    if ((statSync(executable).mode & 0o111) === 0)
      return {
        status: "fail",
        detail: `${executable} is not executable`,
        fix: `chmod +x ${executable}`,
      };
    const isWrapper = path.resolve(executable) === path.resolve(wrapper);
    return {
      status: "pass",
      detail: `${source} → ${executable}${isWrapper ? "" : " (not bin/chrome-headless.sh — make sure it launches headless)"}`,
    };
  }
  // Unconfigured: the extension auto-launches `google-chrome` headed, which
  // only works where a display exists.
  if (os === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY)
    return {
      status: "fail",
      detail: `unconfigured and no DISPLAY — the critic's Chrome exits with "Missing X server or $DISPLAY"`,
      fix,
    };
  return {
    status: "skip",
    detail:
      "unconfigured; a display is available so the extension's headed launch works — set browser.executablePath to run headless anyway",
    fix,
  };
}
