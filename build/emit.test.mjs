import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(file);
    return entry.isFile() && entry.name.endsWith(".md") ? [file] : [];
  });
}

test("shared prompts use REST CI watchers instead of watched PR checks", () => {
  for (const file of markdownFiles(path.join(ROOT, "shared"))) {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/gh pr checks[\s\S]{0,100}--watch/);
  }
});

test("delivered floor documents valid Owned Paths bullets", () => {
  const floor = readFileSync(
    path.join(ROOT, "dist", "AGENTS.floor.md"),
    "utf8",
  );
  expect(floor).toContain("one repo-relative path or glob per bullet");
  expect(floor).toContain("do not use comma-separated lists");
  expect(floor).toContain(
    "shared/** ⇒ dist/** + plugins/core/** + event-runtime/pins.json",
  );
  expect(floor).toContain("agents/X.md ⇒ X.json");
  expect(floor).toContain(
    "agents/*.json|*.view.json ⇒ event-runtime/lib/registry.test.mjs",
  );
});

test.each([
  ["git@github.com:Owner/Repository.git", "owner/repository"],
  ["https://github.com/Owner/Repository", "owner/repository"],
  ["https://github.com/Owner/Repository.git", "owner/repository"],
  ["https://github.com/Owner/Repository/", "owner/repository"],
  ["http://github.com/Owner/Repository", "owner/repository"],
  ["https://user@github.com/Owner/Repository", "owner/repository"],
  ["https://user:token@github.com/Owner/Repository.git", "owner/repository"],
  ["git://github.com/Owner/Repository", "owner/repository"],
  ["git://github.com/Owner/Repository.git", "owner/repository"],
  ["ssh://git@github.com/Owner/Repository.git", "owner/repository"],
  ["ssh://git@github.com:22/Owner/Repository", "owner/repository"],
  ["git+ssh://git@github.com/Owner/Repository.git", "owner/repository"],
  ["  git@github.com:Owner/Repository.git\n", "owner/repository"],
  ["Owner/Repository", null],
  ["https://gitlab.com/Owner/Repository", null],
  ["https://github.com/Owner", null],
  ["https://github.com/Owner/Repository/extra", null],
  ["https://github.com/Owner/.git", null],
  ["https://notgithub.com/Owner/Repository", null],
  ["https://github.com.evil.example/Owner/Repository", null],
  ["", null],
  [undefined, null],
])("remoteGithubSlug(%j) -> %j", (remote, slug) => {
  expect(remoteGithubSlug(remote)).toBe(slug);
});

test("GitHub slug helpers distinguish remotes from configured values", () => {
  expect(configuredGithubSlug("Owner/Repository")).toBe("owner/repository");
  expect(configuredGithubSlug("HTTPS://GITHUB.COM/Owner/Repository.git")).toBe(
    "owner/repository",
  );
  expect(
    configuredGithubSlug("https://gitlab.com/Owner/Repository"),
  ).toBeNull();
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
    expect(resolved.map((repo) => repo.isRunningRepo)).toEqual([
      false,
      true,
      true,
    ]);
    expect(resolved[0].checkoutPath).toBe(siblingRoot);
    expect(resolved[1].checkoutPath).toBe(realpathSync(runningRoot));
    expect(resolved[2].checkoutPath).toBe(realpathSync(runningRoot));

    // Writing (--sync-floor) never targets another checkout of this
    // repository: a matching origin resolves to the running tree even when the
    // configured path is a usable directory elsewhere.
    const writing = resolveFloorCheckouts({
      runningRoot: realpathSync(runningRoot),
      runningGithub: "watt-mind/factory",
      repos,
      preferRunning: true,
    });
    expect(writing.map((repo) => repo.isRunningRepo)).toEqual([
      true,
      true,
      true,
    ]);
    expect(writing.map((repo) => repo.checkoutPath)).toEqual([
      realpathSync(runningRoot),
      realpathSync(runningRoot),
      realpathSync(runningRoot),
    ]);
    // A sibling of a different repository keeps its own path in both modes.
    const other = { name: "other", path: siblingRoot, github: "acme/other" };
    for (const preferRunning of [false, true]) {
      const [resolvedOther] = resolveFloorCheckouts({
        runningRoot: realpathSync(runningRoot),
        runningGithub: "watt-mind/factory",
        repos: [other],
        preferRunning,
      });
      expect(resolvedOther.isRunningRepo).toBe(false);
      expect(resolvedOther.checkoutPath).toBe(siblingRoot);
    }
  } finally {
    rmSync(runningRoot, { recursive: true, force: true });
    rmSync(siblingRoot, { recursive: true, force: true });
  }
});

test("floor checkout resolution is a boolean without a running remote", () => {
  const runningRoot = mkdtempSync(path.join(tmpdir(), "emit-running-"));
  try {
    const repos = [
      {
        name: "missing",
        path: path.join(tmpdir(), "emit-missing-checkout"),
        github: "watt-mind/factory",
      },
      { name: "running", path: runningRoot, github: "watt-mind/factory" },
    ];
    for (const runningGithub of [null, undefined, ""]) {
      for (const preferRunning of [false, true]) {
        const resolved = resolveFloorCheckouts({
          runningRoot: realpathSync(runningRoot),
          runningGithub,
          repos,
          preferRunning,
        });
        expect(resolved.map((repo) => repo.isRunningRepo)).toEqual([
          false,
          true,
        ]);
        expect(resolved[0].checkoutPath).toBe(repos[0].path);
      }
    }
  } finally {
    rmSync(runningRoot, { recursive: true, force: true });
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
  // Skipped: the git dir (the fixture gets its own), every node_modules at
  // any depth (the root one is linked below; nested ones are not imported by
  // emit), operator-local trees that live inside a checkout (.claude/ and
  // .worktrees/ hold agent worktrees that run to hundreds of MB and filled
  // the sandbox tmpfs with ENOSPC), and the operator-local configs — the
  // fixture writes its own.
  cpSync(ROOT, fixture, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(ROOT, source);
      const segments = relative.split(path.sep);
      if (segments.includes("node_modules") || segments[0] === ".git")
        return false;
      if (/^\.(claude|worktrees|factory)$/.test(segments[0])) return false;
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

test("floor check fails when the running checkout's floor is stale", () => {
  const fixture = makeEmitFixture();
  const staleAgents =
    "<!-- FACTORY:FLOOR:BEGIN -->\nstale floor\n<!-- FACTORY:FLOOR:END -->\n";

  try {
    writeFileSync(path.join(fixture, "AGENTS.md"), staleAgents);
    writeFileSync(path.join(fixture, "config", "repos.yaml"), "repos: []\n");

    const result = Bun.spawnSync({
      cmd: ["bun", "build/emit.mjs", "--check"],
      cwd: fixture,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Current checkout floor is stale: AGENTS.md",
    );
    expect(result.stderr.toString()).toContain(
      "bun build/emit.mjs --sync-floor",
    );
    expect(result.stdout.toString()).toContain(
      "floor delivery: no configured repo checked out here — not verified",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("sync-floor writes the running checkout, never the configured one", () => {
  const fixture = makeEmitFixture();
  const configured = mkdtempSync(path.join(tmpdir(), "emit-floor-live-"));
  const staleAgents =
    "# Live checkout\n\n<!-- FACTORY:FLOOR:BEGIN -->\nstale floor\n<!-- FACTORY:FLOOR:END -->\n";

  try {
    // The fixture is a worktree-shaped checkout of this repo whose CONFIGURED
    // path is a different, usable checkout (the operator's live tree) with a
    // stale floor. Both carry a stale floor; only the running one may change.
    writeFileSync(path.join(fixture, "AGENTS.md"), staleAgents);
    writeFileSync(path.join(configured, "AGENTS.md"), staleAgents);
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "origin", "https://github.com/watt-mind/factory.git"],
    ]) {
      const git = Bun.spawnSync({ cmd: ["git", ...args], cwd: fixture });
      expect(git.exitCode).toBe(0);
    }
    writeFileSync(
      path.join(fixture, "config", "repos.yaml"),
      `repos:\n  - name: factory\n    path: ${configured}\n    github: watt-mind/factory\n`,
    );

    const result = Bun.spawnSync({
      cmd: ["bun", "build/emit.mjs", "--sync-floor"],
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
    expect(output).toContain("updated  factory");

    // The running checkout received the floor; the configured one is untouched.
    const fixtureAgents = readFileSync(path.join(fixture, "AGENTS.md"), "utf8");
    expect(fixtureAgents).not.toBe(staleAgents);
    expect(fixtureAgents).not.toContain("stale floor");
    expect(readFileSync(path.join(configured, "AGENTS.md"), "utf8")).toBe(
      staleAgents,
    );
    // Nothing above touched this checkout.
    expect(existsSync(path.join(ROOT, "config", "repos.yaml"))).toBe(
      hadLocalReposConfig,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(configured, { recursive: true, force: true });
  }
});
