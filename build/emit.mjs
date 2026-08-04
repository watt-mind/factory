#!/usr/bin/env bun
/**
 * shared/ -> per-harness packaging.
 *
 *   bun build/emit.mjs           # regenerate plugins/ and dist/
 *   bun build/emit.mjs --check   # CI: fail if the tree isn't reproducible
 *   bun build/emit.mjs --link    # symlink this machine's harnesses at shared/
 *   bun run link-repos           # symlink plugins/core/commands/ into every
 *                                 # configured repo's .claude/commands/ — run
 *                                 # this whenever a /factory-* command is
 *                                 # added or removed, or product repos keep
 *                                 # running against a stale command set
 *
 * Why a build step at all: the CONTENT is harness-neutral (SKILL.md is a shared
 * format; command bodies are markdown) but the PACKAGING is not. Claude wants a
 * plugin with frontmatter, Codex wants ~/.codex/skills, Cursor wants bare
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
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, existsSync, statSync, symlinkSync, lstatSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FLOOR_BEGIN, spliceFloor, floorIsCurrent } from "../lib/floor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = path.join(ROOT, "shared");
const CHECK = process.argv.includes("--check");
const LINK = process.argv.includes("--link");

const rel = (p) => path.relative(ROOT, p);
const read = (p) => readFileSync(p, "utf8");
const listFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)])
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

// ---------------------------------------------------------------- writing ---
const written = new Map();
function emit(file, content) {
  written.set(path.resolve(file), content);
  if (CHECK) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// ------------------------------------------------------------------ inputs ---
const floor = read(path.join(SHARED, "floor.md"));
const commands = listFiles(path.join(SHARED, "commands")).filter((f) => f.endsWith(".md"));
const skillDirs = existsSync(path.join(SHARED, "skills"))
  ? readdirSync(path.join(SHARED, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];
const agents = listFiles(path.join(SHARED, "agents")).filter((f) => f.endsWith(".md"));

// ------------------------------------------------- Claude Code (plugin) ------
// Frontmatter passes through unchanged: shared/ already uses Claude's keys
// (description / argument-hint / model), which are the most expressive set.
const CLAUDE = path.join(ROOT, "plugins", "core");
for (const f of commands) emit(path.join(CLAUDE, "commands", path.basename(f)), read(f));
for (const s of skillDirs)
  for (const f of listFiles(path.join(SHARED, "skills", s)))
    emit(path.join(CLAUDE, "skills", s, path.relative(path.join(SHARED, "skills", s), f)), read(f));
// Subagents are Claude-only (they need its Task tool); no other harness gets them.
for (const f of agents) emit(path.join(CLAUDE, "agents", path.basename(f)), read(f));

// ------------------------------------------------------------- Codex ---------
// ~/.codex/skills/<name>/SKILL.md — verified same format. Prompts take the
// command bodies without frontmatter, which Codex doesn't consume.
const CODEX = path.join(ROOT, "dist", "codex");
for (const s of skillDirs)
  for (const f of listFiles(path.join(SHARED, "skills", s)))
    emit(path.join(CODEX, "skills", s, path.relative(path.join(SHARED, "skills", s), f)), read(f));
for (const f of commands) {
  const { fm, body } = splitFrontmatter(read(f));
  emit(path.join(CODEX, "prompts", path.basename(f)),
    `# ${path.basename(f, ".md")}\n\n${fm.description ? `> ${fm.description}\n\n` : ""}${body.trimStart()}`);
}

// ------------------------------------------------- Gemini CLI / Antigravity ---
// Antigravity shares ~/.gemini, so one emit covers both.
const GEMINI = path.join(ROOT, "dist", "gemini");
for (const s of skillDirs)
  for (const f of listFiles(path.join(SHARED, "skills", s)))
    emit(path.join(GEMINI, "skills", s, path.relative(path.join(SHARED, "skills", s), f)), read(f));

// ------------------------------------------------------------- Cursor --------
// ~/.cursor/commands/*.md — plain markdown, no frontmatter.
const CURSOR = path.join(ROOT, "dist", "cursor");
for (const f of commands) {
  const { body } = splitFrontmatter(read(f));
  emit(path.join(CURSOR, "commands", path.basename(f)), body.trimStart());
}

// ------------------------------------------------------------- Pi ------------
// dist/pi/ — skills and prompts for the Pi coding agent.
const PI = path.join(ROOT, "dist", "pi");
for (const s of skillDirs)
  for (const f of listFiles(path.join(SHARED, "skills", s)))
    emit(path.join(PI, "skills", s, path.relative(path.join(SHARED, "skills", s), f)), read(f));
for (const f of commands) {
  const { fm, body } = splitFrontmatter(read(f));
  emit(path.join(PI, "prompts", path.basename(f)),
    `# ${path.basename(f, ".md")}\n\n${fm.description ? `> ${fm.description}\n\n` : ""}${body.trimStart()}`);
}

// ------------------------------------------------- universal floor block ------
// Every harness reads AGENTS.md or can be pointed at it, and unlike a plugin it
// travels with the checkout — so this is the only layer a cloud sandbox is
// guaranteed to get.
emit(path.join(ROOT, "dist", "AGENTS.floor.md"), floor);

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
/** [{name, path, state}] — state is ok | stale | missing | no-checkout. */
function floorStatus() {
  const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
  return (cfg.repos ?? []).map((repo) => {
    const repoPath = String(repo.path).replace(/^~/, homedir());
    const agents = path.join(repoPath, "AGENTS.md");
    if (!existsSync(repoPath)) return { ...repo, agents, state: "no-checkout" };
    if (!existsSync(agents)) return { ...repo, agents, state: "missing" };
    const body = read(agents);
    if (!body.includes(FLOOR_BEGIN)) return { ...repo, agents, state: "missing" };
    return { ...repo, agents, state: floorIsCurrent(body, floor) ? "ok" : "stale" };
  });
}

if (process.argv.includes("--sync-floor")) {
  console.log("\nsyncing the floor into each configured repo's AGENTS.md:");
  for (const r of floorStatus()) {
    if (r.state === "no-checkout") { console.log(`  skip     ${r.name} — no checkout at ${r.path}`); continue; }
    if (r.state === "ok") { console.log(`  current  ${r.name}`); continue; }
    writeFileSync(r.agents, spliceFloor(existsSync(r.agents) ? read(r.agents) : "", floor));
    console.log(`  ${r.state === "stale" ? "updated " : "added   "} ${r.name}  -> ${r.path}/AGENTS.md`);
  }
  console.log("\nCommit AGENTS.md in each repo — the floor only protects a sandbox if it is checked in.");
}

// ------------------------------------------------------------------ check ----
if (CHECK) {
  const expected = [...written.keys()];
  // `.claude-plugin/` holds the plugin + marketplace manifests, which are
  // hand-maintained (version, keywords) and have no shared/ source. Everything
  // else under plugins/ and dist/ must be reproducible.
  const isHandMaintained = (p) => p.includes(`${path.sep}.claude-plugin${path.sep}`);
  const actual = [
    ...listFiles(path.join(ROOT, "plugins")),
    ...listFiles(path.join(ROOT, "dist")),
  ].map((p) => path.resolve(p)).filter((p) => !isHandMaintained(p));

  const problems = [];
  for (const [file, content] of written) {
    if (!existsSync(file)) problems.push(`missing:   ${rel(file)}`);
    else if (read(file) !== content) problems.push(`stale:     ${rel(file)}`);
  }
  for (const file of actual) if (!expected.includes(file)) problems.push(`orphaned:  ${rel(file)}`);

  if (problems.length) {
    console.error("Generated tree does not match shared/:\n");
    for (const p of problems) console.error("  " + p);
    console.error(`\nRun \`bun build/emit.mjs\` and commit the result.`);
    console.error("If a harness file has a rule that shared/ doesn't, move the rule into shared/ —");
    console.error("a rule that lives in one harness is a rule the other harnesses silently lack.");
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
    console.log("floor delivery: no configured repo checked out here — not verified");
  } else if (behind.length) {
    console.log(`\n! floor delivery: ${behind.length} of ${repos.length} repo(s) are not carrying the current floor`);
    for (const r of behind) console.log(`    ${r.state.padEnd(8)} ${r.name}  ${r.path}/AGENTS.md`);
    console.log("  Fix: bun build/emit.mjs --sync-floor   (then commit AGENTS.md in each repo)");
  } else {
    console.log(`floor delivery: ${repos.length} repo(s) carrying the current floor`);
  }
  process.exit(0);
}

console.log(`emitted ${written.size} files from shared/`);
console.log(`  claude  plugins/core/  (${commands.length} commands, ${skillDirs.length} skills, ${agents.length} agents)`);
console.log(`  codex   dist/codex/    (${skillDirs.length} skills, ${commands.length} prompts)`);
console.log(`  gemini  dist/gemini/   (${skillDirs.length} skills)  — also Antigravity`);
console.log(`  cursor  dist/cursor/   (${commands.length} commands)`);
console.log(`  pi      dist/pi/       (${skillDirs.length} skills, ${commands.length} prompts)`);
console.log(`  floor   dist/AGENTS.floor.md`);

// -------------------------------------------------------------- link repos ---
// Claude Code reads project commands from <repo>/.claude/commands/. Symlinking
// them there is how a repo gets /factory-* without a marketplace fetch — which
// matters for headless runs, where a private-repo plugin install needs GitHub
// auth inside the session and fails closed if it isn't there.
//
// The marketplace route (SETUP.md) still works and is nicer for interactive use;
// this is the one that reliably works for `claude -p`.
if (process.argv.includes("--link-repos")) {
  const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
  console.log("\nlinking factory commands into each configured repo:");
  for (const repo of cfg.repos ?? []) {
    const repoPath = String(repo.path).replace(/^~/, homedir());
    if (!existsSync(repoPath)) { console.log(`  skip     ${repo.name} — no checkout at ${repo.path}`); continue; }
    const dst = path.join(repoPath, ".claude", "commands");
    mkdirSync(dst, { recursive: true });
    for (const f of commands) {
      const target = path.join(dst, path.basename(f));
      let st = null;
      try { st = lstatSync(target); } catch {}
      if (st && !st.isSymbolicLink()) { console.log(`  skip     ${repo.name}/${path.basename(f)} (real file)`); continue; }
      if (st) unlinkSync(target);
      symlinkSync(path.join(CLAUDE, "commands", path.basename(f)), target);
    }
    console.log(`  linked   ${repo.name}  ${commands.length} command(s) -> ${repo.path}/.claude/commands/`);
  }
}

// ------------------------------------------------------------------- link ----
if (LINK) {
  console.log("\nlinking this machine's harnesses to shared/ (source of truth, no copy to go stale):");
  const links = [
    ...skillDirs.map((s) => [path.join(SHARED, "skills", s), path.join(homedir(), ".codex/skills", s)]),
    ...skillDirs.map((s) => [path.join(SHARED, "skills", s), path.join(homedir(), ".gemini/skills", s)]),
    ...commands.map((f) => [path.join(CURSOR, "commands", path.basename(f)), path.join(homedir(), ".cursor/commands", path.basename(f))]),
  ];
  for (const [src, dst] of links) {
    mkdirSync(path.dirname(dst), { recursive: true });
    let existing = null;
    try { existing = lstatSync(dst); } catch {}
    if (existing) {
      if (!existing.isSymbolicLink()) { console.log(`  skip     ${dst}  (real file — not overwriting)`); continue; }
      unlinkSync(dst);
    }
    symlinkSync(src, dst);
    console.log(`  linked   ${dst.replace(homedir(), "~")}`);
  }
}
