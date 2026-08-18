import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_PATH,
  eventRuntimePlist,
  eventWorkerRange,
  installPlists,
  launchdPath,
  main,
  materialize,
  plist,
  renderEventRuntimePlists,
} from "./gen.mjs";
import { ROOT } from "../lib/schedule.mjs";

const defaults = {
  label_prefix: "com.wattmind",
  log_dir: "~/Library/Logs",
  run_at_load: false,
};
const job = {
  name: "triage",
  every: "5m",
  command: "bun orchestrator/run.mjs --only triage",
};

test("plist includes EnvironmentVariables with a launchd-safe PATH", () => {
  const home = "/Users/factory";
  const environmentPath = launchdPath("/custom/bin:/usr/bin", home);
  const rendered = plist(job, defaults, environmentPath);

  expect(environmentPath).toBe(
    "/custom/bin:/usr/bin:/Users/factory/.bun/bin:/Users/factory/.local/bin",
  );
  expect(rendered).toContain(`    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${environmentPath}</string>
    </dict>`);
  expect((rendered.match(/<key>EnvironmentVariables<\/key>/g) ?? []).length).toBe(1);
  expect((rendered.match(/<key>PATH<\/key>/g) ?? []).length).toBe(1);
});

test("plist does not leak the renderer worktree into ProgramArguments", () => {
  const rendered = plist(job, defaults, "/usr/bin");

  expect(rendered).toContain(
    '<string>cd "${FACTORY_ROOT:-$HOME/Develop/factory}" &amp;&amp; bun orchestrator/run.mjs --only triage</string>',
  );
  expect(rendered).not.toContain(ROOT);
});

test("launchdPath uses the macOS toolchain fallback when PATH is missing", () => {
  expect(launchdPath("", "/Users/factory")).toBe(
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/factory/.bun/bin:/Users/factory/.local/bin",
  );
});

test("rendering ignores the renderer's PATH and home: sentinel never leaks", () => {
  const sentinel = "/sentinel/only/bin";
  const prevPath = process.env.PATH;
  process.env.PATH = `${sentinel}:${prevPath}`;
  try {
    const rendered = plist(job, defaults);
    expect(rendered).not.toContain(sentinel);
    expect(rendered).not.toContain(homedir());
    expect(rendered).toContain(`<string>${DEFAULT_PATH}:~/.bun/bin:~/.local/bin</string>`);
    expect(rendered).toContain("<string>~/Library/Logs/triage.out.log</string>");
    expect(rendered).toContain("<string>~/Library/Logs/triage.err.log</string>");
    // Same bytes regardless of the environment the renderer runs in.
    process.env.PATH = "/usr/bin";
    expect(plist(job, defaults)).toBe(rendered);
  } finally {
    process.env.PATH = prevPath;
  }
});

test("materialize expands ~/ only where launchd would need an absolute path", () => {
  const rendered = plist(job, defaults);
  const installed = materialize(rendered, "/Users/factory");
  expect(installed).toContain(`<string>${DEFAULT_PATH}:/Users/factory/.bun/bin:/Users/factory/.local/bin</string>`);
  expect(installed).toContain("<string>/Users/factory/Library/Logs/triage.out.log</string>");
  expect(installed).not.toContain("~/");
  // The runtime deploy root is still resolved by the job's shell, not the installer.
  expect(installed).toContain('cd "${FACTORY_ROOT:-$HOME/Develop/factory}"');
});

test("installPlists creates a missing LaunchAgents directory before copying", () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-launchd-"));
  const outDir = path.join(root, "rendered");
  const agentsDir = path.join(root, "home", "Library", "LaunchAgents");
  const label = `${defaults.label_prefix}.${job.name}`;
  const source = path.join(outDir, `${label}.plist`);
  const calls = [];

  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(source, "<plist><string>~/Library/Logs/x.log</string></plist>\n");
    expect(existsSync(agentsDir)).toBe(false);

    installPlists([job], defaults, {
      outDir,
      agentsDir,
      uid: 501,
      home: path.join(root, "home"),
      run(command, args) {
        calls.push([command, args]);
      },
    });

    expect(readFileSync(path.join(agentsDir, `${label}.plist`), "utf8")).toBe(
      `<plist><string>${path.join(root, "home")}/Library/Logs/x.log</string></plist>\n`,
    );
    expect(existsSync(path.join(root, "home", "Library", "Logs"))).toBe(true);
    expect(calls).toEqual([
      ["launchctl", ["bootout", `gui/501/${label}`]],
      ["launchctl", ["bootstrap", "gui/501", path.join(agentsDir, `${label}.plist`)]],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installPlists prefers rendered label/file over the prefix concatenation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-launchd-"));
  const outDir = path.join(root, "rendered");
  const agentsDir = path.join(root, "home", "Library", "LaunchAgents");
  const label = "com.other.custom-label";
  const source = path.join(outDir, `${label}.plist`);
  const calls = [];

  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(source, "<plist>custom</plist>\n");

    installPlists([{ name: "whatever", label, file: source }], defaults, {
      outDir: path.join(root, "unused"),
      agentsDir,
      uid: 501,
      home: path.join(root, "home"),
      run(command, args) {
        calls.push([command, args]);
      },
    });

    expect(readFileSync(path.join(agentsDir, `${label}.plist`), "utf8")).toBe("<plist>custom</plist>\n");
    expect(calls).toEqual([
      ["launchctl", ["bootout", `gui/501/${label}`]],
      ["launchctl", ["bootstrap", "gui/501", path.join(agentsDir, `${label}.plist`)]],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--install never bootstraps the event daemons (scheduled jobs only)", () => {
  const installed = [];
  const log = console.log;
  console.log = () => {};
  try {
    main({ install: true, installer(jobs) { installed.push(...jobs); } });
  } finally {
    console.log = log;
  }
  expect(installed.some((j) => String(j.name).startsWith("factory.event-"))).toBe(false);
  expect(installed.some((j) => String(j.label ?? "").includes(".factory.event-"))).toBe(false);
});

test("event-runtime plists are portable, secret-free, persistent user agents", () => {
  const serve = eventRuntimePlist("serve");
  const work = eventRuntimePlist("work", { workers: "2:4" });

  for (const rendered of [serve, work]) {
    expect(rendered).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(rendered).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(rendered).toContain("<key>LimitLoadToSessionType</key>\n    <string>Aqua</string>");
    expect(rendered).not.toContain(ROOT);
    expect(rendered).not.toContain("FACTORY_EVENT_SECRET</key>");
  }
  expect(serve).toContain("<string>com.wattmind.factory.event-serve</string>");
  expect(serve).toContain('bin/event-runtime-daemon" serve</string>');
  expect(work).toContain("<string>com.wattmind.factory.event-work</string>");
  expect(work).toContain('bin/event-runtime-daemon" work 2:4</string>');
});

test("event worker range accepts fixed and bounded pools and rejects unsafe values", () => {
  expect(eventWorkerRange("2")).toBe("2:2");
  expect(eventWorkerRange("1:2")).toBe("1:2");
  expect(() => eventWorkerRange("0:2")).toThrow("1 <= min <= max <= 32");
  expect(() => eventWorkerRange("3:2")).toThrow("1 <= min <= max <= 32");
  expect(() => eventWorkerRange("1:33")).toThrow("1 <= min <= max <= 32");
  expect(() => eventWorkerRange("many")).toThrow("must be N or min:max");
});

test("event-runtime renderer writes the two committed launchd definitions", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "factory-event-launchd-"));
  try {
    const rendered = renderEventRuntimePlists({
      outDir,
      workers: "2",
      environmentPath: "/usr/bin:/bin",
    });
    expect(rendered.map((item) => path.basename(item.file))).toEqual([
      "com.wattmind.factory.event-serve.plist",
      "com.wattmind.factory.event-work.plist",
    ]);
    expect(readFileSync(rendered[0].file, "utf8")).toContain('event-runtime-daemon" serve');
    expect(readFileSync(rendered[1].file, "utf8")).toContain('event-runtime-daemon" work 2:2');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("committed event-runtime plists match the generator default", () => {
  for (const role of ["serve", "work"]) {
    const file = path.join(
      ROOT,
      "deploy",
      "launchd",
      `com.wattmind.factory.event-${role}.plist`,
    );
    expect(readFileSync(file, "utf8")).toBe(eventRuntimePlist(role));
  }
});

function daemonFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-event-daemon-"));
  const home = path.join(root, "home");
  const checkout = path.join(root, "factory");
  const calls = path.join(root, "bun-calls");
  const fakeBun = path.join(home, ".bun", "bin", "bun");
  mkdirSync(path.dirname(fakeBun), { recursive: true });
  mkdirSync(path.join(checkout, "event-runtime"), { recursive: true });
  writeFileSync(fakeBun, '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$CALLS_FILE"\n');
  chmodSync(fakeBun, 0o755);
  return { root, home, checkout, calls };
}

function daemonEnv(fixture, port) {
  return {
    ...process.env,
    HOME: fixture.home,
    FACTORY_ROOT: fixture.checkout,
    FACTORY_EVENT_PORT: String(port),
    FACTORY_EVENT_LOG_DIR: path.join(fixture.root, "logs"),
    FACTORY_EVENT_HEALTH_RETRIES: "2",
    FACTORY_EVENT_HEALTH_RETRY_DELAY: "0",
    FACTORY_EVENT_HEALTH_RETRY_MAX_TIME: "2",
    FACTORY_EVENT_HEALTH_REQUEST_TIMEOUT: "1",
    CALLS_FILE: fixture.calls,
  };
}

test("daemon preflight failures land in the err log, not launchd's dropped stderr", async () => {
  const fixture = daemonFixture();
  try {
    rmSync(path.join(fixture.checkout, "event-runtime"), { recursive: true, force: true });
    const child = Bun.spawn([path.join(ROOT, "bin", "event-runtime-daemon"), "serve"], {
      env: daemonEnv(fixture, 1),
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(66);
    expect(readFileSync(path.join(fixture.root, "logs", "factory-event-serve.err.log"), "utf8"))
      .toContain("event-runtime checkout not found");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("daemon worker never invokes supervise when health is unavailable", async () => {
  const fixture = daemonFixture();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop(true);
  try {
    const child = Bun.spawn([path.join(ROOT, "bin", "event-runtime-daemon"), "work", "2:4"], {
      env: daemonEnv(fixture, port),
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(75);
    expect(existsSync(fixture.calls)).toBe(false);
    expect(readFileSync(path.join(fixture.root, "logs", "factory-event-work.err.log"), "utf8"))
      .toContain("control API did not become healthy");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("daemon worker waits for healthy serve, then forwards the configured range", async () => {
  const fixture = daemonFixture();
  let requests = 0;
  let superviseStartedBeforeHealth = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests += 1;
      superviseStartedBeforeHealth ||= existsSync(fixture.calls);
      return requests === 1
        ? new Response("starting", { status: 503 })
        : Response.json({ ok: true });
    },
  });
  try {
    const child = Bun.spawn([path.join(ROOT, "bin", "event-runtime-daemon"), "work", "2:4"], {
      env: daemonEnv(fixture, server.port),
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(0);
    expect(requests).toBeGreaterThanOrEqual(2);
    expect(superviseStartedBeforeHealth).toBe(false);
    expect(readFileSync(fixture.calls, "utf8").trim()).toBe(
      "event-runtime/cli.mjs supervise --workers 2:4",
    );
  } finally {
    server.stop(true);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
