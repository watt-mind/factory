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
 */
import { existsSync, readFileSync } from "node:fs";
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
  if (flag === "--export-env") {
    process.stdout.write(exportEnv());
  } else if (flag === "--script") {
    const script = notifyScript();
    if (script) process.stdout.write(script + "\n");
  } else if (flag && flag !== "--command") {
    console.error(
      "usage: bun lib/notify.mjs [--command|--script|--export-env]",
    );
    process.exit(2);
  } else {
    const command = notifyCommand();
    if (command) process.stdout.write(command + "\n");
  }
}
