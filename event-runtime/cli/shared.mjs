import path from "node:path";
import { apiClient } from "../lib/client.mjs";

export const CLI_PATH = path.resolve(import.meta.dir, "../cli.mjs");
export const stamp = () => new Date().toISOString();
export const log = (line) => console.log(`[${stamp()}] ${line}`);
export const pad = (value, width) => String(value ?? "-").padEnd(width);

export function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

export const WORKER_POLL_MS_MIN = 25;
export const WORKER_POLL_MS_MAX = 5_000;

export function validWorkerPollMs(value) {
  return (
    Number.isInteger(value) &&
    value >= WORKER_POLL_MS_MIN &&
    value <= WORKER_POLL_MS_MAX
  );
}

export function parseWorkerLabel(value) {
  const label = String(value ?? "");
  const [key, ...rest] = label.split("=");
  if (!label || label.startsWith("--") || !key || rest.length === 0)
    return null;
  return { key, value: rest.join("=") };
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Run one client verb; connection refusal names the fix, exactly (§12).
 *
 * The client is built inside the try so a bad operator target (#2188 — an
 * unparsable URL, or plaintext http to a non-loopback host) exits through
 * fail() with the message rather than a stack trace.
 */
export async function withClient(fn) {
  let client = null;
  try {
    client = apiClient({ resolveTarget: true });
    await fn(client);
  } catch (err) {
    if (client && err.status === undefined) {
      fail(
        `control API not reachable on ${client.host}:${client.port} — start it with: bun event-runtime/cli.mjs serve`,
      );
    }
    fail(err.message);
  }
}
