#!/usr/bin/env bun
/**
 * Multi-harness competitive Arena runner (`factory arena`, GH-2426).
 *
 * Reads node-local configuration from `~/.factory/arena.yaml` (falling back
 * to `config/arena.example.yaml`), resolves installed CLI harnesses (`codex`,
 * `claude`, `agy`, `pi`, `cursor`) with optional per-runner fallback, fans out
 * isolated candidate runs in parallel (in `$TMPDIR` sandboxes or detached git
 * worktrees), invokes a vendor-independent read-only cross-judge, and cleans
 * up temporary worktrees on demand without ever touching `git stash`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROVIDER_CREDENTIAL_ENV } from "../event-runtime/lib/adapters/child-env.mjs";

const DEFAULT_ROOT = path.resolve(import.meta.dir, "..");

const HARNESS_BINARIES = Object.freeze({
  codex: ["codex"],
  claude: ["claude"],
  agy: ["agy"],
  pi: ["pi"],
  cursor: ["agent", "cursor-agent"],
});

const VENDOR_ALIASES = Object.freeze({
  claude: "anthropic",
  fable: "anthropic",
  opus: "anthropic",
  sonnet: "anthropic",
  haiku: "anthropic",
  anthropic: "anthropic",
  codex: "openai",
  openai: "openai",
  gpt: "openai",
  sol: "openai",
  terra: "openai",
  luna: "openai",
  agy: "google",
  gemini: "google",
  google: "google",
  carbon: "google",
  argon: "google",
  hydrogen: "google",
  cursor: "cursor",
});

/**
 * Normalize a harness, model, or vendor string to its vendor family.
 * Matches pstack's rule: Fable counts as Anthropic/Claude.
 */
export function normalizeVendor(value) {
  if (!value || typeof value !== "string") return "unknown";
  const lower = value.trim().toLowerCase();
  if (VENDOR_ALIASES[lower]) return VENDOR_ALIASES[lower];
  for (const [token, vendor] of Object.entries(VENDOR_ALIASES)) {
    if (lower.includes(token)) return vendor;
  }
  return lower.split(/[-_/]/)[0] || "unknown";
}

/**
 * Load `~/.factory/arena.yaml` if present, otherwise `config/arena.example.yaml`.
 */
export function loadArenaConfig({
  homeDir = homedir(),
  root = DEFAULT_ROOT,
  configPath = process.env.FACTORY_ARENA_CONFIG || null,
} = {}) {
  const userPath = path.join(homeDir, ".factory", "arena.yaml");
  const examplePath = path.join(root, "config", "arena.example.yaml");
  const resolvedPath =
    configPath || (existsSync(userPath) ? userPath : examplePath);

  if (!existsSync(resolvedPath)) {
    throw new Error(
      `arena config not found (checked ${userPath} and ${examplePath})`,
    );
  }
  const raw = readFileSync(resolvedPath, "utf8");
  const parsed = Bun.YAML.parse(raw) || {};
  return {
    source: resolvedPath,
    isExampleFallback: !configPath && !existsSync(userPath),
    defaults: {
      profile: parsed.defaults?.profile || "default",
      mode: parsed.defaults?.mode || "sandbox",
      min_runners: Number(parsed.defaults?.min_runners ?? 2),
      timeout_seconds: Number(parsed.defaults?.timeout_seconds ?? 600),
    },
    runners: parsed.runners || {},
    profiles: parsed.profiles || {},
    cross_judge_pool: Array.isArray(parsed.cross_judge_pool)
      ? parsed.cross_judge_pool
      : [],
  };
}

/**
 * Resolve the first available binary on PATH for a harness key.
 */
export function resolveHarnessBinary(harness, which = (cmd) => Bun.which(cmd)) {
  const candidates = HARNESS_BINARIES[harness] || [harness];
  for (const bin of candidates) {
    const resolved = which(bin);
    if (resolved) return { bin, path: resolved };
  }
  return null;
}

/**
 * Resolve a list of runner names against config and local PATH availability.
 * Falls back to `runner.fallback` if primary CLI is absent.
 */
export function resolveRunnerPlan(
  config,
  { profile, runnerNames, which = (cmd) => Bun.which(cmd) } = {},
) {
  const chosenNames =
    runnerNames && runnerNames.length > 0
      ? runnerNames
      : config.profiles[profile || config.defaults.profile] || [];

  if (chosenNames.length === 0) {
    throw new Error(
      `no runners configured for profile "${profile || config.defaults.profile}"`,
    );
  }

  return chosenNames.map((name) => {
    const spec = config.runners[name];
    if (!spec) {
      return {
        name,
        status: "skipped",
        reason: `runner "${name}" is not defined in arena config`,
      };
    }
    const primaryBin = resolveHarnessBinary(spec.harness, which);
    if (primaryBin) {
      return {
        name,
        status: "ready",
        harness: spec.harness,
        binary: primaryBin.bin,
        binaryPath: primaryBin.path,
        model: spec.model,
        effort: spec.effort || null,
        vendor: normalizeVendor(spec.vendor || spec.model || spec.harness),
        fallbackUsed: false,
      };
    }
    if (spec.fallback?.harness) {
      const fallbackBin = resolveHarnessBinary(spec.fallback.harness, which);
      if (fallbackBin) {
        return {
          name,
          status: "ready",
          harness: spec.fallback.harness,
          binary: fallbackBin.bin,
          binaryPath: fallbackBin.path,
          model: spec.fallback.model || spec.model,
          effort: spec.fallback.effort || spec.effort || null,
          vendor: normalizeVendor(
            spec.fallback.vendor || spec.vendor || spec.fallback.model,
          ),
          fallbackUsed: true,
        };
      }
    }
    return {
      name,
      status: "skipped",
      harness: spec.harness,
      model: spec.model,
      vendor: normalizeVendor(spec.vendor || spec.model || spec.harness),
      reason: `CLI binary for harness "${spec.harness}" not found on PATH`,
    };
  });
}

/**
 * Pick the first ready judge from `cross_judge_pool` whose vendor family
 * differs from `callerVendor` (or first ready judge if callerVendor is unknown).
 */
export function selectCrossJudge(
  config,
  {
    callerVendor = null,
    judgeName = null,
    which = (cmd) => Bun.which(cmd),
  } = {},
) {
  const normalizedCaller = callerVendor ? normalizeVendor(callerVendor) : null;
  const pool = judgeName ? [judgeName] : config.cross_judge_pool;

  for (const name of pool) {
    const [resolved] = resolveRunnerPlan(config, {
      runnerNames: [name],
      which,
    });
    if (!resolved || resolved.status !== "ready") continue;
    if (
      !judgeName &&
      normalizedCaller &&
      normalizedCaller !== "unknown" &&
      resolved.vendor === normalizedCaller
    ) {
      continue;
    }
    return { ...resolved, vendorCheckApplied: Boolean(normalizedCaller) };
  }
  return null;
}

/**
 * Build CLI command + argv for a runner. Prompt is always piped on stdin.
 */
export function buildHarnessInvocation({
  harness,
  binary,
  model,
  effort,
  workDir,
  readOnly = false,
  timeoutSeconds = 600,
}) {
  const bin = binary || (HARNESS_BINARIES[harness] || [harness])[0];
  switch (harness) {
    case "codex": {
      const args = ["exec", "--ephemeral", "--skip-git-repo-check"];
      if (model) args.push("-m", model);
      if (workDir) args.push("-C", workDir);
      args.push("-s", readOnly ? "read-only" : "workspace-write");
      args.push("-");
      return { command: bin, args };
    }
    case "claude": {
      const args = ["-p", "-", "--output-format", "text"];
      if (model && model !== "default") args.push("--model", model);
      if (readOnly) {
        args.push("--allowedTools", "Read,Grep,Glob,LS");
      } else {
        args.push("--dangerously-skip-permissions");
      }
      return { command: bin, args };
    }
    case "agy": {
      const args = ["-p", "-", "--output-format", "stream-json"];
      if (model && model !== "default") args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (workDir) args.push("--add-dir", workDir);
      if (timeoutSeconds > 5) {
        args.push("--print-timeout", `${Math.max(1, timeoutSeconds - 5)}s`);
      }
      if (!readOnly) {
        args.push("--dangerously-skip-permissions");
      } else {
        args.push("--mode", "plan");
      }
      return { command: bin, args };
    }
    case "pi": {
      const args = ["-p", "--mode", "json"];
      if (model && model !== "default") args.push("--model", model);
      if (readOnly) {
        args.push("--tools", "read,grep,find,ls");
      }
      return { command: bin, args };
    }
    case "cursor": {
      const args = ["-p", "--output-format", "json"];
      if (model && model !== "default") args.push("--model", model);
      if (workDir) args.push("--workspace", workDir);
      if (!readOnly) args.push("--force");
      return { command: bin, args };
    }
    default:
      throw new Error(`unsupported arena harness "${harness}"`);
  }
}

/**
 * Strip provider API keys and nested-session markers so CLIs use subscription
 * OAuth and never inherit the parent interactive Claude session.
 */
export function sanitizedChildEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of PROVIDER_CREDENTIAL_ENV) {
    delete env[key];
  }
  return env;
}

function runSubprocess({
  command,
  args,
  cwd,
  stdinText,
  timeoutMs,
  stdoutPath,
  stderrPath,
}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: sanitizedChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (stdoutPath) writeFileSync(stdoutPath, stdout);
      if (stderrPath) writeFileSync(stderrPath, `${stderr}\n${err.message}`);
      resolve({
        exitCode: 1,
        timedOut: false,
        durationMs: Date.now() - start,
        error: err.message,
        stdout,
        stderr,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdoutPath) writeFileSync(stdoutPath, stdout);
      if (stderrPath) writeFileSync(stderrPath, stderr);
      resolve({
        exitCode: code ?? 1,
        timedOut,
        durationMs: Date.now() - start,
        stdout,
        stderr,
      });
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function prepareCandidateWorkspace({ mode, outDir, name, repoDir, baseRef }) {
  const candidateDir = path.join(outDir, `candidate-${name}`);
  if (mode === "worktree") {
    const res = spawnSync(
      "git",
      ["worktree", "add", "--detach", candidateDir, baseRef || "HEAD"],
      { cwd: repoDir, encoding: "utf8" },
    );
    if (res.status !== 0) {
      throw new Error(
        `git worktree add failed for ${name}: ${res.stderr || res.stdout}`,
      );
    }
    return { workDir: candidateDir, isWorktree: true };
  }
  mkdirSync(candidateDir, { recursive: true });
  return { workDir: candidateDir, isWorktree: false };
}

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const subcommand =
    args[0] && !args[0].startsWith("-") ? args.shift() : "help";
  const flags = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      flags._.push(token);
      continue;
    }
    const eqIdx = token.indexOf("=");
    if (eqIdx !== -1) {
      flags[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      continue;
    }
    const key = token.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { subcommand, flags };
}

function printHelp() {
  console.log(`factory arena — multi-harness competitive bakeoff runner

Usage:
  factory arena config [--json]
  factory arena run --prompt-file <path> [--profile default|full] [--runners a,b,c]
                    [--mode sandbox|worktree] [--repo-dir <dir>] [--base <ref>]
                    [--out-dir <dir>] [--timeout <sec>] [--dry-run] [--json]
  factory arena judge --manifest <path> --rubric-file <path>
                      [--caller-vendor <vendor>] [--judge <name>] [--dry-run] [--json]
  factory arena cleanup --manifest <path> [--json]
`);
}

async function handleRun(flags) {
  const config = loadArenaConfig({ configPath: flags.config || null });
  const profile = flags.profile || config.defaults.profile;
  const mode = flags.mode || config.defaults.mode;
  const timeoutSeconds = Number(
    flags.timeout || config.defaults.timeout_seconds,
  );
  const runnerNames = flags.runners
    ? String(flags.runners)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  if (!flags["prompt-file"]) {
    throw new Error("--prompt-file is required");
  }
  const promptText = readFileSync(String(flags["prompt-file"]), "utf8");
  const plan = resolveRunnerPlan(config, { profile, runnerNames });
  const ready = plan.filter((r) => r.status === "ready");
  const skipped = plan.filter((r) => r.status !== "ready");

  if (!flags["dry-run"] && ready.length < config.defaults.min_runners) {
    throw new Error(
      `only ${ready.length} runner(s) available (need >= ${config.defaults.min_runners}); skipped: ${skipped.map((s) => `${s.name}:${s.reason}`).join(", ")}`,
    );
  }

  const outDir = flags["out-dir"]
    ? path.resolve(String(flags["out-dir"]))
    : mkdtempSync(path.join(tmpdir(), "factory-arena-"));
  mkdirSync(outDir, { recursive: true });

  const repoDir = path.resolve(String(flags["repo-dir"] || process.cwd()));
  const baseRef = String(flags.base || "HEAD");

  if (flags["dry-run"]) {
    const preview = {
      configSource: config.source,
      profile,
      mode,
      outDir,
      ready,
      skipped,
    };
    console.log(
      flags.json
        ? JSON.stringify(preview, null, 2)
        : `Dry run (${profile}, ${mode}): ${ready.map((r) => `${r.name}[${r.harness}:${r.model}]`).join(", ")}`,
    );
    return;
  }

  const candidates = await Promise.all(
    ready.map(async (runner) => {
      const ws = prepareCandidateWorkspace({
        mode,
        outDir,
        name: runner.name,
        repoDir,
        baseRef,
      });
      const candidatePrompt = `${promptText.trim()}

---
Arena candidate instructions:
- Candidate label: ${runner.name}
- Working/output directory: ${ws.workDir}
- Write your solution artifacts inside ${ws.workDir}.
- Also write a concise rationale in ${path.join(ws.workDir, "RATIONALE.md")} naming alternatives considered and what you rejected.`;

      const inv = buildHarnessInvocation({
        harness: runner.harness,
        binary: runner.binaryPath || runner.binary,
        model: runner.model,
        effort: runner.effort,
        workDir: ws.workDir,
        readOnly: false,
        timeoutSeconds,
      });
      const stdoutPath = path.join(outDir, `${runner.name}.stdout.log`);
      const stderrPath = path.join(outDir, `${runner.name}.stderr.log`);
      const res = await runSubprocess({
        command: inv.command,
        args: inv.args,
        cwd: ws.workDir,
        stdinText: candidatePrompt,
        timeoutMs: timeoutSeconds * 1000,
        stdoutPath,
        stderrPath,
      });
      return {
        ...runner,
        workDir: ws.workDir,
        isWorktree: ws.isWorktree,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        durationMs: res.durationMs,
        stdoutPath,
        stderrPath,
        succeeded: res.exitCode === 0 && !res.timedOut,
      };
    }),
  );

  const manifest = {
    createdAt: new Date().toISOString(),
    configSource: config.source,
    profile,
    mode,
    repoDir: mode === "worktree" ? repoDir : null,
    baseRef: mode === "worktree" ? baseRef : null,
    outDir,
    candidates,
    skipped,
  };
  const manifestPath = path.join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (flags.json) {
    console.log(JSON.stringify({ manifestPath, ...manifest }, null, 2));
  } else {
    console.log(`Arena run complete: ${manifestPath}`);
    for (const c of candidates) {
      console.log(
        `  - ${c.name} (${c.harness}:${c.model}): ${c.succeeded ? "OK" : "FAILED"} (${Math.round(c.durationMs / 1000)}s) -> ${c.workDir}`,
      );
    }
    for (const s of skipped) {
      console.log(`  - ${s.name}: SKIPPED (${s.reason})`);
    }
  }
}

async function handleJudge(flags) {
  if (!flags.manifest || !flags["rubric-file"]) {
    throw new Error("--manifest and --rubric-file are required");
  }
  const config = loadArenaConfig({ configPath: flags.config || null });
  const manifest = JSON.parse(readFileSync(String(flags.manifest), "utf8"));
  const rubricText = readFileSync(String(flags["rubric-file"]), "utf8");
  const judge = selectCrossJudge(config, {
    callerVendor: flags["caller-vendor"]
      ? String(flags["caller-vendor"])
      : null,
    judgeName: flags.judge ? String(flags.judge) : null,
  });

  if (!judge) {
    const out = {
      skipped: true,
      reason: "no eligible cross-vendor judge available",
    };
    console.log(flags.json ? JSON.stringify(out, null, 2) : out.reason);
    return;
  }

  const survivors = (manifest.candidates || []).filter((c) => c.succeeded);
  const judgePrompt = `You are a read-only cross-judge for a competitive Arena bakeoff.
Do NOT edit any files. Inspect each surviving candidate directory by path label, score every candidate criterion-by-criterion against the rubric, name standout ideas worth grafting from losers, and recommend one base.

## Rubric
${rubricText.trim()}

## Candidates
${survivors.map((c) => `- **${c.name}** (${c.harness}:${c.model}): ${c.workDir}`).join("\n")}
`;

  if (flags["dry-run"]) {
    console.log(
      flags.json
        ? JSON.stringify(
            { judge, survivors: survivors.map((s) => s.name) },
            null,
            2,
          )
        : `Dry run judge: ${judge.name} (${judge.harness}:${judge.model}, vendor=${judge.vendor})`,
    );
    return;
  }

  const inv = buildHarnessInvocation({
    harness: judge.harness,
    binary: judge.binaryPath || judge.binary,
    model: judge.model,
    effort: judge.effort,
    workDir: manifest.outDir,
    readOnly: true,
    timeoutSeconds: config.defaults.timeout_seconds,
  });
  const reportPath = path.join(manifest.outDir, "judge-report.md");
  const res = await runSubprocess({
    command: inv.command,
    args: inv.args,
    cwd: manifest.outDir,
    stdinText: judgePrompt,
    timeoutMs: config.defaults.timeout_seconds * 1000,
    stdoutPath: reportPath,
    stderrPath: path.join(manifest.outDir, "judge.stderr.log"),
  });

  const result = {
    judge: judge.name,
    harness: judge.harness,
    model: judge.model,
    vendor: judge.vendor,
    reportPath,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
  };
  console.log(
    flags.json
      ? JSON.stringify(result, null, 2)
      : `Cross-judge (${judge.name}) wrote ${reportPath} (exit=${res.exitCode})`,
  );
}

function handleCleanup(flags) {
  if (!flags.manifest) {
    throw new Error("--manifest is required");
  }
  const manifest = JSON.parse(readFileSync(String(flags.manifest), "utf8"));
  const removed = [];
  for (const c of manifest.candidates || []) {
    if (c.isWorktree && manifest.repoDir && existsSync(c.workDir)) {
      spawnSync("git", ["worktree", "remove", "--force", c.workDir], {
        cwd: manifest.repoDir,
        encoding: "utf8",
      });
      removed.push(c.workDir);
    }
  }
  if (manifest.outDir && existsSync(manifest.outDir)) {
    rmSync(manifest.outDir, { recursive: true, force: true });
  }
  console.log(
    flags.json
      ? JSON.stringify(
          { cleaned: manifest.outDir, worktreesRemoved: removed },
          null,
          2,
        )
      : `Cleaned arena artifacts: ${manifest.outDir}`,
  );
}

export async function main(argv = process.argv) {
  const { subcommand, flags } = parseCliArgs(argv);
  if (subcommand === "help" || flags.help) {
    printHelp();
    return;
  }
  if (subcommand === "config") {
    const config = loadArenaConfig({ configPath: flags.config || null });
    const plan = resolveRunnerPlan(config, {
      profile: flags.profile || config.defaults.profile,
    });
    const out = {
      source: config.source,
      isExampleFallback: config.isExampleFallback,
      defaults: config.defaults,
      profiles: config.profiles,
      runners: plan,
      crossJudgePool: config.cross_judge_pool,
    };
    console.log(
      flags.json
        ? JSON.stringify(out, null, 2)
        : `Arena config (${out.source}${out.isExampleFallback ? " [example fallback]" : ""})\n` +
            out.runners
              .map(
                (r) => `  - ${r.name}: ${r.status} (${r.harness}:${r.model})`,
              )
              .join("\n"),
    );
    return;
  }
  if (subcommand === "run") return handleRun(flags);
  if (subcommand === "judge") return handleJudge(flags);
  if (subcommand === "cleanup") return handleCleanup(flags);
  throw new Error(`unknown arena subcommand "${subcommand}"`);
}

if (
  import.meta.main ||
  process.argv[1] === pathToFileURL(import.meta.filename).pathname ||
  process.argv[1]?.endsWith("arena.mjs")
) {
  main().catch((err) => {
    console.error(`arena: ${err.message}`);
    process.exit(1);
  });
}
