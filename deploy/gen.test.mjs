import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installPlists, launchdPath, plist } from "./gen.mjs";
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

test("installPlists creates a missing LaunchAgents directory before copying", () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-launchd-"));
  const outDir = path.join(root, "rendered");
  const agentsDir = path.join(root, "home", "Library", "LaunchAgents");
  const label = `${defaults.label_prefix}.${job.name}`;
  const source = path.join(outDir, `${label}.plist`);
  const calls = [];

  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(source, "<plist>generated</plist>\n");
    expect(existsSync(agentsDir)).toBe(false);

    installPlists([job], defaults, {
      outDir,
      agentsDir,
      uid: 501,
      run(command, args) {
        calls.push([command, args]);
      },
    });

    expect(readFileSync(path.join(agentsDir, `${label}.plist`), "utf8")).toBe(
      "<plist>generated</plist>\n",
    );
    expect(calls).toEqual([
      ["launchctl", ["bootout", `gui/501/${label}`]],
      ["launchctl", ["bootstrap", "gui/501", path.join(agentsDir, `${label}.plist`)]],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
