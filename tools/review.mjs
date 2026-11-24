#!/usr/bin/env bun
/**
 * `factory review` — PR review wrapper with ANTHROPIC_API_KEY scrubbing (GH-2448).
 *
 *   factory review --pr 123
 *   factory review --pr 123 --repo watt-mind/factory
 *   factory review --pr 123 --harness codex --model o3
 *   factory review --pr 123 --dry-run
 *
 * Solves F-5 in interactive sessions: piping `gh pr diff <N> | claude -p ...`
 * fails with `Invalid API key` when the shell inherits `ANTHROPIC_API_KEY`.
 * This wrapper fetches PR metadata and diff via `gh`, scrubs provider API keys
 * (matching `runners/run-agent.sh`) unless `--use-api` is explicitly passed,
 * and streams the reviewer harness output while propagating its exit code.
 */
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

export const HARNESSES = Object.freeze(["claude", "codex", "agy"]);
export const DEFAULT_HARNESS = "claude";
export const DEFAULT_MODELS = Object.freeze({
  claude: "opus",
});

/**
 * Provider API keys scrubbed by default so reviewer harnesses authenticate via
 * subscription/login rather than per-token API billing (F-5, matching
 * `runners/run-agent.sh`).
 */
export const SCRUBBED_API_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "OPENAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
]);

/**
 * Nested-session markers always removed so launching a reviewer from inside an
 * interactive Claude Code session does not fail immediately.
 */
export const NESTED_SESSION_KEYS = Object.freeze([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
]);

export const DEFAULT_PROMPT =
  "Review this pull request diff for correctness, security, edge cases, and adherence to repository conventions. Cite specific files and line numbers for any findings, and end with a clear verdict (SHIP or REQUEST CHANGES).";

export const HELP = `factory review — run a PR review harness with ANTHROPIC_API_KEY scrubbing

Usage:
  factory review --pr <N> [options]

Options:
  --pr <N>                   Pull request number (required)
  --repo <owner/repo>        Target GitHub repository (forwarded to gh)
  --harness <name>           Reviewer harness: claude (default), codex, or agy
  --model <name>             Model override (default: opus for claude; omitted for codex/agy)
  --prompt <text>            Custom review prompt
  --use-api                  Preserve provider API keys (including ANTHROPIC_API_KEY)
  --dry-run                  Print resolved command and scrubbed env summary without running
  --help, -h                 Show this help

Examples:
  factory review --pr 2448
  factory review --pr 2448 --repo watt-mind/factory --dry-run
  factory review --pr 2448 --harness codex
`;

const PR_NUMBER_RE = /^[1-9]\d*$/;
const REPO_SLUG_RE = /^[^/\s]+\/[^/\s]+$/;

export function parseReviewArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      harness: { type: "string", default: DEFAULT_HARNESS },
      model: { type: "string" },
      prompt: { type: "string" },
      "use-api": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    return { help: true };
  }

  const prRaw = values.pr?.trim();
  if (!prRaw) {
    throw new Error("--pr <N> is required");
  }
  if (!PR_NUMBER_RE.test(prRaw)) {
    throw new Error(
      `invalid --pr value ${JSON.stringify(values.pr)} (expected a positive integer)`,
    );
  }

  const repo = values.repo?.trim() || null;
  if (values.repo !== undefined && (!repo || !REPO_SLUG_RE.test(repo))) {
    throw new Error(
      `invalid --repo value ${JSON.stringify(values.repo)} (expected owner/repo)`,
    );
  }

  const harness = values.harness;
  if (!HARNESSES.includes(harness)) {
    throw new Error(
      `unknown --harness ${JSON.stringify(harness)} (expected ${HARNESSES.join(", ")})`,
    );
  }

  const explicitModel = values.model?.trim() || null;
  const model = explicitModel ?? DEFAULT_MODELS[harness] ?? null;
  const prompt = values.prompt?.trim() ? values.prompt : DEFAULT_PROMPT;

  return {
    help: false,
    pr: Number(prRaw),
    repo,
    harness,
    model,
    prompt,
    useApi: Boolean(values["use-api"]),
    dryRun: Boolean(values["dry-run"]),
  };
}

/**
 * Build the child process environment for the reviewer harness.
 * Deletes ANTHROPIC_API_KEY (and other provider keys) by default so the CLI
 * uses subscription auth (F-5), unless `useApi` is true.
 */
export function buildReviewerEnv(
  baseEnv = process.env,
  { useApi = false } = {},
) {
  const env = { ...baseEnv };
  const scrubbed = [];

  for (const key of NESTED_SESSION_KEYS) {
    if (key in env) {
      delete env[key];
    }
  }

  if (!useApi) {
    for (const key of SCRUBBED_API_KEYS) {
      if (key in env) {
        scrubbed.push(key);
        delete env[key];
      }
    }
  }

  return {
    env,
    scrubbed,
    authMode: useApi ? "api-key" : "subscription",
  };
}

export function buildGhViewArgs({ pr, repo = null }) {
  const args = [
    "pr",
    "view",
    String(pr),
    "--json",
    "number,title,body,baseRefName,headRefName,url,author",
  ];
  if (repo) {
    args.push("--repo", repo);
  }
  return args;
}

export function buildGhDiffArgs({ pr, repo = null }) {
  const args = ["pr", "diff", String(pr)];
  if (repo) {
    args.push("--repo", repo);
  }
  return args;
}

export function buildHarnessCommand({ harness, model = null, prompt }) {
  if (harness === "claude") {
    const args = ["-p"];
    if (model) {
      args.push("--model", model);
    }
    args.push(prompt);
    return { cmd: "claude", args };
  }
  if (harness === "codex") {
    const args = ["exec"];
    if (model) {
      args.push("--model", model);
    }
    args.push("-");
    return { cmd: "codex", args };
  }
  if (harness === "agy") {
    const args = ["-p", "-"];
    if (model) {
      args.push("--model", model);
    }
    return { cmd: "agy", args };
  }
  throw new Error(
    `unknown harness ${JSON.stringify(harness)} (expected ${HARNESSES.join(", ")})`,
  );
}

export function formatPrContext({ pr, metadata, diff }) {
  const lines = [];
  if (metadata && typeof metadata === "object") {
    const num = metadata.number ?? pr;
    const title = metadata.title ?? "";
    lines.push(`# PR #${num}${title ? `: ${title}` : ""}`);
    if (metadata.url) lines.push(`URL: ${metadata.url}`);
    if (metadata.author?.login) lines.push(`Author: ${metadata.author.login}`);
    if (metadata.baseRefName || metadata.headRefName) {
      lines.push(
        `Branch: ${metadata.headRefName ?? "?"} -> ${metadata.baseRefName ?? "?"}`,
      );
    }
    if (metadata.body && metadata.body.trim()) {
      lines.push("", "## Description", metadata.body.trim());
    }
  } else {
    lines.push(`# PR #${pr}`);
  }
  lines.push("", "## Diff", diff ?? "");
  return lines.join("\n");
}

export function buildReviewStdin({ harness, prompt, pr, metadata, diff }) {
  const context = formatPrContext({ pr, metadata, diff });
  if (harness === "claude") {
    return context;
  }
  return `${prompt}\n\n${context}`;
}

function shellQuote(arg) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function formatDryRun({ options, envResult, harnessCmd }) {
  const ghView = ["gh", ...buildGhViewArgs(options)].map(shellQuote).join(" ");
  const ghDiff = ["gh", ...buildGhDiffArgs(options)].map(shellQuote).join(" ");
  const command = [harnessCmd.cmd, ...harnessCmd.args]
    .map(shellQuote)
    .join(" ");

  const envLine = options.useApi
    ? "api-key (--use-api; provider API keys preserved)"
    : envResult.scrubbed.length > 0
      ? `subscription (scrubbed: ${envResult.scrubbed.join(", ")})`
      : "subscription (no provider API keys present in env; ANTHROPIC_API_KEY scrubbed if set)";

  const lines = [
    `PR:      #${options.pr}${options.repo ? ` (${options.repo})` : ""}`,
    `Harness: ${options.harness}${options.model ? ` (model: ${options.model})` : ""}`,
    `Auth:    ${envLine}`,
    `Fetch:   ${ghView}`,
    `Diff:    ${ghDiff}`,
    `Command: ${command}`,
  ];
  return `${lines.join("\n")}\n`;
}

function defaultRunGh(args, { env }) {
  const res = spawnSync("gh", args, {
    encoding: "utf8",
    env,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (res.error) {
    return {
      exitCode: res.error.code === "ENOENT" ? 127 : 1,
      stdout: "",
      stderr: res.error.message,
    };
  }
  return {
    exitCode: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function defaultRunHarness({ cmd, args, env, stdin }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env,
      stdio: ["pipe", "inherit", "inherit"],
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.on("error", (err) => {
      finish({
        exitCode: err.code === "ENOENT" ? 127 : 1,
        error: err,
      });
    });
    child.on("close", (code, signal) => {
      if (code !== null) {
        finish({ exitCode: code });
      } else {
        finish({ exitCode: 1, signal });
      }
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
  });
}

export async function runReview(
  argv = process.argv.slice(2),
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    runGh = defaultRunGh,
    runHarness = defaultRunHarness,
  } = {},
) {
  let options;
  try {
    options = parseReviewArgs(argv);
  } catch (err) {
    stderr.write(`factory review: ${err.message}\n\n${HELP}`);
    return 2;
  }

  if (options.help) {
    stdout.write(HELP);
    return 0;
  }

  const envResult = buildReviewerEnv(env, { useApi: options.useApi });
  const harnessCmd = buildHarnessCommand({
    harness: options.harness,
    model: options.model,
    prompt: options.prompt,
  });

  if (options.dryRun) {
    stdout.write(formatDryRun({ options, envResult, harnessCmd }));
    return 0;
  }

  const viewRes = await runGh(buildGhViewArgs(options), { env });
  if (viewRes.exitCode !== 0) {
    const detail = viewRes.stderr?.trim() || `exit ${viewRes.exitCode}`;
    stderr.write(`factory review: gh pr view failed: ${detail}\n`);
    return viewRes.exitCode;
  }

  let metadata = null;
  try {
    metadata = JSON.parse(viewRes.stdout);
  } catch {
    // Non-JSON gh output falls back to PR number header only.
  }

  const diffRes = await runGh(buildGhDiffArgs(options), { env });
  if (diffRes.exitCode !== 0) {
    const detail = diffRes.stderr?.trim() || `exit ${diffRes.exitCode}`;
    stderr.write(`factory review: gh pr diff failed: ${detail}\n`);
    return diffRes.exitCode;
  }

  const stdin = buildReviewStdin({
    harness: options.harness,
    prompt: options.prompt,
    pr: options.pr,
    metadata,
    diff: diffRes.stdout,
  });

  const result = await runHarness({
    cmd: harnessCmd.cmd,
    args: harnessCmd.args,
    env: envResult.env,
    stdin,
  });

  if (result.error) {
    stderr.write(
      `factory review: failed to launch ${harnessCmd.cmd}: ${result.error.message}\n`,
    );
  }

  return result.exitCode;
}

if (import.meta.main) {
  const code = await runReview();
  process.exit(code);
}
