#!/usr/bin/env bun
/**
 * Harness packs -> per-harness packaging (WM-849).
 *
 *   bun build/emit.mjs           # regenerate plugins/ and dist/
 *   bun build/emit.mjs --check   # CI: fail if the tree isn't reproducible
 *   bun build/emit.mjs --link    # symlink this machine's harnesses at shared/
 *   bun build/emit.mjs --link-bin # symlink bin/factory -> ~/.local/bin/factory
 *   bun run link-repos           # symlink plugins/core/commands/ into every
 *                                 # configured repo's .claude/commands/ — run
 *                                 # this whenever a /factory-* command is
 *                                 # added or removed, or product repos keep
 *                                 # running against a stale command set
 *
 * `shared/` is the built-in `factory/core` pack (`shared/factory-extension.json`).
 * Every other loaded extension that `contributes.harness` is emitted under its
 * publisher-extension namespace. Core output paths are unchanged so
 * plugins/core/** and dist/** stay byte-identical with the pre-packaging tree.
 *
 * Why a build step at all: the CONTENT is harness-neutral (SKILL.md is a shared
 * format; command bodies are markdown) but the PACKAGING is not. Claude wants a
 * plugin with frontmatter, Codex wants ~/.agents/skills, Cursor wants bare
 * markdown commands, and every harness reads a different context file.
 *
 * Why `--check` matters more than the emit: the failure this repo exists to
 * prevent is a rule living in one harness's file and nowhere else — coach-wattz
 * carries "NEVER prisma db push" only in GEMINI.md, invisible to Claude. Four
 * generated copies are only safer than four hand-written ones if CI proves they
 * still match their source.
 *
 * Runs on bun (see lib/schedule.mjs); no npm dependencies.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  existsSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FLOOR_BEGIN, spliceFloor, floorIsCurrent } from "../lib/floor.mjs";
import { ensureHarnessGitignore } from "../lib/factory-gitignore.mjs";
import {
  CORE_HARNESS_PLUGIN,
  collectHarnessRoots,
} from "../event-runtime/lib/extensions.mjs";
import { resolveConfigPath } from "../event-runtime/lib/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = path.join(ROOT, "shared");
const CHECK = process.argv.includes("--check");
const LINK = process.argv.includes("--link");
const LINK_BIN = process.argv.includes("--link-bin");

const rel = (p) => path.relative(ROOT, p);
const read = (p) => readFileSync(p, "utf8");
const listFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? listFiles(path.join(dir, e.name))
          : [path.join(dir, e.name)],
      )
    : [];

/** Split `---` frontmatter from a markdown body. */
function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: text.slice(m[0].length) };
}

/** Remove another harness's namespaced fields while preserving source bytes. */
function withoutFrontmatterFields(text, fields) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return text;
  const dropped = new Set(fields);
  const kept = m[1].split("\n").filter((line) => {
    const key = line.match(/^([\w-]+):/)?.[1];
    return !dropped.has(key);
  });
  return `---\n${kept.join("\n")}\n---${text.slice(m[0].length)}`;
}

/** Render a harness-native Markdown agent without leaking another harness's model id. */
function markdownAgent(agent, fields = {}) {
  const frontmatter = {
    name: agent.name,
    description: agent.description,
    ...fields,
  };
  const lines = Object.entries(frontmatter).map(
    ([key, value]) =>
      `${key}: ${typeof value === "string" ? JSON.stringify(value) : value}`,
  );
  return `---\n${lines.join("\n")}\n---\n\n${agent.body.trimStart()}`;
}

/** Codex custom agents are standalone TOML configs rather than Markdown. */
function codexAgent(agent) {
  return [
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${JSON.stringify(agent.description)}`,
    `sandbox_mode = "read-only"`,
    `developer_instructions = ${JSON.stringify(agent.body.trim())}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- writing ---
const written = new Map();
function emit(file, content) {
  written.set(path.resolve(file), content);
  if (CHECK) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Purge generated subtrees before writing so renamed or deleted sources cannot linger. */
function cleanGenerated(...directories) {
  if (CHECK) return;
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
}

/** Nested dest for namespaced packs; core (no prefix) keeps historical paths. */
function destJoin(pack, base, ...parts) {
  return pack.prefix
    ? path.join(base, pack.prefix, ...parts)
    : path.join(base, ...parts);
}

/** Flat-file dest: prefix the filename so ~/.cursor/commands stays collision-free. */
function destFile(pack, dir, filename) {
  return pack.prefix
    ? path.join(dir, `${pack.prefix}-${filename}`)
    : path.join(dir, filename);
}

function commandSkillName(pack, file) {
  const stem = path.basename(file, ".md");
  return pack.prefix ? `${pack.prefix}-${stem}` : stem;
}

// ------------------------------------------------------------------ inputs ---
const { roots: harnessPacks, anomalies: harnessAnomalies } =
  collectHarnessRoots({
    root: ROOT,
    builtin: SHARED,
  });
for (const anomaly of harnessAnomalies) console.error(`harness: ${anomaly}`);
if (harnessPacks.length === 0) {
  console.error("no harness packs to emit — built-in shared/ pack is missing");
  process.exit(2);
}

function loadPackContent(pack) {
  const commands = pack.commands
    ? listFiles(pack.commands).filter((f) => f.endsWith(".md"))
    : [];
  const skillDirs = pack.skills
    ? readdirSync(pack.skills, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  const agents = pack.subagents
    ? listFiles(pack.subagents).filter((f) => f.endsWith(".md"))
    : [];
  const agentDefinitions = agents.map((file) => {
    const { fm, body } = splitFrontmatter(read(file));
    const name = fm.name || path.basename(file, ".md");
    if (!fm.description)
      throw new Error(`${rel(file)}: agents require a description`);
    if (name !== path.basename(file, ".md"))
      throw new Error(
        `${rel(file)}: agent name must match its filename (${name})`,
      );
    return { file, name, description: fm.description, fm, body };
  });
  return {
    pack,
    floor: pack.floor ? read(pack.floor) : null,
    commands,
    skillDirs,
    skillsRoot: pack.skills,
    agents,
    agentDefinitions,
  };
}

const loadedPacks = harnessPacks.map(loadPackContent);
const corePack = loadedPacks.find((p) => p.pack.builtin) ?? loadedPacks[0];
const floor = corePack.floor;
if (typeof floor !== "string") {
  throw new Error("built-in harness pack must contribute a floor");
}

const CLAUDE = path.join(ROOT, "plugins", CORE_HARNESS_PLUGIN);
const CODEX = path.join(ROOT, "dist", "codex");
const GEMINI = path.join(ROOT, "dist", "gemini");
const CURSOR = path.join(ROOT, "dist", "cursor");
const PI = path.join(ROOT, "dist", "pi");
const PI_DEFAULT_AGENT_TOOLS = "read, grep, find, ls, bash";

if (!CHECK) {
  const extraPlugins = new Set(
    harnessPacks.filter((p) => !p.builtin).map((p) => p.plugin),
  );
  const pluginsRoot = path.join(ROOT, "plugins");
  if (existsSync(pluginsRoot)) {
    for (const name of readdirSync(pluginsRoot)) {
      if (name === CORE_HARNESS_PLUGIN) continue;
      if (!extraPlugins.has(name))
        rmSync(path.join(pluginsRoot, name), { recursive: true, force: true });
    }
  }
  const distRoot = path.join(ROOT, "dist");
  if (existsSync(distRoot)) {
    for (const name of readdirSync(distRoot)) {
      if (/^AGENTS\.floor\..+\.md$/.test(name))
        rmSync(path.join(distRoot, name), { force: true });
    }
  }
}

cleanGenerated(
  path.join(CLAUDE, "commands"),
  path.join(CLAUDE, "skills"),
  path.join(CLAUDE, "agents"),
  path.join(CODEX, "agents"),
  path.join(CODEX, "skills"),
  path.join(CODEX, "prompts"),
  path.join(GEMINI, "agents"),
  path.join(GEMINI, "skills"),
  path.join(CURSOR, "agents"),
  path.join(CURSOR, "commands"),
  path.join(PI, "agents"),
  path.join(PI, "skills"),
  path.join(PI, "prompts"),
);
for (const pack of harnessPacks) {
  if (pack.builtin) continue;
  const plugin = path.join(ROOT, "plugins", pack.plugin);
  cleanGenerated(
    path.join(plugin, "commands"),
    path.join(plugin, "skills"),
    path.join(plugin, "agents"),
  );
}

function emitPack({
  pack,
  commands,
  skillDirs,
  skillsRoot,
  agentDefinitions,
  floor: packFloor,
}) {
  const plugin = path.join(ROOT, "plugins", pack.plugin);
  for (const f of commands)
    emit(path.join(plugin, "commands", path.basename(f)), read(f));
  for (const s of skillDirs)
    for (const f of listFiles(path.join(skillsRoot, s)))
      emit(
        path.join(
          plugin,
          "skills",
          s,
          path.relative(path.join(skillsRoot, s), f),
        ),
        read(f),
      );
  for (const agent of agentDefinitions)
    emit(
      path.join(plugin, "agents", `${agent.name}.md`),
      withoutFrontmatterFields(read(agent.file), ["pi-tools", "pi-extensions"]),
    );

  for (const agent of agentDefinitions)
    emit(
      destJoin(pack, path.join(CODEX, "agents"), `${agent.name}.toml`),
      codexAgent(agent),
    );
  for (const s of skillDirs)
    for (const f of listFiles(path.join(skillsRoot, s)))
      emit(
        destJoin(
          pack,
          path.join(CODEX, "skills"),
          s,
          path.relative(path.join(skillsRoot, s), f),
        ),
        read(f),
      );
  for (const f of commands) {
    const { fm, body } = splitFrontmatter(read(f));
    const name = commandSkillName(pack, f);
    emit(
      destJoin(pack, path.join(CODEX, "skills"), name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${fm.description || `Run the ${name} Factory workflow.`}\n---\n\n# ${name}\n\nThe user's accompanying request is this workflow's argument string. Wherever these instructions refer to \`$ARGUMENTS\`, interpret it as that request.\n\n${body.trimStart()}`,
    );
  }

  for (const agent of agentDefinitions)
    emit(
      destJoin(pack, path.join(GEMINI, "agents"), `${agent.name}.md`),
      markdownAgent(agent, { kind: "local" }),
    );
  for (const s of skillDirs)
    for (const f of listFiles(path.join(skillsRoot, s)))
      emit(
        destJoin(
          pack,
          path.join(GEMINI, "skills"),
          s,
          path.relative(path.join(skillsRoot, s), f),
        ),
        read(f),
      );
  for (const f of commands) {
    const { fm, body } = splitFrontmatter(read(f));
    const name = commandSkillName(pack, f);
    emit(
      destJoin(pack, path.join(GEMINI, "skills"), name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${fm.description || `Run the ${name} Factory workflow.`}\n---\n\n# ${name}\n\nThe user's accompanying request is this workflow's argument string. Wherever these instructions refer to \`$ARGUMENTS\`, interpret it as that request.\n\n${body.trimStart()}`,
    );
  }

  for (const agent of agentDefinitions)
    emit(
      destJoin(pack, path.join(CURSOR, "agents"), `${agent.name}.md`),
      markdownAgent(agent, { readonly: true }),
    );
  for (const f of commands) {
    const { body } = splitFrontmatter(read(f));
    emit(
      destFile(pack, path.join(CURSOR, "commands"), path.basename(f)),
      body.trimStart(),
    );
  }

  for (const agent of agentDefinitions) {
    const piFields = {
      tools: agent.fm["pi-tools"] || PI_DEFAULT_AGENT_TOOLS,
      systemPromptMode: "replace",
      inheritProjectContext: true,
      inheritSkills: true,
    };
    if (agent.fm["pi-extensions"])
      piFields.extensions = agent.fm["pi-extensions"];
    emit(
      destJoin(pack, path.join(PI, "agents"), `${agent.name}.md`),
      markdownAgent(agent, piFields),
    );
  }
  for (const s of skillDirs)
    for (const f of listFiles(path.join(skillsRoot, s)))
      emit(
        destJoin(
          pack,
          path.join(PI, "skills"),
          s,
          path.relative(path.join(skillsRoot, s), f),
        ),
        read(f),
      );
  for (const f of commands) {
    const { fm, body } = splitFrontmatter(read(f));
    emit(
      destFile(pack, path.join(PI, "prompts"), path.basename(f)),
      `# ${path.basename(f, ".md")}\n\n${fm.description ? `> ${fm.description}\n\n` : ""}${body.trimStart()}`,
    );
  }

  if (packFloor && pack.builtin)
    emit(path.join(ROOT, "dist", "AGENTS.floor.md"), packFloor);
  else if (packFloor && pack.plugin)
    emit(path.join(ROOT, "dist", `AGENTS.floor.${pack.plugin}.md`), packFloor);
}

for (const loaded of loadedPacks) emitPack(loaded);

const commands = corePack.commands;
const skillDirs = corePack.skillDirs;
const agents = corePack.agents;

// ---------------------------------------------------------- floor in repos ---
// Emitting dist/AGENTS.floor.md is not delivery. Until 2026-08-04 that was the
// last step, and the floor had reached NONE of the four configured repos — the
// exact failure this repo exists to prevent, in its own output. Transcripts show
// what that cost: ~100 `sleep N` calls and repeated unquoted-glob crashes, both
// of which the floor explicitly forbids, plus 156 re-reads of linear.md by
// agents with no local copy of the protocol to work from.
//
// So the floor is SPLICED into each repo's AGENTS.md between its markers.
// Marker-delimited rather than whole-file so a repo keeps its own content, and
// idempotent so running it twice is a no-op.
/**
 * Return the canonical GitHub owner/repository slug for a remote URL.
 * SSH and HTTPS remotes are both accepted because the checkout's transport
 * does not change which repository it represents.
 */
function githubSlug(remote) {
  const value = remote.trim();
  const match = value.match(/github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/i);
  if (!match && /^[^/]+\/[^/#]+$/.test(value)) return value.toLowerCase();
  return match?.[1]?.toLowerCase() ?? null;
}

function originGithubSlug(root) {
  try {
    return githubSlug(
      execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

/** [{name, path, state}] — state is ok | stale | missing | no-checkout. */
function floorStatus() {
  const cfg = Bun.YAML.parse(
    readFileSync(resolveConfigPath("repos", { root: ROOT }), "utf8"),
  );
  const runningRoot = realpathSync(ROOT);
  const runningGithub = originGithubSlug(ROOT);
  return (cfg.repos ?? []).map((repo) => {
    const repoPath = String(repo.path).replace(/^~/, homedir());
    // The configured path can name the operator's checkout, but a worktree
    // often has the same origin while living elsewhere. Inspect this tree for
    // the matching path or GitHub slug; only sibling repos use their config
    // path so their floor status remains visible too.
    let configuredRoot = null;
    if (existsSync(repoPath)) {
      try {
        configuredRoot = realpathSync(repoPath);
      } catch {
        configuredRoot = null;
      }
    }
    const isRunningRepo =
      configuredRoot === runningRoot ||
      (runningGithub &&
        githubSlug(String(repo.github ?? "")) === runningGithub);
    const checkoutPath = isRunningRepo ? ROOT : repoPath;
    const agentsFile = path.join(checkoutPath, "AGENTS.md");
    if (!existsSync(checkoutPath))
      return { ...repo, agents: agentsFile, state: "no-checkout" };
    if (!existsSync(agentsFile))
      return { ...repo, agents: agentsFile, state: "missing" };
    const body = read(agentsFile);
    if (!body.includes(FLOOR_BEGIN))
      return { ...repo, agents: agentsFile, state: "missing" };
    return {
      ...repo,
      agents: agentsFile,
      state: floorIsCurrent(body, floor) ? "ok" : "stale",
    };
  });
}

if (process.argv.includes("--sync-floor")) {
  console.log("\nsyncing the floor into each configured repo's AGENTS.md:");
  for (const r of floorStatus()) {
    if (r.state === "no-checkout") {
      console.log(`  skip     ${r.name} — no checkout at ${r.path}`);
      continue;
    }
    if (r.state === "ok") {
      console.log(`  current  ${r.name}`);
      continue;
    }
    writeFileSync(
      r.agents,
      spliceFloor(existsSync(r.agents) ? read(r.agents) : "", floor),
    );
    console.log(
      `  ${r.state === "stale" ? "updated " : "added   "} ${r.name}  -> ${r.path}/AGENTS.md`,
    );
  }
  console.log(
    "\nCommit AGENTS.md in each repo — the floor only protects a sandbox if it is checked in.",
  );
}

// ------------------------------------------------------------------ check ----
if (CHECK) {
  const expected = [...written.keys()];
  // `.claude-plugin/` holds the plugin + marketplace manifests, which are
  // hand-maintained (version, keywords) and have no shared/ source. Everything
  // else under plugins/ and dist/ must be reproducible.
  const isHandMaintained = (p) =>
    p.includes(`${path.sep}.claude-plugin${path.sep}`);
  const actual = [
    ...listFiles(path.join(ROOT, "plugins")),
    ...listFiles(path.join(ROOT, "dist")),
  ]
    .map((p) => path.resolve(p))
    .filter((p) => !isHandMaintained(p));

  const problems = [];
  for (const [file, content] of written) {
    if (!existsSync(file)) problems.push(`missing:   ${rel(file)}`);
    else if (read(file) !== content) problems.push(`stale:     ${rel(file)}`);
  }
  for (const file of actual)
    if (!expected.includes(file)) problems.push(`orphaned:  ${rel(file)}`);

  if (problems.length) {
    console.error("Generated tree does not match harness sources:\n");
    for (const p of problems) console.error("  " + p);
    console.error(`\nRun \`bun build/emit.mjs\` and commit the result.`);
    console.error(
      "If a harness file has a rule that shared/ doesn't, move the rule into shared/ —",
    );
    console.error(
      "a rule that lives in one harness is a rule the other harnesses silently lack.",
    );
    process.exit(1);
  }
  console.log(`ok — ${expected.length} generated files match shared/`);

  // A reproducible dist/ proves the floor was WRITTEN, not that it was
  // DELIVERED. Checking only the former passed green on 2026-08-04 while all
  // four repos carried no floor at all — the check was measuring the half that
  // could not fail. Repos are reported separately and never fail the build:
  // they are other checkouts on this machine, not this repo's tree, and a
  // missing sibling clone must not break factory CI.
  const repos = floorStatus().filter((r) => r.state !== "no-checkout");
  const behind = repos.filter((r) => r.state !== "ok");
  if (!repos.length) {
    console.log(
      "floor delivery: no configured repo checked out here — not verified",
    );
  } else if (behind.length) {
    console.log(
      `\n! floor delivery: ${behind.length} of ${repos.length} repo(s) are not carrying the current floor`,
    );
    for (const r of behind)
      console.log(`    ${r.state.padEnd(8)} ${r.name}  ${r.path}/AGENTS.md`);
    console.log(
      "  Fix: bun build/emit.mjs --sync-floor   (then commit AGENTS.md in each repo)",
    );
  } else {
    console.log(
      `floor delivery: ${repos.length} repo(s) carrying the current floor`,
    );
  }
  process.exit(0);
}

console.log(
  `emitted ${written.size} files from ${harnessPacks.length} harness pack(s)`,
);
console.log(
  `  claude  plugins/core/  (${commands.length} commands, ${skillDirs.length} skills, ${agents.length} agents)`,
);
console.log(
  `  codex   dist/codex/    (${skillDirs.length + commands.length} skills, ${agents.length} agents)`,
);
console.log(
  `  gemini  dist/gemini/   (${skillDirs.length + commands.length} skills, ${agents.length} agents)  — also Antigravity`,
);
console.log(
  `  cursor  dist/cursor/   (${commands.length} commands, ${agents.length} agents)`,
);
console.log(
  `  pi      dist/pi/       (${skillDirs.length} skills, ${commands.length} prompts, ${agents.length} agents)`,
);
console.log(`  floor   dist/AGENTS.floor.md`);
for (const extra of loadedPacks.filter((p) => !p.pack.builtin)) {
  console.log(
    `  extra   plugins/${extra.pack.plugin}/  (${extra.commands.length} commands, ${extra.skillDirs.length} skills, ${extra.agents.length} agents)`,
  );
}

// -------------------------------------------------------------- link repos ---
// Claude Code reads project commands from <repo>/.claude/commands/. Symlinking
// them there is how a repo gets /factory-* without a marketplace fetch — which
// matters for headless runs, where a private-repo plugin install needs GitHub
// auth inside the session and fails closed if it isn't there.
//
// The marketplace route (SETUP.md) still works and is nicer for interactive use;
// this is the one that reliably works for `claude -p`.
if (process.argv.includes("--link-repos")) {
  const cfg = Bun.YAML.parse(
    readFileSync(resolveConfigPath("repos", { root: ROOT }), "utf8"),
  );
  console.log("\nlinking factory commands into each configured repo:");
  for (const repo of cfg.repos ?? []) {
    const repoPath = String(repo.path).replace(/^~/, homedir());
    if (!existsSync(repoPath)) {
      console.log(`  skip     ${repo.name} — no checkout at ${repo.path}`);
      continue;
    }
    const dst = path.join(repoPath, ".claude", "commands");
    mkdirSync(dst, { recursive: true });
    let linked = 0;
    for (const loaded of loadedPacks) {
      const plugin = path.join(ROOT, "plugins", loaded.pack.plugin);
      for (const f of loaded.commands) {
        const filename = loaded.pack.prefix
          ? `${loaded.pack.prefix}-${path.basename(f)}`
          : path.basename(f);
        const target = path.join(dst, filename);
        let st = null;
        try {
          st = lstatSync(target);
        } catch {
          /* intentionally ignored */
        }
        if (st && !st.isSymbolicLink()) {
          console.log(`  skip     ${repo.name}/${filename} (real file)`);
          continue;
        }
        if (st) unlinkSync(target);
        symlinkSync(path.join(plugin, "commands", path.basename(f)), target);
        linked += 1;
      }
    }
    console.log(
      `  linked   ${repo.name}  ${linked} command(s) -> ${repo.path}/.claude/commands/`,
    );
    const gi = ensureHarnessGitignore(repoPath);
    if (gi === "ok")
      console.log(
        `  gitignore  ${repo.name}  harness symlinks already excluded`,
      );
    else
      console.log(
        `  gitignore  ${repo.name}  ${gi} FACTORY:HARNES block -> .gitignore`,
      );
  }
}

function linkFactoryBin() {
  const src = path.join(ROOT, "bin", "factory");
  const dst = path.join(homedir(), ".local/bin/factory");
  if (!existsSync(src)) {
    console.error(`missing ${src}`);
    process.exit(2);
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  let existing = null;
  try {
    existing = lstatSync(dst);
  } catch {
    /* intentionally ignored */
  }
  if (existing) {
    if (!existing.isSymbolicLink()) {
      console.log(`  skip     ${dst}  (real file — not overwriting)`);
      return;
    }
    unlinkSync(dst);
  }
  symlinkSync(src, dst);
  console.log(
    `  linked   ${dst.replace(homedir(), "~")} -> ${src.replace(homedir(), "~")}`,
  );
}

if (LINK_BIN || LINK) linkFactoryBin();

function packLinks(loaded) {
  const { pack, commands, skillDirs, agentDefinitions } = loaded;
  const plugin = path.join(ROOT, "plugins", pack.plugin);
  const skillNames = [
    ...skillDirs,
    ...commands.map((f) => commandSkillName(pack, f)),
  ];
  return [
    ...skillNames.map((s) => [
      destJoin(pack, path.join(CODEX, "skills"), s),
      destJoin(pack, path.join(homedir(), ".agents/skills"), s),
    ]),
    ...skillNames.map((s) => [
      destJoin(pack, path.join(GEMINI, "skills"), s),
      destJoin(pack, path.join(homedir(), ".gemini/skills"), s),
    ]),
    ...commands.map((f) => [
      destFile(pack, path.join(CURSOR, "commands"), path.basename(f)),
      destFile(
        pack,
        path.join(homedir(), ".cursor/commands"),
        path.basename(f),
      ),
    ]),
    ...commands.map((f) => [
      destFile(pack, path.join(PI, "prompts"), path.basename(f)),
      destFile(
        pack,
        path.join(homedir(), ".pi/agent/prompts"),
        path.basename(f),
      ),
    ]),
    ...skillDirs.map((s) => [
      destJoin(pack, path.join(PI, "skills"), s),
      destJoin(pack, path.join(homedir(), ".pi/agent/skills"), s),
    ]),
    ...agentDefinitions.flatMap((agent) => {
      const file = pack.prefix ? `${pack.prefix}-${agent.name}` : agent.name;
      return [
        [
          path.join(plugin, "agents", `${agent.name}.md`),
          path.join(homedir(), ".claude/agents", `${file}.md`),
        ],
        [
          destJoin(pack, path.join(CODEX, "agents"), `${agent.name}.toml`),
          destFile(
            pack,
            path.join(homedir(), ".codex/agents"),
            `${agent.name}.toml`,
          ),
        ],
        [
          destJoin(pack, path.join(GEMINI, "agents"), `${agent.name}.md`),
          destFile(
            pack,
            path.join(homedir(), ".gemini/agents"),
            `${agent.name}.md`,
          ),
        ],
        [
          destJoin(pack, path.join(CURSOR, "agents"), `${agent.name}.md`),
          destFile(
            pack,
            path.join(homedir(), ".cursor/agents"),
            `${agent.name}.md`,
          ),
        ],
        [
          destJoin(pack, path.join(PI, "agents"), `${agent.name}.md`),
          destFile(
            pack,
            path.join(homedir(), ".pi/agent/agents"),
            `${agent.name}.md`,
          ),
        ],
      ];
    }),
  ];
}

// ------------------------------------------------------------------- link ----
if (LINK) {
  console.log(
    "\nlinking this machine's harnesses to shared/ (source of truth, no copy to go stale):",
  );
  const links = loadedPacks.flatMap(packLinks);
  for (const [src, dst] of links) {
    mkdirSync(path.dirname(dst), { recursive: true });
    let existing = null;
    try {
      existing = lstatSync(dst);
    } catch {
      /* intentionally ignored */
    }
    if (existing) {
      if (!existing.isSymbolicLink()) {
        console.log(`  skip     ${dst}  (real file — not overwriting)`);
        continue;
      }
      unlinkSync(dst);
    }
    symlinkSync(src, dst);
    console.log(`  linked   ${dst.replace(homedir(), "~")}`);
  }
}
