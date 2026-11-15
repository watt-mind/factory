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

test("delivered floor documents explicit browser tab routing and reload re-read rules", () => {
  const floor = readFileSync(
    path.join(ROOT, "dist", "AGENTS.floor.md"),
    "utf8",
  );
  expect(floor).toContain("Pass `tabId` explicitly on every browser call");
  expect(floor).toContain("Own a tab from `tabs_create`");
  expect(floor).toContain("Assert origin before trusting a read");
  expect(floor).toContain("Re-read after reload");
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
    "dist/cursor/skills/orphaned-skill/SKILL.md",
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

test("emit writes Cursor skills matching shared/skills/", () => {
  for (const skill of ["ticket-spec", "factory-handoff"]) {
    const sharedFile = path.join(ROOT, "shared", "skills", skill, "SKILL.md");
    const cursorFile = path.join(
      ROOT,
      "dist",
      "cursor",
      "skills",
      skill,
      "SKILL.md",
    );
    expect(existsSync(cursorFile)).toBe(true);
    expect(readFileSync(cursorFile, "utf8")).toBe(
      readFileSync(sharedFile, "utf8"),
    );
  }
});

test("emit quotes and scopes command-skill descriptions for Codex and Gemini", () => {
  for (const harness of ["codex", "gemini"]) {
    const skillText = readFileSync(
      path.join(ROOT, "dist", harness, "skills", "factory-ship", "SKILL.md"),
      "utf8",
    );
    const fmMatch = skillText.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fmMatch).not.toBeNull();
    expect(fmMatch[1]).toMatch(/^description:\s+".+"$/m);
    const parsed = Bun.YAML.parse(fmMatch[1]);
    expect(parsed.name).toBe("factory-ship");
    expect(parsed.description).toContain(
      "Invoke only when the user explicitly asks to run /factory-ship or the factory-ship workflow.",
    );
  }

  const fixture = makeEmitFixture();
  try {
    writeFileSync(
      path.join(fixture, "shared", "commands", "factory-colon-test.md"),
      "---\ndescription: Release: open a PR and watch: checks\n---\n\nRun it.\n",
    );
    const result = Bun.spawnSync({
      cmd: ["bun", "build/emit.mjs"],
      cwd: fixture,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    for (const harness of ["codex", "gemini"]) {
      const generated = readFileSync(
        path.join(
          fixture,
          "dist",
          harness,
          "skills",
          "factory-colon-test",
          "SKILL.md",
        ),
        "utf8",
      );
      const fmMatch = generated.match(/^---\n([\s\S]*?)\n---\n/);
      expect(fmMatch).not.toBeNull();
      const parsed = Bun.YAML.parse(fmMatch[1]);
      expect(parsed.description).toBe(
        "Release: open a PR and watch: checks. Invoke only when the user explicitly asks to run /factory-colon-test or the factory-colon-test workflow.",
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("ticket-spec and factory-handoff route human holds to Blocked + ai:blocked rather than Triage", () => {
  const ticketSpec = readFileSync(
    path.join(ROOT, "shared", "skills", "ticket-spec", "SKILL.md"),
    "utf8",
  );
  const factoryHandoff = readFileSync(
    path.join(ROOT, "shared", "skills", "factory-handoff", "SKILL.md"),
    "utf8",
  );
  expect(ticketSpec).not.toMatch(/Leave in `Triage`/i);
  expect(ticketSpec).toContain("`Blocked`");
  expect(ticketSpec).toContain("`ai:blocked`");
  expect(ticketSpec).toContain("`ai:agent-ready`");

  expect(factoryHandoff).not.toMatch(
    /remains\s+`?Triage`?|leave it in\s+`?Triage`?/i,
  );
  expect(factoryHandoff).toContain("`Blocked`");
  expect(factoryHandoff).toContain("`ai:blocked`");
});

test("factory-work queries the queue through factory ticket rather than Linear MCP", () => {
  const factoryWork = readFileSync(
    path.join(ROOT, "shared", "commands", "factory-work.md"),
    "utf8",
  );
  expect(factoryWork).not.toMatch(/Linear MCP|linear_common/);
  expect(factoryWork).toContain("`factory ticket");
});

test("factory-merge uses Handoff/PR visual artifacts and an 8-suspect batch cap", () => {
  const factoryMerge = readFileSync(
    path.join(ROOT, "shared", "commands", "factory-merge.md"),
    "utf8",
  );
  expect(factoryMerge).not.toMatch(
    /ticket's attached screenshots|capture and attach them yourself/,
  );
  expect(factoryMerge).toContain("visual_evidence_missing");
  expect(factoryMerge).toContain("at most 8 suspects");
  expect(factoryMerge).not.toContain("at most 5 suspects");
});

test("curated principle-* skills and principles index are emitted and guardrailed", () => {
  const expectedPrinciples = [
    "principle-attack-the-premise",
    "principle-boundary-discipline",
    "principle-build-the-lever",
    "principle-encode-lessons-in-structure",
    "principle-exhaust-the-design-space",
    "principle-experience-first",
    "principle-explain-the-number",
    "principle-fix-root-causes",
    "principle-foundational-thinking",
    "principle-laziness-protocol",
    "principle-make-operations-idempotent",
    "principle-minimize-reader-load",
    "principle-model-the-domain",
    "principle-proceed-with-gates",
    "principle-redesign-from-first-principles",
    "principle-separate-before-serializing-shared-state",
    "principle-subtract-before-you-add",
    "principle-test-behavior-not-implementation",
    "principle-type-system-discipline",
  ];

  expect(
    existsSync(
      path.join(ROOT, "shared", "skills", "principle-never-block-on-the-human"),
    ),
  ).toBe(false);

  const indexPath = path.join(
    ROOT,
    "shared",
    "skills",
    "principles",
    "SKILL.md",
  );
  expect(existsSync(indexPath)).toBe(true);
  const indexText = readFileSync(indexPath, "utf8");

  for (const name of expectedPrinciples) {
    expect(indexText).toContain(name);
    const skillPath = path.join(ROOT, "shared", "skills", name, "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const raw = readFileSync(skillPath, "utf8");
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fmMatch).not.toBeNull();
    const parsed = Bun.YAML.parse(fmMatch[1]);
    expect(parsed.name).toBe(name);
    expect(parsed["disable-model-invocation"]).toBe(true);

    for (const dest of [
      path.join(ROOT, "plugins", "core", "skills", name, "SKILL.md"),
      path.join(ROOT, "dist", "cursor", "skills", name, "SKILL.md"),
      path.join(ROOT, "dist", "codex", "skills", name, "SKILL.md"),
      path.join(ROOT, "dist", "gemini", "skills", name, "SKILL.md"),
    ]) {
      expect(existsSync(dest)).toBe(true);
    }
  }

  const proceed = readFileSync(
    path.join(
      ROOT,
      "shared",
      "skills",
      "principle-proceed-with-gates",
      "SKILL.md",
    ),
    "utf8",
  );
  expect(proceed).toMatch(/Never auto-merge|editorial|security/i);

  const redesign = readFileSync(
    path.join(
      ROOT,
      "shared",
      "skills",
      "principle-redesign-from-first-principles",
      "SKILL.md",
    ),
    "utf8",
  );
  expect(redesign).toContain("Owned Paths");
  expect(redesign).toContain("Triage");

  const exhaust = readFileSync(
    path.join(
      ROOT,
      "shared",
      "skills",
      "principle-exhaust-the-design-space",
      "SKILL.md",
    ),
    "utf8",
  );
  expect(exhaust).toMatch(/bugfix|explicitly/i);
});

test("emit packages /factory-garden across all five harnesses and lists it in README", () => {
  const gardenSource = path.join(
    ROOT,
    "shared",
    "commands",
    "factory-garden.md",
  );
  expect(existsSync(gardenSource)).toBe(true);
  const garden = readFileSync(gardenSource, "utf8");
  expect(garden).toContain("Checkout freshness");
  expect(garden).toContain("deterministic");
  expect(garden).toContain("false positive");

  for (const emitted of [
    ["plugins", "core", "commands", "factory-garden.md"],
    ["dist", "codex", "skills", "factory-garden", "SKILL.md"],
    ["dist", "gemini", "skills", "factory-garden", "SKILL.md"],
    ["dist", "cursor", "commands", "factory-garden.md"],
    ["dist", "pi", "prompts", "factory-garden.md"],
  ]) {
    expect(existsSync(path.join(ROOT, ...emitted))).toBe(true);
  }

  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  expect(readme).toContain("`/factory-garden`");
  expect(readme).toContain("`~/.cursor/skills/`");
});

test("floor and stage prompts enforce AFK-by-default autonomy without mid-run confirmation stalls", () => {
  const floor = readFileSync(
    path.join(ROOT, "dist", "AGENTS.floor.md"),
    "utf8",
  );
  expect(floor).toContain("The operator is AFK by default.");
  expect(floor).toContain("Never block on derivable engineering decisions");

  const triage = readFileSync(
    path.join(ROOT, "shared", "commands", "factory-triage.md"),
    "utf8",
  );
  expect(triage).not.toMatch(/Confirm with me before canceling/i);

  const audit = readFileSync(
    path.join(ROOT, "shared", "commands", "factory-audit.md"),
    "utf8",
  );
  expect(audit).not.toMatch(/End by asking whether to fix/i);

  const work = readFileSync(
    path.join(ROOT, "shared", "commands", "factory-work.md"),
    "utf8",
  );
  expect(work).not.toMatch(/~\/\.claude\/CLAUDE\.md/);

  const merge = readFileSync(
    path.join(ROOT, "shared", "commands", "factory-merge.md"),
    "utf8",
  );
  expect(merge).not.toMatch(/notify me[\s\S]{0,120}and stop there/i);
  expect(merge).toContain("continue to the next");

  const ticketSpec = readFileSync(
    path.join(ROOT, "shared", "skills", "ticket-spec", "SKILL.md"),
    "utf8",
  );
  expect(ticketSpec).not.toContain("a priority call");
});

test("factory-ticket and factory-merge-reviewer enforce pragmatic root-cause and tier:strong guardrails", () => {
  const ticket = readFileSync(
    path.join(ROOT, "shared", "commands", "factory-ticket.md"),
    "utf8",
  );
  expect(ticket).toContain("Fix root causes, not symptoms");
  expect(ticket).toContain("Do not copy adjacent weeds");
  expect(ticket).toContain("Boundary escape valve");
  expect(ticket).toContain("Cold self-diff check");
  expect(ticket).toMatch(/^6\. \*\*Push and open a PR\*\*/m);

  const reviewer = readFileSync(
    path.join(ROOT, "shared", "agents", "factory-merge-reviewer.md"),
    "utf8",
  );
  expect(reviewer).toContain("suppression hygiene");
  expect(reviewer).toContain("Boundary exception");
  expect(reviewer).toContain("tier:strong");
  expect(reviewer).toContain("Safety invariant:");
});
