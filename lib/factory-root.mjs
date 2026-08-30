/**
 * Resolve the factory checkout from a validated env override, this module's
 * checkout, then ~/Develop/factory as a final fallback.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "tools/linear.mjs";

/** @returns {string} absolute path to factory checkout */
export function factoryRoot() {
  const env = process.env.FACTORY_ROOT;
  if (env && existsSync(path.join(env, MARKER))) return path.resolve(env);

  const fromLib = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  if (existsSync(path.join(fromLib, MARKER))) return fromLib;

  const defaultPath = path.join(homedir(), "Develop/factory");
  if (existsSync(path.join(defaultPath, MARKER))) return defaultPath;

  return env ? path.resolve(env) : defaultPath;
}
