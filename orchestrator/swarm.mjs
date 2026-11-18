#!/usr/bin/env bun
/**
 * Multi-harness Swarm fan-out runner (`factory swarm`, GH-2428).
 *
 * Reads node-local configuration from `~/.factory/swarm.yaml` (falling back
 * to `config/swarm.example.yaml`), resolves installed CLI harnesses (`claude`,
 * `codex`, `agy`, `pi`, `cursor`) with per-worker fallback, fans out N parallel
 * workers for `partition`, `race` (`first-pass` | `rank-all` | `best-of`), or
 * `mixed` shapes in isolated `$TMPDIR` sandboxes or detached git worktrees, and
 * cleans up temporary worktrees without ever touching `git stash`.
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

export const VALID_SHAPES = Object.freeze(["partition", "race", "mixed"]);
export const VALID_RACE_RULES = Object.freeze([
  "first-pass",
  "rank-all",
  "best-of",
]);

/**
 * Load `~/.factory/swarm.yaml` if present, otherwise `config/swarm.example.yaml`.
 */
export function loadSwarmConfig({
  homeDir = homedir(),
  root = DEFAULT_ROOT,
  configPath = process.env.FACTORY_SWARM_CONFIG || null,
} = {}) {
  const userPath = path.join(homeDir, ".factory", "swarm.yaml");
  const examplePath = path.join(root, "config", "swarm.example.yaml");
  const resolvedPath =
    configPath || (existsSync(userPath) ? userPath : examplePath);

  if (!existsSync(resolvedPath)) {
    throw new Error(
      `swarm config not found (checked ${userPath} and ${examplePath})`,
    );
  }
  const parsed = Bun.YAML.parse(readFileSync(resolvedPath, "utf8")) || {};
  return {
    source: resolvedPath,
    isExampleFallback: !configPath && !existsSync(userPath),
    defaults: {
      worker: parsed.defaults?.worker || "opus",
      profile: parsed.defaults?.profile || "default",
      mode: parsed.defaults?.mode || "sandbox",
      min_workers: Number(parsed.defaults?.min_workers ?? 2),
      timeout_seconds: Number(parsed.defaults?.timeout_seconds ?? 600),
    },
    workers: parsed.workers || {},
    profiles: parsed.profiles || {},
  };
}

export function resolveHarnessBinary(harness, which = (cmd) => Bun.which(cmd)) {
  const candidates = HARNESS_BINARIES[harness] || [harness];
  for (const bin of candidates) {
    const resolved = which(bin);
    if (resolved) return { bin, path: resolved };
  }
  return null;
}

export function resolveWorkerSpec(
  config,
  workerName,
  which = (cmd) => Bun.which(cmd),
) {
  const name = workerName || config.defaults.worker;
  const spec = config.workers[name];
  if (!spec) {
    return {
      name,
      status: "skipped",
      reason: `worker "${name}" is not defined in swarm config`,
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
        fallbackUsed: true,
      };
    }
  }
  return {
    name,
    status: "skipped",
    harness: spec.harness,
    model: spec.model,
    reason: `CLI binary for harness "${spec.harness}" not found on PATH`,
  };
}

/**
 * Build concrete worker assignments for `partition`, `race`, or `mixed`.
 */
export function buildSwarmPlan(
  config,
  {
    shape = "partition",
    rule = null,
    profile = null,
    tasks = [],
    promptText = "",
    workerNames = null,
    which = (cmd) => Bun.which(cmd),
  } = {},
) {
  if (!VALID_SHAPES.includes(shape)) {
    throw new Error(
      `invalid swarm shape "${shape}" (expected ${VALID_SHAPES.join("|")})`,
    );
  }
  if (
    (shape === "race" || shape === "mixed") &&
    !VALID_RACE_RULES.includes(rule)
  ) {
    throw new Error(
      `--rule (${VALID_RACE_RULES.join("|")}) is required for shape "${shape}"`,
    );
  }

  if (shape === "partition") {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error("partition shape requires --tasks-file with >= 1 task");
    }
    return tasks.map((t, idx) => {
      const id = t.id || `slice-${idx + 1}`;
      const resolved = resolveWorkerSpec(
        config,
        t.worker || config.defaults.worker,
        which,
      );
      return {
        ...resolved,
        slotId: id,
        brief: t.brief || t.prompt || "",
        readOnly: Boolean(t.readOnly),
        shas: Array.isArray(t.shas) ? t.shas : [],
        method: t.method || null,
      };
    });
  }

  // race or mixed
  const armNames =
    workerNames && workerNames.length > 0
      ? workerNames
      : config.profiles[profile || "race"] || [config.defaults.worker];

  if (shape === "race") {
    return armNames.map((arm) => {
      const resolved = resolveWorkerSpec(config, arm, which);
      return {
        ...resolved,
        slotId: `arm-${arm}`,
        brief: promptText,
        readOnly: false,
        shas: [],
        method: null,
      };
    });
  }

  // mixed: each task fanned across arms
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("mixed shape requires --tasks-file with >= 1 task");
  }
  const slots = [];
  for (const t of tasks) {
    const id = t.id || `slice-${slots.length + 1}`;
    for (const arm of armNames) {
      const resolved = resolveWorkerSpec(config, t.worker || arm, which);
      slots.push({
        ...resolved,
        slotId: `${id}-${arm}`,
        brief: t.brief || t.prompt || promptText,
        readOnly: Boolean(t.readOnly),
        shas: Array.isArray(t.shas) ? t.shas : [],
        method: t.method || null,
      });
    }
  }
  return slots;
}

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
      args.push(readOnly ? "--mode" : "--dangerously-skip-permissions");
      if (readOnly) args.push("plan");
      return { command: bin, args };
    }
    case "pi": {
      const args = ["-p", "--mode", "json"];
      if (model && model !== "default") args.push("--model", model);
      if (readOnly) args.push("--tools", "read,grep,find,ls");
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
      throw new Error(`unsupported swarm harness "${harness}"`);
  }
}

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
      });
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function prepareSlotWorkspace({
  mode,
  outDir,
  slotId,
  repoDir,
  baseRef,
  readOnly,
}) {
  const slotDir = path.join(outDir, slotId);
  if (mode === "worktree" && !readOnly) {
    const res = spawnSync(
      "git",
      ["worktree", "add", "--detach", slotDir, baseRef || "HEAD"],
      { cwd: repoDir, encoding: "utf8" },
    );
    if (res.status !== 0) {
      throw new Error(
        `git worktree add failed for ${slotId}: ${res.stderr || res.stdout}`,
      );
    }
    return { workDir: slotDir, isWorktree: true };
  }
  mkdirSync(slotDir, { recursive: true });
  return {
    workDir: readOnly ? repoDir : slotDir,
    outSlotDir: slotDir,
    isWorktree: false,
  };
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
  console.log(`factory swarm — multi-harness parallel worker runner

Usage:
  factory swarm config [--profile default|race] [--json]
  factory swarm run --shape partition|race|mixed [--rule first-pass|rank-all|best-of]
                    [--tasks-file <json>] [--prompt-file <md>] [--profile <name>]
                    [--workers a,b,c] [--mode sandbox|worktree] [--repo-dir <dir>]
                    [--base <ref>] [--out-dir <dir>] [--timeout <sec>] [--dry-run] [--json]
  factory swarm cleanup --manifest <path> [--json]
`);
}

async function handleRun(flags) {
  const config = loadSwarmConfig({ configPath: flags.config || null });
  const shape = String(flags.shape || "partition");
  const rule = flags.rule ? String(flags.rule) : null;
  const mode = String(flags.mode || config.defaults.mode);
  const timeoutSeconds = Number(
    flags.timeout || config.defaults.timeout_seconds,
  );
  const tasks = flags["tasks-file"]
    ? JSON.parse(readFileSync(String(flags["tasks-file"]), "utf8"))
    : [];
  const promptText = flags["prompt-file"]
    ? readFileSync(String(flags["prompt-file"]), "utf8")
    : "";
  const workerNames = flags.workers
    ? String(flags.workers)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  const plan = buildSwarmPlan(config, {
    shape,
    rule,
    profile: flags.profile ? String(flags.profile) : null,
    tasks,
    promptText,
    workerNames,
  });
  const ready = plan.filter((w) => w.status === "ready");
  const skipped = plan.filter((w) => w.status !== "ready");

  if (!flags["dry-run"] && ready.length === 0) {
    throw new Error("no swarm workers available on PATH");
  }

  const outDir = flags["out-dir"]
    ? path.resolve(String(flags["out-dir"]))
    : mkdtempSync(path.join(tmpdir(), "factory-swarm-"));
  mkdirSync(outDir, { recursive: true });

  const repoDir = path.resolve(String(flags["repo-dir"] || process.cwd()));
  const baseRef = String(flags.base || "HEAD");

  if (flags["dry-run"]) {
    const preview = {
      configSource: config.source,
      shape,
      rule,
      mode,
      outDir,
      ready,
      skipped,
    };
    console.log(
      flags.json
        ? JSON.stringify(preview, null, 2)
        : `Dry run (${shape}, ${mode}): ${ready.map((w) => `${w.slotId}[${w.harness}:${w.model}]`).join(", ")}`,
    );
    return;
  }

  const results = await Promise.all(
    ready.map(async (worker) => {
      const ws = prepareSlotWorkspace({
        mode,
        outDir,
        slotId: worker.slotId,
        repoDir,
        baseRef,
        readOnly: worker.readOnly,
      });
      const shaNotice =
        worker.shas.length > 0
          ? `\n- Required SHAs to verify & echo: ${worker.shas.join(", ")}`
          : "";
      const methodNotice = worker.method
        ? `\n- Required measurement method to follow & echo: ${worker.method}`
        : "";
      const workerPrompt = `${worker.brief.trim()}

---
Swarm worker instructions:
- Slot ID: ${worker.slotId}
- Verdict format: end with \`VERDICT: PASS\`, \`VERDICT: ISSUES\`, or \`VERDICT: BLOCKED\` plus concrete evidence (list every provable issue, not just the first).${shaNotice}${methodNotice}`;

      const inv = buildHarnessInvocation({
        harness: worker.harness,
        binary: worker.binaryPath || worker.binary,
        model: worker.model,
        effort: worker.effort,
        workDir: ws.workDir,
        readOnly: worker.readOnly,
        timeoutSeconds,
      });
      const stdoutPath = path.join(outDir, `${worker.slotId}.stdout.log`);
      const stderrPath = path.join(outDir, `${worker.slotId}.stderr.log`);
      const res = await runSubprocess({
        command: inv.command,
        args: inv.args,
        cwd: ws.workDir,
        stdinText: workerPrompt,
        timeoutMs: timeoutSeconds * 1000,
        stdoutPath,
        stderrPath,
      });
      return {
        ...worker,
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
    shape,
    rule,
    mode,
    repoDir: mode === "worktree" ? repoDir : null,
    baseRef: mode === "worktree" ? baseRef : null,
    outDir,
    results,
    skipped,
  };
  const manifestPath = path.join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (flags.json) {
    console.log(JSON.stringify({ manifestPath, ...manifest }, null, 2));
  } else {
    console.log(`Swarm run complete: ${manifestPath}`);
    for (const r of results) {
      console.log(
        `  - ${r.slotId} (${r.harness}:${r.model}): ${r.succeeded ? "OK" : "FAILED"} (${Math.round(r.durationMs / 1000)}s)`,
      );
    }
    for (const s of skipped) {
      console.log(`  - ${s.slotId}: SKIPPED (${s.reason})`);
    }
  }
}

function handleCleanup(flags) {
  if (!flags.manifest) {
    throw new Error("--manifest is required");
  }
  const manifest = JSON.parse(readFileSync(String(flags.manifest), "utf8"));
  const removed = [];
  for (const r of manifest.results || []) {
    if (r.isWorktree && manifest.repoDir && existsSync(r.workDir)) {
      spawnSync("git", ["worktree", "remove", "--force", r.workDir], {
        cwd: manifest.repoDir,
        encoding: "utf8",
      });
      removed.push(r.workDir);
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
      : `Cleaned swarm artifacts: ${manifest.outDir}`,
  );
}

export async function main(argv = process.argv) {
  const { subcommand, flags } = parseCliArgs(argv);
  if (subcommand === "help" || flags.help) {
    printHelp();
    return;
  }
  if (subcommand === "config") {
    const config = loadSwarmConfig({ configPath: flags.config || null });
    const profile = String(flags.profile || "race");
    const names = config.profiles[profile] || [config.defaults.worker];
    const resolved = names.map((n) => resolveWorkerSpec(config, n));
    const out = {
      source: config.source,
      isExampleFallback: config.isExampleFallback,
      defaults: config.defaults,
      profiles: config.profiles,
      workers: resolved,
    };
    console.log(
      flags.json
        ? JSON.stringify(out, null, 2)
        : `Swarm config (${out.source}${out.isExampleFallback ? " [example fallback]" : ""})\n` +
            out.workers
              .map(
                (w) => `  - ${w.name}: ${w.status} (${w.harness}:${w.model})`,
              )
              .join("\n"),
    );
    return;
  }
  if (subcommand === "run") return handleRun(flags);
  if (subcommand === "cleanup") return handleCleanup(flags);
  throw new Error(`unknown swarm subcommand "${subcommand}"`);
}

if (
  import.meta.main ||
  process.argv[1] === pathToFileURL(import.meta.filename).pathname ||
  process.argv[1]?.endsWith("swarm.mjs")
) {
  main().catch((err) => {
    console.error(`swarm: ${err.message}`);
    process.exit(1);
  });
}
