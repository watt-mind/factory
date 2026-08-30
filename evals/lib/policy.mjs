/**
 * Where the eval runner gets its models and its bounds: the `evals:` stanza of
 * `config/policy.yaml` (#1073).
 *
 * The grader is pinned BY NAME, in git-tracked operator policy, on purpose. A
 * grader that floats with whatever the CLI defaults to today moves the pass bar
 * silently — a suite that "went green" would be indistinguishable from a suite
 * whose judge got more generous. Pinning it makes a grader upgrade a one-line
 * policy PR that shows up in review next to the pass-rate change it causes.
 *
 * Why a hand-rolled reader instead of `Bun.YAML.parse` (which the rest of the
 * runtime uses): the documented invocation is `node evals/run.mjs`, so the
 * runner must work under plain node, and the repo has no YAML dependency. The
 * parser below is deliberately not a YAML implementation — it extracts ONE
 * top-level block by name and reads the scalar map inside it. Anything it does
 * not understand (sequences, anchors, block scalars) is skipped rather than
 * guessed at, and every value the runner actually depends on is validated
 * fail-closed below, so a construct this reader mis-reads surfaces as a config
 * error rather than as a silently wrong model.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export class EvalConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvalConfigError";
  }
}

/** Matches the adapters' sentinel: "pass no --model, ride the CLI default". */
export const DEFAULT_MODEL = "default";

/** Bounds used when the stanza omits `limits:`. Every run is bounded. */
export const DEFAULT_LIMITS = Object.freeze({
  caseTimeoutSeconds: 300,
  caseBudgetUsd: 2,
  totalSeconds: 3600,
  totalBudgetUsd: 20,
});

/**
 * The stanza an operator must add to make real (non-`--dry-run`) runs possible.
 * Printed verbatim in the error, so the fix never requires reading the source.
 */
export const REQUIRED_STANZA = `evals:
  # The model that RUNS the skill under test. "default" rides the CLI default,
  # which is what dispatch does today.
  subject:
    model: default
  # The model that GRADES the response against expect.md. Pinned by name so a
  # grader upgrade is a deliberate, reviewable change and never a silent shift
  # in the pass bar; the "default" sentinel is refused here for that reason.
  grader:
    model: claude-sonnet-4-6
  limits:
    case_timeout_seconds: 300
    case_budget_usd: 2.00
    total_seconds: 3600
    total_budget_usd: 20.00`;

/** Strip a trailing `# comment`, honouring quotes so a `#` inside one survives. */
export function stripComment(line) {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single) double = !double;
    else if (
      ch === "#" &&
      !single &&
      !double &&
      (i === 0 || /\s/.test(line[i - 1]))
    ) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Return the indented body of one top-level `<key>:` block, or null when the
 * document has no such key. Reading only the block we own keeps every other
 * construct in policy.yaml (sequences, nested maps, prose comments) out of the
 * parser's way entirely.
 */
export function extractStanza(text, key) {
  const lines = String(text ?? "").split(/\r?\n/);
  const header = new RegExp(`^${key}:\\s*(#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (/^\S/.test(line)) break; // next top-level key ends the block
    body.push(line);
  }
  return body.join("\n");
}

/**
 * Parse an indented map of scalars (arbitrary nesting) from a stanza body.
 * Sequence entries are skipped: this subset has no use for them, and guessing
 * at one is worse than not reading it.
 */
export function parseIndentedMap(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = stripComment(raw);
    if (line.trim() === "") continue;
    if (/^\s*-/.test(line)) continue;
    const match = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, pad, key, rest] = match;
    const indent = pad.length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent)
      stack.pop();
    const parent = stack[stack.length - 1].node;
    if (rest.trim() === "") {
      const node = {};
      parent[key] = node;
      stack.push({ indent, node });
    } else {
      parent[key] = unquote(rest);
    }
  }
  return root;
}

/**
 * Resolve which policy file to read. Mirrors `event-runtime/lib/config.mjs`:
 * the operator-local `config/policy.yaml` is gitignored, so a clean checkout
 * falls back to the tracked example rather than reporting "no policy".
 */
export function resolvePolicyFile(root) {
  const local = path.join(root, "config", "policy.yaml");
  if (existsSync(local)) return local;
  const example = path.join(root, "config", "policy.example.yaml");
  if (existsSync(example)) return example;
  return null;
}

function positiveNumber(raw, where) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new EvalConfigError(
      `${where} must be a positive number (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

function readLimits(stanza, file) {
  const limits = stanza?.limits ?? {};
  if (typeof limits !== "object" || Array.isArray(limits)) {
    throw new EvalConfigError(`${file}: evals.limits must be a map`);
  }
  const pick = (key, fallback) =>
    limits[key] === undefined
      ? fallback
      : positiveNumber(limits[key], `${file}: evals.limits.${key}`);
  return {
    caseTimeoutSeconds: pick(
      "case_timeout_seconds",
      DEFAULT_LIMITS.caseTimeoutSeconds,
    ),
    caseBudgetUsd: pick("case_budget_usd", DEFAULT_LIMITS.caseBudgetUsd),
    totalSeconds: pick("total_seconds", DEFAULT_LIMITS.totalSeconds),
    totalBudgetUsd: pick("total_budget_usd", DEFAULT_LIMITS.totalBudgetUsd),
  };
}

/**
 * Read the eval stanza.
 *
 * Never throws for an ABSENT pin: `--dry-run` must keep working on a checkout
 * whose policy has not been extended yet (that is the whole point of a mode
 * that spends nothing). The absence is reported as `problem`, and `requirePin`
 * below is what turns it into the fail-closed error a real run needs.
 *
 * @param {{root: string, file?: string|null, text?: string|null}} options
 * @returns {{file: string|null, grader: {model: string}|null, subject: {model: string}, limits: object, problem: string|null}}
 */
export function loadEvalPolicy({
  root,
  file = undefined,
  text = undefined,
} = {}) {
  const policyFile = file === undefined ? resolvePolicyFile(root) : file;
  const source =
    text === undefined
      ? policyFile && existsSync(policyFile)
        ? readFileSync(policyFile, "utf8")
        : null
      : text;
  const base = {
    file: policyFile,
    grader: null,
    subject: { model: DEFAULT_MODEL },
    limits: { ...DEFAULT_LIMITS },
  };
  if (source === null) {
    return {
      ...base,
      problem: "no config/policy.yaml (or policy.example.yaml) found",
    };
  }
  const body = extractStanza(source, "evals");
  if (body === null) {
    return { ...base, problem: `${policyFile} has no \`evals:\` stanza` };
  }
  const stanza = parseIndentedMap(body);
  const limits = readLimits(stanza, policyFile);
  const subjectModel = stanza?.subject?.model;
  const subject = {
    model:
      typeof subjectModel === "string" && subjectModel.trim() !== ""
        ? subjectModel.trim()
        : DEFAULT_MODEL,
  };
  const graderModel = stanza?.grader?.model;
  if (typeof graderModel !== "string" || graderModel.trim() === "") {
    return {
      ...base,
      subject,
      limits,
      problem: `${policyFile}: evals.grader.model is not set`,
    };
  }
  if (graderModel.trim() === DEFAULT_MODEL) {
    return {
      ...base,
      subject,
      limits,
      problem: `${policyFile}: evals.grader.model is "${DEFAULT_MODEL}" — the grader must name a model, so that changing it is reviewable`,
    };
  }
  return {
    file: policyFile,
    grader: { model: graderModel.trim() },
    subject,
    limits,
    problem: null,
  };
}

/** Fail closed: a run that would spend must know exactly which judge it used. */
export function requirePin(policy) {
  if (policy.grader) return policy;
  throw new EvalConfigError(
    `${policy.problem}\n\nAdd this stanza to config/policy.yaml (and config/policy.example.yaml) before running evals:\n\n${REQUIRED_STANZA}\n`,
  );
}
