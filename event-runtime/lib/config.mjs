/**
 * Event-runtime configuration: filesystem layout, control-API address, and
 * versions. Everything durable lives under ~/.factory/event-runtime by default
 * so stopping — or deleting — the runtime never touches the repo checkout or
 * the existing orchestrator's state (docs/event-runtime.md §3).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the event-runtime/ directory inside the factory repo. */
export const RUNTIME_ROOT = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);

/** The factory checkout itself — where config/repos.yaml lives (OPS-228). */
export const FACTORY_ROOT = path.dirname(RUNTIME_ROOT);

export function runtimeHome() {
  return (
    process.env.FACTORY_EVENT_HOME ||
    path.join(homedir(), ".factory", "event-runtime")
  );
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
