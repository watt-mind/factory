/**
 * Resolve the operator's notify transport from policy, not a hardcoded
 * private-repo script path (WM-795).
 *
 * Precedence:
 *   1. FACTORY_NOTIFY_CMD
 *   2. FACTORY_NOTIFY_SCRIPT (wrapped as `python3 <script>`)
 *   3. FACTORY_EVENT_NOTIFY_CMD
 *   4. config/policy.yaml `notify.command`
 *
 * There is no in-tree default. A clone that has not configured a command
 * gets `null` — silent on this channel until the operator sets one.
 *
 * CLI:
 *   bun lib/notify.mjs            # print the resolved command (empty if none)
 *   bun lib/notify.mjs --script   # python script path, if the command is python3 <path>
 *   bun lib/notify.mjs --export-env  # shell exports for FACTORY_NOTIFY_{CMD,SCRIPT}
 *   bun lib/notify.mjs --queue-local # append a notification to this run's local outbox
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { factoryRoot } from "./factory-root.mjs";

export function expandHome(value, home = homedir()) {
  if (typeof value !== "string") return value;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\"))
    return home + value.slice(1);
  return value;
}

function splitCommand(command) {
  return String(command)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => expandHome(part));
}

function pythonScriptPath(argv) {
  if (argv.length === 2 && argv[0] === "python3") return argv[1];
  if (argv.length === 1 && argv[0].endsWith(".py")) return argv[0];
  return null;
}

function envValue(env, key) {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function commandFromEnv(env) {
  const cmd = envValue(env, "FACTORY_NOTIFY_CMD");
  if (cmd) return expandHome(cmd);
  const script = envValue(env, "FACTORY_NOTIFY_SCRIPT");
  if (script) return `python3 ${expandHome(script)}`;
  const eventCmd = envValue(env, "FACTORY_EVENT_NOTIFY_CMD");
  if (eventCmd) return expandHome(eventCmd);
  return null;
}

function commandFromPolicy(root) {
  const policyPath = path.join(root, "config", "policy.yaml");
  if (!existsSync(policyPath)) return null;
  const policy = Bun.YAML.parse(readFileSync(policyPath, "utf8"));
  const command = policy?.notify?.command;
  if (typeof command !== "string" || !command.trim()) return null;
  return splitCommand(command).join(" ");
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   root?: string,
 * }} [options]
 * @returns {string|null}
 */
export function notifyCommand({
  env = process.env,
  root = factoryRoot(),
} = {}) {
  return commandFromEnv(env) ?? commandFromPolicy(root);
}

/**
 * @returns {string[]|null} argv with the message still to be appended
 */
export function notifyArgv(options) {
  const command = notifyCommand(options);
  return command ? splitCommand(command) : null;
}

/** Python script path when the resolved command is `python3 <script>`. */
export function notifyScript(options) {
  const argv = notifyArgv(options);
  return argv ? pythonScriptPath(argv) : null;
}

const LOCAL_OUTBOX_SCHEMA = "factory.local-notify-outbox/v1";

/**
 * The agent never receives the worker's control bearer. When it cannot create
 * a durable inbox record, it writes here for the worker to submit after the
 * agent exits. Keep the run id path-safe: this is an agent-controlled value.
 */
export function localNotifyOutboxPath({ home, runId }) {
  if (typeof home !== "string" || home.trim() === "")
    throw new Error("FACTORY_EVENT_HOME is required for local notify outbox");
  if (typeof runId !== "string" || !/^[A-Za-z0-9._-]+$/.test(runId))
    throw new Error("FACTORY_RUN_ID is invalid for local notify outbox");
  return path.join(home, "outbox", `${runId}.jsonl`);
}

export function queueLocalNotification({
  home = process.env.FACTORY_EVENT_HOME,
  runId = process.env.FACTORY_RUN_ID,
  kind,
  title,
  refs = {},
  source = `agent:${runId}`,
}) {
  if (typeof kind !== "string" || kind.trim() === "")
    throw new Error("local notify outbox requires kind");
  if (typeof title !== "string" || title.trim() === "")
    throw new Error("local notify outbox requires title");
  if (!refs || typeof refs !== "object" || Array.isArray(refs))
    throw new Error("local notify outbox refs must be an object");
  const outboxPath = localNotifyOutboxPath({ home, runId });
  mkdirSync(path.dirname(outboxPath), { recursive: true, mode: 0o700 });
  appendFileSync(
    outboxPath,
    `${JSON.stringify({
      schemaVersion: LOCAL_OUTBOX_SCHEMA,
      runId,
      kind: kind.trim(),
      title,
      refs,
      source,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return outboxPath;
}

function exportEnv(options) {
  const command = notifyCommand(options);
  if (!command) return "";
  const script = notifyScript(options);
  const lines = [`FACTORY_NOTIFY_CMD=${JSON.stringify(command)}`];
  if (script) lines.push(`FACTORY_NOTIFY_SCRIPT=${JSON.stringify(script)}`);
  return lines.map((line) => `export ${line}`).join("\n") + "\n";
}

if (import.meta.main) {
  const flag = process.argv[2];
  if (flag === "--queue-local") {
    const message = process.env.FACTORY_INBOX_MESSAGE;
    const kind = process.env.FACTORY_INBOX_KIND;
    if (!message || !kind) {
      console.error(
        "notify: local outbox requires FACTORY_INBOX_KIND and FACTORY_INBOX_MESSAGE",
      );
      process.exit(2);
    }
    const prefix = message
      .slice(kind.length)
      .trimStart()
      .split(":", 1)[0]
      .trim();
    const { parseNotifyRefs } = await import("./notify-refs.mjs");
    process.stdout.write(
      `${queueLocalNotification({ kind, title: message, refs: parseNotifyRefs(prefix) })}\n`,
    );
  } else if (flag === "--export-env") {
    process.stdout.write(exportEnv());
  } else if (flag === "--script") {
    const script = notifyScript();
    if (script) process.stdout.write(script + "\n");
  } else if (flag && flag !== "--command") {
    console.error(
      "usage: bun lib/notify.mjs [--command|--script|--export-env|--queue-local]",
    );
    process.exit(2);
  } else {
    const command = notifyCommand();
    if (command) process.stdout.write(command + "\n");
  }
}
