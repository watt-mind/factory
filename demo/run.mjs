#!/usr/bin/env bun
/**
 * factory demo — 15-minute quickstart (WM-799).
 *
 * Runs the bundled starter ticket (DEMO-1) end-to-end against `demo/repo/`
 * using an in-memory control plane and the memory forge. No Linear, GitHub,
 * or model credentials.
 *
 *   bin/factory demo [--harness <adapter>] [--dry]
 *
 * `--dry` validates the fixture and prints the plan. The full run copies the
 * bundled repo to a temp git checkout, claims the ticket, applies the canned
 * fake-harness patch, verifies, opens a memory PR, and merges it.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { applyStarterPatch } from "./agent.mjs";
import { DEMO_LABELS, memoryControlPlane } from "./memory-plane.mjs";
import { memoryForge } from "../lib/forge/memory.mjs";
import { parseOwnedPaths } from "../orchestrator/owned-paths.mjs";

export const DEMO_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_REPO = path.join(DEMO_ROOT, "repo");
export const STARTER_TICKET = "DEMO-1";
export const DEMO_TEAM = "DEMO";
export const DEMO_GITHUB = "factory/demo-repo";

export const HARNESSES = Object.freeze([
  "fake",
  "claude",
  "codex",
  "pi",
  "gemini",
  "cursor",
  "agy",
]);

const TICKET_PATH = path.join("tickets", `${STARTER_TICKET}.md`);

function fail(message, code = 1) {
  console.error(`factory demo: ${message}`);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  const status = result.status ?? result.exitCode ?? null;
  if (status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    const stdout = String(result.stdout ?? "").trim();
    const detail =
      stderr || stdout || result.error?.message || `exit ${status}`;
    throw new Error(`${cmd} ${args.join(" ")}: ${detail}`);
  }
  return result;
}

export function parseArgs(argv) {
  const out = { dry: false, harness: "fake", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry":
        out.dry = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--harness": {
        const value = argv[i + 1];
        if (!value || value.startsWith("-")) {
          throw new Error("--harness requires an adapter name");
        }
        out.harness = value;
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown option '${arg}' (try: factory demo --help)`);
    }
  }
  if (!HARNESSES.includes(out.harness)) {
    throw new Error(
      `unknown harness '${out.harness}' — want one of: ${HARNESSES.join(", ")}`,
    );
  }
  return out;
}

export function loadStarterTicket(repoDir = BUNDLED_REPO) {
  const file = path.join(repoDir, TICKET_PATH);
  if (!existsSync(file)) {
    throw new Error(`missing starter ticket ${TICKET_PATH}`);
  }
  const markdown = readFileSync(file, "utf8");
  const titleLine = markdown.split("\n").find((line) => line.startsWith("# "));
  const title = (titleLine ?? "")
    .replace(/^#\s+/, "")
    .replace(new RegExp(`^${STARTER_TICKET}\\s+`), "")
    .trim();
  const ownedPaths = parseOwnedPaths(markdown);
  const verifyMatch = markdown.match(
    /## Verification Command\s+```(?:\w+)?\s*([\s\S]*?)```/i,
  );
  const verification = (verifyMatch?.[1] ?? "").trim();
  if (!title) throw new Error("starter ticket has no title");
  if (!ownedPaths.length) {
    throw new Error("starter ticket has no parseable Owned Paths");
  }
  if (!verification) {
    throw new Error("starter ticket has no Verification Command");
  }
  return {
    identifier: STARTER_TICKET,
    title,
    description: markdown,
    ownedPaths,
    verification,
  };
}

function seedLabels() {
  return [
    { id: "lab-ready", name: DEMO_LABELS.AGENT_READY },
    { id: "lab-progress", name: DEMO_LABELS.IN_PROGRESS },
    { id: "lab-review", name: DEMO_LABELS.NEEDS_REVIEW },
    { id: "lab-type", name: "type:feature" },
    { id: "lab-source", name: "source:human" },
    { id: "lab-fake", name: "agent:fake" },
    { id: "lab-claude", name: "agent:claude-code" },
    { id: "lab-codex", name: "agent:codex" },
    { id: "lab-pi", name: "agent:pi" },
    { id: "lab-gemini", name: "agent:gemini" },
    { id: "lab-cursor", name: "agent:cursor" },
    { id: "lab-agy", name: "agent:agy" },
  ];
}

export function seedDemoPlane(ticket) {
  return memoryControlPlane({
    viewer: { id: "user-demo", name: "Demo Operator" },
    team: { id: "team-demo", key: DEMO_TEAM },
    labels: seedLabels(),
    tickets: [
      {
        id: "mem-demo-1",
        identifier: ticket.identifier,
        title: ticket.title,
        description: ticket.description,
        url: `memory://${ticket.identifier}`,
        state: { id: "s-todo", name: "Todo" },
        assignee: null,
        team: { key: DEMO_TEAM },
        project: { name: "demo" },
        labels: [
          { id: "lab-ready", name: DEMO_LABELS.AGENT_READY },
          { id: "lab-type", name: "type:feature" },
          { id: "lab-source", name: "source:human" },
        ],
        comments: [],
      },
    ],
  });
}

function helpText() {
  return `factory demo — run the bundled starter ticket with no third-party credentials

  bin/factory demo [--harness <adapter>] [--dry]

  --dry              validate the fixture and print the plan (CI)
  --harness <name>   adapter recorded on the ticket (${HARNESSES.join(", ")})
                     default: fake. The 15-minute path always applies the
                     bundled patch; a real coding agent is not required.

  Isolated event-runtime env (unchanged):
  bin/factory demo --here [--reseed]
  bin/factory demo --down
`;
}

function printPlan(ticket, harness, dry) {
  const lines = [
    `ticket:     ${ticket.identifier}  ${ticket.title}`,
    `harness:    ${harness}`,
    `repo:       ${BUNDLED_REPO}`,
    `owned:      ${ticket.ownedPaths.join(", ")}`,
    `verify:     ${ticket.verification}`,
    `control:    memory`,
    `forge:      memory (${DEMO_GITHUB})`,
    `mode:       ${dry ? "dry-run (plan only)" : "end-to-end"}`,
    "",
    "steps:",
    "  1. list dispatchable (Todo + ai:agent-ready + unassigned)",
    "  2. claim → In Progress",
    "  3. worktree-up",
    "  4. fake harness applies greet()",
    "  5. run Verification Command",
    "  6. open PR on the memory forge",
    "  7. merge and mark Done",
  ];
  console.log(lines.join("\n"));
}

function initTempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-demo-"));
  cpSync(BUNDLED_REPO, dir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`),
  });
  run("git", ["init", "-q"], { cwd: dir });
  run("git", ["config", "user.email", "demo@factory.local"], { cwd: dir });
  run("git", ["config", "user.name", "factory demo"], { cwd: dir });
  run("git", ["add", "-A"], { cwd: dir });
  run("git", ["commit", "-q", "-m", "chore: bundled demo repo"], { cwd: dir });
  return dir;
}

function lastNonEmptyLine(text) {
  const lines = String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

function worktreeUp(repoDir, ticket) {
  const script = path.join(repoDir, "bin", "worktree-up.sh");
  const result = run("bash", [script, ticket], { cwd: repoDir });
  const dest = lastNonEmptyLine(result.stdout);
  if (!dest || !existsSync(dest)) {
    throw new Error(`worktree-up did not print a checkout path`);
  }
  return dest;
}

function worktreeDown(repoDir, ticket) {
  const script = path.join(repoDir, "bin", "worktree-down.sh");
  run("bash", [script, ticket], { cwd: repoDir });
}

function commitWorktree(worktreeDir, message, ownedPaths) {
  run("git", ["add", "--", ...ownedPaths], { cwd: worktreeDir });
  run("git", ["commit", "-q", "-m", message], { cwd: worktreeDir });
  const sha = run("git", ["rev-parse", "HEAD"], {
    cwd: worktreeDir,
  }).stdout.trim();
  const files = run(
    "git",
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
    {
      cwd: worktreeDir,
    },
  )
    .stdout.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { sha, files };
}

function verifyWorktree(worktreeDir, command) {
  const result = spawnSync("bash", ["-lc", command], {
    cwd: worktreeDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const status = result.status ?? result.exitCode ?? null;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (status !== 0) {
    throw new Error(
      `verification \`${command}\` failed (exit ${status})\n${output}`,
    );
  }
  return { command, passed: true, output };
}

function openMemoryPr(forge, { sha, files, ticket }) {
  const repo = forge.seed.repos[DEMO_GITHUB];
  const number = (repo.prs.at(-1)?.number ?? 0) + 1;
  const pr = {
    number,
    state: "OPEN",
    isDraft: false,
    labels: [],
    headRefName: `feat/${ticket.identifier}`,
    headRefOid: sha,
    title: ticket.title,
    body: `Fixes ${ticket.identifier}\n\nUX critique: skipped — CLI quickstart, no web surface.`,
    url: `memory://${DEMO_GITHUB}/pull/${number}`,
    files,
    comments: [],
  };
  repo.prs.push(pr);
  forge.calls.push({ op: "prCreate", repo: DEMO_GITHUB, number });
  return pr;
}

/**
 * @param {{ dry?: boolean, harness?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function runDemo({ dry = false, harness = "fake" } = {}) {
  const ticket = loadStarterTicket();
  for (const rel of [
    "bin/worktree-up.sh",
    "bin/worktree-down.sh",
    TICKET_PATH,
  ]) {
    if (!existsSync(path.join(BUNDLED_REPO, rel))) {
      throw new Error(`bundled repo is missing ${rel}`);
    }
  }

  printPlan(ticket, harness, dry);
  if (dry) {
    const plane = seedDemoPlane(ticket);
    const ready = await plane.listDispatchable({ team: DEMO_TEAM });
    if (!ready.some((t) => t.identifier === ticket.identifier)) {
      throw new Error(
        `${ticket.identifier} is not dispatchable in the memory plane`,
      );
    }
    console.log("\ndry-run ok — fixture is dispatchable, no worktree created.");
    return { dry: true, ticket: ticket.identifier, harness };
  }

  const repoDir = initTempRepo();
  const plane = seedDemoPlane(ticket);
  const forge = memoryForge({
    repos: { [DEMO_GITHUB]: { prs: [], runs: [] } },
    defaultRepo: DEMO_GITHUB,
  });
  try {
    const ready = await plane.listDispatchable({ team: DEMO_TEAM });
    if (!ready.some((t) => t.identifier === ticket.identifier)) {
      throw new Error(`${ticket.identifier} is not dispatchable`);
    }
    console.log(`dispatchable: ${ticket.identifier}`);

    const claimed = await plane.claim(ticket.identifier, { harness });
    if (!claimed.ok) {
      throw new Error(`lost claim race on ${ticket.identifier}`);
    }
    console.log(`claimed ${ticket.identifier} as ${claimed.assignee}`);

    await plane.comment(
      ticket.identifier,
      `## Approach\n\nFake harness applies the bundled greet() patch in this worktree. Harness recorded: ${harness}.`,
    );

    const worktreeDir = worktreeUp(repoDir, ticket.identifier);
    console.log(`worktree: ${worktreeDir}`);

    applyStarterPatch(worktreeDir);
    const { sha, files } = commitWorktree(
      worktreeDir,
      `feat: greet a caller by name (${ticket.identifier})`,
      ticket.ownedPaths,
    );
    console.log(`implemented ${files.length} file(s) @ ${sha.slice(0, 7)}`);

    const verification = verifyWorktree(worktreeDir, ticket.verification);
    const verifyTail = verification.output.split("\n").slice(-3).join(" / ");
    console.log(`verify: ${ticket.verification} — pass, ${verifyTail}`);

    const pr = openMemoryPr(forge, { sha, files, ticket });
    forge.prComment(
      DEMO_GITHUB,
      pr.number,
      `## Handoff\n- Verification: \`${ticket.verification}\` — pass\n- Files: ${files.join(", ")}`,
    );
    console.log(`PR: ${pr.url}`);

    await plane.comment(
      ticket.identifier,
      `## Handoff\n- PR: ${pr.url}\n- Verification: \`${ticket.verification}\` — pass\n- UX critique: skipped — CLI quickstart, no web surface\n- Files: ${files.length} changed, all within Owned Paths\n- Risks: none known`,
    );
    await plane.transition(ticket.identifier, "In Review", {
      add: [DEMO_LABELS.NEEDS_REVIEW],
      remove: [DEMO_LABELS.IN_PROGRESS],
    });

    const merged = forge.seed.repos[DEMO_GITHUB].prs.find(
      (p) => p.number === pr.number,
    );
    merged.state = "MERGED";
    forge.calls.push({ op: "prMerge", repo: DEMO_GITHUB, number: pr.number });
    await plane.transition(ticket.identifier, "Done", {
      remove: [DEMO_LABELS.NEEDS_REVIEW],
    });
    console.log(`merged PR #${pr.number}; ${ticket.identifier} → Done`);

    const done = await plane.getTicket(ticket.identifier);
    return {
      dry: false,
      ticket: ticket.identifier,
      harness,
      worktree: worktreeDir,
      sha,
      files,
      pr: { number: pr.number, url: pr.url, state: merged.state },
      ticketState: done.state?.name,
      verification,
      plane,
      forge,
    };
  } finally {
    try {
      worktreeDown(repoDir, ticket.identifier);
    } catch {
      /* teardown is best-effort */
    }
    rmSync(repoDir, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    fail(err.message, 2);
  }
  if (opts.help) {
    console.log(helpText());
    return;
  }
  return runDemo(opts).catch((err) => fail(err.message));
}

if (import.meta.main) {
  await main();
}
