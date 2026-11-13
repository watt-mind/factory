/**
 * Remote nodes YAML configuration parser (OPS-445).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ROOT } from "./config.mjs";

export const DEFAULT_REMOTE_WORKER_REPO_URL =
  "https://github.com/watt-mind/factory.git";

export class NodeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "NodeConfigError";
  }
}

export function nodesConfigPath(root = FACTORY_ROOT) {
  return (
    process.env.FACTORY_NODES_CONFIG || path.join(root, "config", "nodes.yaml")
  );
}

/** Expand leading ~ in paths */
export function expandHome(p, home = process.env.HOME) {
  if (typeof p !== "string") return p;
  if (p === "~") return home ?? p;
  if (p.startsWith("~/")) return path.join(home ?? "", p.slice(2));
  return p;
}

/**
 * Load and validate remote nodes configuration.
 *
 * @returns {Map<string, {
 *   name: string,
 *   host: string,
 *   user: string | null,
 *   port: number,
 *   factoryRoot: string,
 *   branch: string,
 *   repoUrl: string,
 *   env: Record<string, string | number>,
 *   labels: Record<string, string>,
 *   adapters: string[]
 * }>}
 */
export function loadNodesConfig({
  configPath = null,
  root = FACTORY_ROOT,
} = {}) {
  const targetPath = configPath || nodesConfigPath(root);
  if (!existsSync(targetPath)) {
    return new Map();
  }

  let content;
  try {
    content = readFileSync(targetPath, "utf8");
  } catch (err) {
    throw new NodeConfigError(`Failed to read nodes config: ${err.message}`);
  }

  let parsed;
  try {
    parsed = Bun.YAML.parse(content);
  } catch (err) {
    throw new NodeConfigError(`Failed to parse nodes YAML: ${err.message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    return new Map();
  }

  const nodes = parsed.nodes;
  if (!nodes || typeof nodes !== "object") {
    return new Map();
  }

  const result = new Map();

  for (const [name, rawNode] of Object.entries(nodes)) {
    if (!rawNode || typeof rawNode !== "object") {
      throw new NodeConfigError(
        `Node "${name}" configuration must be an object`,
      );
    }

    if (!rawNode.host || typeof rawNode.host !== "string") {
      throw new NodeConfigError(
        `Node "${name}" is missing required field "host"`,
      );
    }

    const host = rawNode.host.trim();
    if (!host) {
      throw new NodeConfigError(`Node "${name}" has empty "host"`);
    }

    const port = rawNode.port ? Number(rawNode.port) : 22;
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new NodeConfigError(
        `Node "${name}" has invalid SSH port: ${rawNode.port}`,
      );
    }

    const user = rawNode.user ? String(rawNode.user).trim() : null;
    const factoryRoot = rawNode.factory_root
      ? String(rawNode.factory_root).trim()
      : "~/Develop/factory";
    const branch = rawNode.branch ? String(rawNode.branch).trim() : "master";
    const repoUrl =
      String(rawNode.repo_url ?? "").trim() || DEFAULT_REMOTE_WORKER_REPO_URL;

    const env =
      rawNode.env && typeof rawNode.env === "object" ? { ...rawNode.env } : {};
    const labels =
      rawNode.labels && typeof rawNode.labels === "object"
        ? { ...rawNode.labels }
        : {};

    const adapters = Array.isArray(rawNode.adapters)
      ? rawNode.adapters.map((a) => String(a).trim()).filter(Boolean)
      : [];

    result.set(name, {
      name,
      host,
      user,
      port,
      factoryRoot,
      branch,
      repoUrl,
      env,
      labels,
      adapters,
    });
  }

  return result;
}
