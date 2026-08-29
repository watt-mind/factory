import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spliceFloor } from "../lib/floor.mjs";

const ROOT = path.resolve(import.meta.dir, "..");

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

test("floor check uses the running checkout for its matching repo", () => {
  const configFile = path.join(ROOT, "config", "repos.yaml");
  const agentsFile = path.join(ROOT, "AGENTS.md");
  const hadConfig = existsSync(configFile);
  const originalConfig = hadConfig ? readFileSync(configFile) : null;
  const originalAgents = readFileSync(agentsFile, "utf8");
  const staleFactory = mkdtempSync(path.join(tmpdir(), "emit-floor-factory-"));
  const staleSibling = mkdtempSync(path.join(tmpdir(), "emit-floor-sibling-"));
  const staleAgents =
    "<!-- FACTORY:FLOOR:BEGIN -->\nstale floor\n<!-- FACTORY:FLOOR:END -->\n";

  try {
    // This worktree's checked-in floor predates the current source floor. Make
    // the fixture's running tree current, then restore the operator file below.
    writeFileSync(
      agentsFile,
      spliceFloor(
        originalAgents,
        readFileSync(path.join(ROOT, "dist", "AGENTS.floor.md"), "utf8"),
      ),
    );
    writeFileSync(path.join(staleFactory, "AGENTS.md"), staleAgents);
    writeFileSync(path.join(staleSibling, "AGENTS.md"), staleAgents);
    writeFileSync(
      configFile,
      `repos:\n  - name: factory\n    path: ${staleFactory}\n    github: watt-mind/factory\n  - name: sibling\n    path: ${staleSibling}\n    github: watt-mind/other-repo\n`,
    );

    const result = Bun.spawnSync({
      cmd: ["bun", "build/emit.mjs", "--check"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("floor delivery: 1 of 2");
    expect(output).toContain("stale    sibling");
    expect(output).not.toContain("stale    factory");
  } finally {
    if (originalConfig === null) rmSync(configFile, { force: true });
    else writeFileSync(configFile, originalConfig);
    writeFileSync(agentsFile, originalAgents);
    rmSync(staleFactory, { recursive: true, force: true });
    rmSync(staleSibling, { recursive: true, force: true });
  }
});
