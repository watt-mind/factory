import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spliceFloor } from "../lib/floor.mjs";

const ROOT = path.resolve(import.meta.dir, "..");
const hadLocalReposConfig = existsSync(path.join(ROOT, "config", "repos.yaml"));

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

test("floor check uses the running checkout for its matching repo", () => {
  const fixture = makeEmitFixture();
  const staleFactory = mkdtempSync(path.join(tmpdir(), "emit-floor-factory-"));
  const staleSibling = mkdtempSync(path.join(tmpdir(), "emit-floor-sibling-"));
  const staleAgents =
    "<!-- FACTORY:FLOOR:BEGIN -->\nstale floor\n<!-- FACTORY:FLOOR:END -->\n";

  try {
    // The fixture is a current checkout of this repo (its AGENTS.md carries the
    // floor emit just generated) whose origin names watt-mind/factory, while
    // config points `factory` at a stale directory elsewhere — the worktree
    // shape the slug match exists for. The sibling keeps its configured path.
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
    writeFileSync(path.join(staleFactory, "AGENTS.md"), staleAgents);
    writeFileSync(path.join(staleSibling, "AGENTS.md"), staleAgents);
    writeFileSync(
      path.join(fixture, "config", "repos.yaml"),
      `repos:\n  - name: factory\n    path: ${staleFactory}\n    github: watt-mind/factory\n  - name: sibling\n    path: ${staleSibling}\n    github: watt-mind/other-repo\n`,
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
    rmSync(staleFactory, { recursive: true, force: true });
    rmSync(staleSibling, { recursive: true, force: true });
  }
});
