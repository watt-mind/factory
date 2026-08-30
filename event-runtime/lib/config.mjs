/**
 * Event-runtime configuration: filesystem layout, control-API address, and
 * versions. Everything durable lives under ~/.factory/event-runtime by default
 * so stopping — or deleting — the runtime never touches the repo checkout or
 * the existing orchestrator's state (docs/event-runtime.md §3).
 */
import { execFileSync } from "node:child_process";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the event-runtime/ directory inside the factory repo. */
export const RUNTIME_ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);

/** The factory checkout itself — where config/repos.yaml lives (OPS-228). */
export const FACTORY_ROOT = path.dirname(RUNTIME_ROOT);

/** Operator-owned configuration files scaffolded by `factory init`. */
export const LOCAL_CONFIG_NAMES = Object.freeze([
  "repos",
  "policy",
  "schedule",
]);

const warnedExampleConfigs = new Set();

/**
 * Resolve one operator-owned config, preferring the untracked local file.
 *
 * A clean checkout remains inspectable without setup by falling back to the
 * tracked example. The warning is deliberately once per path/process: callers
 * such as the API load repos repeatedly, and the operator needs a signal, not
 * a line of noise on every request.
 */
export function resolveConfigPath(
  name,
  { root = FACTORY_ROOT, warn = true } = {},
) {
  if (!LOCAL_CONFIG_NAMES.includes(name)) {
    throw new Error(
      `unknown local config ${JSON.stringify(name)} (expected ${LOCAL_CONFIG_NAMES.join(", ")})`,
    );
  }
  const local = path.join(root, "config", `${name}.yaml`);
  if (existsSync(local)) return local;

  const example = path.join(root, "config", `${name}.example.yaml`);
  if (!existsSync(example)) return local;
  if (warn && !warnedExampleConfigs.has(example)) {
    warnedExampleConfigs.add(example);
    console.warn(
      `warning: ${local} is missing; using ${example}. Run \`factory init\` and edit the local config before operating the factory.`,
    );
  }
  return example;
}

/**
 * Copy every tracked example to its ignored local path without overwriting.
 * COPYFILE_EXCL also keeps concurrent init calls idempotent.
 */
export function initializeLocalConfig({ root = FACTORY_ROOT } = {}) {
  const configDir = path.join(root, "config");
  mkdirSync(configDir, { recursive: true });
  return LOCAL_CONFIG_NAMES.map((name) => {
    const example = path.join(configDir, `${name}.example.yaml`);
    const local = path.join(configDir, `${name}.yaml`);
    if (!existsSync(example)) {
      throw new Error(`missing configuration template: ${example}`);
    }
    if (existsSync(local)) {
      return { name, path: local, template: example, created: false };
    }
    try {
      copyFileSync(example, local, fsConstants.COPYFILE_EXCL);
      return { name, path: local, template: example, created: true };
    } catch (error) {
      if (error?.code === "EEXIST") {
        return { name, path: local, template: example, created: false };
      }
      throw error;
    }
  });
}

/**
 * True when this process is a test or CI run: `bun test` sets NODE_ENV=test
 * for the test process (inherited by CLIs it spawns), and CI runners export
 * CI=true. Such a process must never resolve the operator's real runtime home.
 */
export function isTestOrCiProcess(env = process.env) {
  return (
    env.NODE_ENV === "test" ||
    env.BUN_ENV === "test" ||
    (env.CI !== undefined && env.CI !== "" && env.CI !== "false")
  );
}

export function runtimeHome(env = process.env) {
  if (env.FACTORY_EVENT_HOME) return env.FACTORY_EVENT_HOME;
  if (isTestOrCiProcess(env)) {
    // Fail closed: CI runs on the operator's own machine, and a test that
    // reached the default home once migrated the live runtime.db to a schema
    // newer than the running workers (2026-08-29).
    throw new Error(
      "refusing to use the default runtime home (~/.factory/event-runtime) " +
        "from a test or CI process: set FACTORY_EVENT_HOME to an isolated " +
        "directory (event-runtime/test-helpers.mjs does this on import)",
    );
  }
  return path.join(homedir(), ".factory", "event-runtime");
}

export function dbPath(home = runtimeHome()) {
  return path.join(home, "runtime.db");
}

export function workspacesRoot(home = runtimeHome()) {
  return path.join(home, "workspaces");
}

/** Durable content-addressed artifact store (§7) — survives its workspaces. */
/** Bare mirrors backing tier-1 repository workspaces (OPS-228). */
export function mirrorsRoot(home = runtimeHome()) {
  return path.join(home, "mirrors");
}

export function artifactsRoot(home = runtimeHome()) {
  return path.join(home, "artifacts");
}

export function ensureHome(home = runtimeHome()) {
  mkdirSync(workspacesRoot(home), { recursive: true });
  mkdirSync(artifactsRoot(home), { recursive: true });
  mkdirSync(mirrorsRoot(home), { recursive: true });
  return home;
}

/**
 * Human-readable environment name, shown by every client (CLI status line,
 * web UI chip) so an operator always knows WHICH runtime they are pointed at
 * before approving anything. Explicit FACTORY_EVENT_ENV wins; otherwise the
 * default home is "live" and any other home is named by its directory suffix
 * (~/.factory/event-runtime-dev → "dev").
 */
export function environmentName(home = runtimeHome()) {
  if (process.env.FACTORY_EVENT_ENV) return process.env.FACTORY_EVENT_ENV;
  const base = path.basename(home);
  if (base === "event-runtime") return "live";
  return base.replace(/^event-runtime-?/, "") || base;
}

/** Loopback only in the MVP — the control API is a local trust surface (§14). */
export const API_HOST = "127.0.0.1";
export const DEFAULT_PORT = Number(process.env.FACTORY_EVENT_PORT || 7381);

/** Shared secret for webhook HMAC. Absent secret means intake refuses webhooks. */
export function webhookSecret() {
  return process.env.FACTORY_EVENT_SECRET || null;
}

/** Reject webhook deliveries whose signed timestamp is older/newer than this. */
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/** Events that fail planning this many times are dead-lettered (§13). */
export const DEAD_LETTER_AFTER = 3;

/** Default cap when neither repo nor policy config supplies one. */
export const DEFAULT_MAX_IN_FLIGHT = 3;

/** Bound each raw CLI transcript before artifact storage can amplify it. */
export const DEFAULT_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

export function transcriptMaxBytes(env = process.env) {
  const configured = Number(env.FACTORY_EVENT_TRANSCRIPT_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_TRANSCRIPT_MAX_BYTES;
}

export const DEFAULT_PROPOSAL_TTL_SECONDS = 30 * 60;

let cachedPolicyVersion;

/** Factory git SHA, recorded on run specs and lifecycle events as provenance. */
export function policyVersion() {
  if (!cachedPolicyVersion) {
    try {
      const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: RUNTIME_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      cachedPolicyVersion = `git:${sha}`;
    } catch {
      cachedPolicyVersion = "unknown";
    }
  }
  return cachedPolicyVersion;
}
