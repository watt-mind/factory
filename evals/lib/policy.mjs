/**
 * Grader-model resolution (watt-mind/factory#1073).
 *
 * The grader is pinned to a named model in `config/policy.yaml` so a grader
 * upgrade is a deliberate, reviewable change — not a silent shift in the pass
 * bar. This module reads that pin. It deliberately does NOT import
 * `event-runtime/lib`: the acceptance invocation is `node evals/run.mjs`, and
 * that path uses `Bun.YAML`, which is absent under plain node. A pin is a
 * single scalar, so a narrow, dependency-free reader is honest here.
 *
 * Resolution order (first hit wins):
 *   1. `evals.grader.model` — the eval-specific pin operators add to policy.yaml
 *   2. `models.claude.strong` — the fleet's strong-tier claude model
 *   3. DEFAULT_GRADER_MODEL — the CLI's own default ("default" sentinel)
 *
 * `config/policy.yaml` is operator-local and git-ignored; a clean checkout
 * falls back to `config/policy.example.yaml` (same rule the registry uses).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The "ride the CLI's own default model" sentinel, matching the claude adapter. */
export const DEFAULT_GRADER_MODEL = "default";

/**
 * Read one scalar at a known key path out of a simple 2-space-indented YAML
 * document. Narrow by design: it handles the nested scalar the grader pin is,
 * not arbitrary YAML. Quotes are stripped; inline comments after a value are
 * not (policy.yaml keeps comments on their own lines).
 */
export function readYamlScalar(text, keyPath) {
  const lines = String(text).split(/\r?\n/);
  const stack = []; // { indent, key }
  for (const raw of lines) {
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;
    const m = /^(\s*)([A-Za-z0-9_.-]+):\s?(.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2];
    const value = m[3].trim();
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const depth = stack.length;
    if (depth < keyPath.length && key === keyPath[depth]) {
      if (depth === keyPath.length - 1) {
        if (value === "" || value === "|" || value === ">") return null;
        return value.replace(/^["']|["']$/g, "");
      }
      stack.push({ indent, key });
    } else {
      stack.push({ indent, key });
    }
  }
  return null;
}

/** Locate the operator-local policy.yaml, falling back to the tracked example. */
export function resolvePolicyPath(factoryRoot) {
  const local = path.join(factoryRoot, "config", "policy.yaml");
  if (existsSync(local)) return local;
  const example = path.join(factoryRoot, "config", "policy.example.yaml");
  if (existsSync(example)) return example;
  return null;
}

/**
 * Resolve the grader model pin for a factory checkout.
 * @returns {{ model: string, source: string }}
 */
export function resolveGraderModel({ factoryRoot } = {}) {
  const file = resolvePolicyPath(factoryRoot);
  if (!file) return { model: DEFAULT_GRADER_MODEL, source: "default" };
  const text = readFileSync(file, "utf8");
  const rel = path.relative(factoryRoot, file);

  const pinned = readYamlScalar(text, ["evals", "grader", "model"]);
  if (pinned) return { model: pinned, source: `${rel}:evals.grader.model` };

  const strong = readYamlScalar(text, ["models", "claude", "strong"]);
  if (strong) return { model: strong, source: `${rel}:models.claude.strong` };

  return { model: DEFAULT_GRADER_MODEL, source: "default" };
}
