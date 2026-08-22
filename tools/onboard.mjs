#!/usr/bin/env bun
/**
 * `factory onboard` — print the prompt that connects a repository to factory (#938).
 *
 *   factory onboard
 *   factory onboard --repo ~/Develop/myapp | pbcopy
 *   factory onboard --repo ~/Develop/myapp --control-plane linear
 *
 * Why a prompt and not an installer: connecting a repo needs judgement about
 * *that* repo — which branch is the integration branch, what the test command
 * actually is, whether a worktree lifecycle is needed, which files make an
 * honest first `Owned Paths`. A script can only ask or guess; the human's own
 * coding agent can look. Setup is the first ticket.
 *
 * `docs/onboarding/connect-repo.md` is the single copy of that prompt — the
 * docs site renders the same file, and this command prints it. Everything here
 * is substitution and tracker selection on top of it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PROMPT_PATH = "docs/onboarding/connect-repo.md";
export const CONTROL_PLANES = Object.freeze(["github", "linear"]);

const OPEN = /^<!--\s*factory:onboard:([a-z-]+)\s*-->$/;
const CLOSE = /^<!--\s*\/factory:onboard\s*-->$/;

const HELP = `factory onboard — print the prompt that connects a repository to factory

Usage:
  factory onboard [options]

Paste the output into your coding agent (Claude Code, Codex, Gemini, Cursor,
Pi, Agy) with the target repository open. It walks the agent through wiring
factory to that repo and ends at a machine-checked gate: the connection is not
done until \`factory doctor\` and \`factory queue\` are green.

Options:
  --repo <path>              Target repository. Fills in its path, short name,
                             and OWNER/REPO from its origin remote.
  --control-plane <kind>     github (default) or linear — keeps only that
                             tracker's steps.
  --factory-root <path>      This checkout (default: ${ROOT}).
  --help, -h                 Show this help

Examples:
  factory onboard --repo ~/Develop/myapp | pbcopy
  factory onboard --repo ~/Develop/myapp --control-plane linear > /tmp/onboard.md
`;

/**
 * Drop the blocks belonging to the other tracker.
 *
 * Marker-delimited rather than heading-driven so that step numbers and the
 * prose cross-references to them ("see step 8") survive: every numbered step
 * exists in both variants, only its body differs.
 */
export function selectControlPlane(source, controlPlane) {
  if (!CONTROL_PLANES.includes(controlPlane)) {
    throw new Error(
      `unknown control plane ${JSON.stringify(controlPlane)} (expected ${CONTROL_PLANES.join(", ")})`,
    );
  }
  const out = [];
  let open = null;
  for (const [i, line] of source.split("\n").entries()) {
    const start = line.match(OPEN);
    if (start) {
      if (open) {
        throw new Error(
          `${PROMPT_PATH}:${i + 1}: nested factory:onboard block (${open} still open)`,
        );
      }
      if (!CONTROL_PLANES.includes(start[1])) {
        throw new Error(
          `${PROMPT_PATH}:${i + 1}: unknown block ${JSON.stringify(start[1])}`,
        );
      }
      open = start[1];
      continue;
    }
    if (CLOSE.test(line)) {
      if (!open) {
        throw new Error(`${PROMPT_PATH}:${i + 1}: unmatched closing marker`);
      }
      open = null;
      continue;
    }
    if (!open || open === controlPlane) out.push(line);
  }
  if (open) {
    throw new Error(`${PROMPT_PATH}: unclosed ${open} block`);
  }
  // Removing a block leaves the blank lines that surrounded its markers.
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Substitute the placeholders we have real answers for. An unknown value keeps
 * its placeholder: `<OWNER/REPO>` left in the text tells the agent to go find
 * it, whereas a plausible guess would be followed without question.
 */
export function fillPlaceholders(source, values = {}) {
  const map = {
    "<TARGET_REPO_PATH>": values.repoPath,
    "<FACTORY_ROOT>": values.factoryRoot,
    "<OWNER/REPO>": values.github,
    "<short-name>": values.name,
  };
  let out = source;
  for (const [token, value] of Object.entries(map)) {
    if (!value) continue;
    out = out.split(token).join(value);
  }
  return out;
}

export function renderOnboarding(source, options = {}) {
  const { controlPlane = "github", ...values } = options;
  return fillPlaceholders(selectControlPlane(source, controlPlane), values);
}

/** `~/x` → `$HOME/x`, then absolute. */
export function resolvePath(
  input,
  { home = homedir(), cwd = process.cwd() } = {},
) {
  const expanded =
    input === "~" || input.startsWith("~/")
      ? path.join(home, input.slice(1))
      : input;
  return path.resolve(cwd, expanded);
}

/** `git@github.com:owner/repo.git` and the https form → `owner/repo`. */
export function parseRemote(url) {
  if (!url) return null;
  const m = url
    .trim()
    .replace(/\.git$/, "")
    .match(/github\.com[:/]([^/]+\/[^/]+)$/);
  return m ? m[1] : null;
}

function originRemote(repoPath) {
  const res = spawnSync(
    "git",
    ["-C", repoPath, "remote", "get-url", "origin"],
    {
      encoding: "utf8",
    },
  );
  return res.status === 0 ? parseRemote(res.stdout) : null;
}

function die(message) {
  console.error(`factory onboard: ${message}`);
  process.exit(1);
}

export function main(argv = process.argv.slice(2), { root = ROOT } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repo: { type: "string" },
        "control-plane": { type: "string", default: "github" },
        "factory-root": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    die(`${err.message}\n\n${HELP}`);
    return;
  }
  const { values } = parsed;
  if (values.help) {
    console.log(HELP);
    return;
  }

  const controlPlane = values["control-plane"];
  if (!CONTROL_PLANES.includes(controlPlane)) {
    die(
      `unknown control plane ${JSON.stringify(controlPlane)} (expected ${CONTROL_PLANES.join(", ")})`,
    );
    return;
  }

  let repoPath = null;
  let name = null;
  let github = null;
  if (values.repo) {
    repoPath = resolvePath(values.repo);
    if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
      die(`no such directory: ${repoPath}`);
      return;
    }
    name = path.basename(repoPath);
    github = originRemote(repoPath);
  }

  const promptFile = path.join(root, PROMPT_PATH);
  if (!existsSync(promptFile)) {
    die(`missing ${PROMPT_PATH} in ${root}`);
    return;
  }

  process.stdout.write(
    renderOnboarding(readFileSync(promptFile, "utf8"), {
      controlPlane,
      repoPath,
      factoryRoot: values["factory-root"]
        ? resolvePath(values["factory-root"])
        : root,
      github,
      name,
    }),
  );
}

if (import.meta.main) main();
