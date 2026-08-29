import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spliceFloor } from "../lib/floor.mjs";
import {
  configuredGithubSlug,
  remoteGithubSlug,
  resolveFloorCheckouts,
} from "./emit.mjs";

const ROOT = path.resolve(import.meta.dir, "..");
const hadLocalReposConfig = existsSync(path.join(ROOT, "config", "repos.yaml"));

test("GitHub slug helpers distinguish remotes from configured values", () => {
  expect(remoteGithubSlug("git@github.com:Owner/Repository.git")).toBe(
    "owner/repository",
  );
  expect(remoteGithubSlug("https://github.com/Owner/Repository")).toBe(
    "owner/repository",
  );
  expect(remoteGithubSlug("https://github.com/Owner/Repository.git")).toBe(
    "owner/repository",
  );
  expect(remoteGithubSlug("Owner/Repository")).toBeNull();
  expect(remoteGithubSlug("https://gitlab.com/Owner/Repository")).toBeNull();

  expect(configuredGithubSlug("Owner/Repository")).toBe("owner/repository");
  expect(configuredGithubSlug("HTTPS://GITHUB.COM/Owner/Repository.git")).toBe(
    "owner/repository",
  );
  expect(configuredGithubSlug("https://gitlab.com/Owner/Repository")).toBeNull();
});

test("floor checkout resolution prefers real paths before matching a slug", () => {
  const runningRoot = mkdtempSync(path.join(tmpdir(), "emit-running-"));
  const siblingRoot = mkdtempSync(path.join(tmpdir(), "emit-sibling-"));
  const missingRoot = path.join(tmpdir(), "emit-missing-checkout");
  try {
    const repos = [
      { name: "sibling", path: siblingRoot, github: "watt-mind/factory" },
      { name: "missing", path: missingRoot, github: "watt-mind/factory" },
      { name: "running", path: runningRoot, github: "watt-mind/factory" },
    ];
    const resolved = resolveFloorCheckouts({
      runningRoot: realpathSync(runningRoot),
      runningGithub: "watt-mind/factory",
      repos,
    });
    expect(resolved.map((repo) => repo.isRunningRepo)).toEqual([false, true, true]);
    expect(resolved[0].checkoutPath).toBe(siblingRoot);
    expect(resolved[1].checkoutPath).toBe(realpathSync(runningRoot));
    expect(resolved[2].checkoutPath).toBe(realpathSync(runningRoot));
  } finally {
    rmSync(runningRoot, { recursive: true, force: true });
    rmSync(siblingRoot, { recursive: true, force: true });
  }
});

test("emit purges orphaned commands, skills, and prompts from every output tree", () => {
  const orphaned = [
    "plugins/core/commands/orphaned-command.md",
    "plugins/core/skills/orphaned-skill/SKILL.md",
    "dist/codex/skills/orphaned-skill/SKILL.md",
    "dist/gemini/skills/orphaned-skill/SKILL.md",
    "dist/cursor/commands/orphaned-command.md",
    "dist/pi/skills/orphaned-skill/SKILL.md",
    "dist/pi/prompts/orphaned-command.md",
  ].map((file) => path.join(ROOT, file));
  const handMaintained = path.join(
    ROOT,
    "plugins/core/.claude-plugin/emit-preserves-this.txt",
  );

  try {
    for (const file of [...orphaned, handMaintained]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "sentinel\n");
    }

    const result = Bun.spawnSync({
      cmd: ["bun", "build/emit.mjs"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    // A clean checkout (WM-794) has no operator-local config/*.yaml — only
    // the tracked examples — so resolveConfigPath's once-per-process fallback
    // warning is expected here, not a real error. Anything else on stderr
    // still fails the test.
    const stderrLines = result.stderr
      .toString()
      .split("\n")
      .filter((line) => line && !/config\/.*\.yaml is missing/.test(line));
    expect(stderrLines).toEqual([]);
    expect(result.exitCode).toBe(0);
    for (const file of orphaned) expect(existsSync(file)).toBe(false);
    expect(existsSync(handMaintained)).toBe(true);
  } finally {
    for (const file of [...orphaned, handMaintained]) {
      rmSync(file, { force: true });
    }
  }
});

/**
 * Stand up a throwaway copy of everything `emit.mjs --check` reads, so the
 * floor-delivery test never writes into this checkout: on the self-hosted
 * runner ROOT is the operator's live tree, and rewriting its AGENTS.md or
 * config/repos.yaml — even briefly, even restored in `finally` — is a hazard.
 */
function makeEmitFixture() {
  const fixture = mkdtempSync(path.join(tmpdir(), "emit-fixture-"));
  // The emit import graph reaches across event-runtime/, orchestrator/,
  // tools/ and more, so copy the checkout rather than curate a file list.
  // Skipped: the git dir (the fixture gets its own), node_modules (linked
  // below), and the operator-local configs — the fixture writes its own.
  cpSync(ROOT, fixture, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(ROOT, source);
      const top = relative.split(path.sep)[0];
      if (top === ".git" || top === "node_modules") return false;
      return !(
        path.dirname(relative) === "config" &&
        /^(repos|policy|schedule)\.yaml$/.test(path.basename(relative))
      );
    },
  });
  const nodeModules = path.join(ROOT, "node_modules");
  if (existsSync(nodeModules))
    symlinkSync(nodeModules, path.join(fixture, "node_modules"), "dir");
  return fixture;
}

test("floor check uses the running checkout when its configured path is missing", () => {
  const fixture = makeEmitFixture();
  const staleSibling = mkdtempSync(path.join(tmpdir(), "emit-floor-sibling-"));
  const staleAgents =
    "<!-- FACTORY:FLOOR:BEGIN -->\nstale floor\n<!-- FACTORY:FLOOR:END -->\n";

  try {
    // The fixture is a current checkout of this repo (its AGENTS.md carries the
    // floor emit just generated) whose origin names watt-mind/factory. Its
    // configured path is absent, which is the worktree shape the slug fallback
    // supports. The sibling keeps its configured path.
    writeFileSync(
      path.join(fixture, "AGENTS.md"),
      spliceFloor(
        readFileSync(path.join(ROOT, "AGENTS.md"), "utf8"),
        readFileSync(path.join(ROOT, "dist", "AGENTS.floor.md"), "utf8"),
      ),
    );
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "origin", "git@github.com:watt-mind/factory.git"],
    ]) {
      const git = Bun.spawnSync({ cmd: ["git", ...args], cwd: fixture });
      expect(git.exitCode).toBe(0);
    }
    writeFileSync(path.join(staleSibling, "AGENTS.md"), staleAgents);
    writeFileSync(
      path.join(fixture, "config", "repos.yaml"),
      `repos:\n  - name: factory\n    path: ${path.join(fixture, "missing-factory")}\n    github: watt-mind/factory\n  - name: sibling\n    path: ${staleSibling}\n    github: watt-mind/other-repo\n`,
    );

    const result = Bun.spawnSync({
      cmd: ["bun", "build/emit.mjs", "--check"],
      cwd: fixture,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Only the example-config fallback warning is expected (see above).
    const stderrLines = result.stderr
      .toString()
      .split("\n")
      .filter((line) => line && !/config\/.*\.yaml is missing/.test(line));
    expect(stderrLines).toEqual([]);
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("floor delivery: 1 of 2");
    expect(output).toContain("stale    sibling");
    expect(output).not.toContain("stale    factory");
    // Nothing above touched this checkout.
    expect(existsSync(path.join(ROOT, "config", "repos.yaml"))).toBe(
      hadLocalReposConfig,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(staleSibling, { recursive: true, force: true });
  }
});
