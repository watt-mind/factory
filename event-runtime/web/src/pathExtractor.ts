/**
 * Safe property path extractor for dynamic custom table columns (WM-214).
 * Handles dot notation (payload.repo), bracket notation (payload['repo']),
 * array indexing (repos[0]), and multi-scope fallback traversal.
 */

const PATH_CACHE = new Map<string, readonly string[]>();
const MAX_PATH_CACHE = 500;

/**
 * Tokenize a property path safely, rejecting prototype pollution vectors.
 * "payload.repo" -> ["payload", "repo"]
 * "spec.input['model-name']" -> ["spec", "input", "model-name"]
 * "repos[0].name" -> ["repos", "0", "name"]
 */
export function parsePath(path: string): readonly string[] {
  const trimmed = path.trim();
  const cached = PATH_CACHE.get(trimmed);
  if (cached) return cached;

  const tokens = trimmed
    .replace(/\[(?:'|"|`)(.*?)(?:'|"|`)]/g, ".$1")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length > 0 &&
        s !== "__proto__" &&
        s !== "prototype" &&
        s !== "constructor",
    );

  if (PATH_CACHE.size >= MAX_PATH_CACHE) {
    const firstKey = PATH_CACHE.keys().next().value;
    if (firstKey) PATH_CACHE.delete(firstKey);
  }
  PATH_CACHE.set(trimmed, tokens);
  return tokens;
}

/**
 * Safely traverses an object along a tokenized path without throwing.
 */
export function getPathValue(target: unknown, path: string | readonly string[]): unknown {
  if (target == null) return undefined;
  const tokens = typeof path === "string" ? parsePath(path) : path;
  let curr: any = target;
  for (let i = 0; i < tokens.length; i++) {
    if (curr == null || typeof curr !== "object") return undefined;
    curr = curr[tokens[i]];
  }
  return curr;
}

/**
 * View-aware smart extractor with fallback scopes across events, runs, proposals, workers, agents.
 */
export function extractRowValue(row: unknown, path: string): unknown {
  if (row == null) return undefined;

  // 1. Direct path from root
  const direct = getPathValue(row, path);
  if (direct !== undefined) return direct;

  const r = row as Record<string, any>;

  // 2. Events fallback: check envelope.payload or envelope root
  if (r.envelope) {
    if (r.envelope.payload) {
      const fromPayload = getPathValue(r.envelope.payload, path);
      if (fromPayload !== undefined) return fromPayload;
    }
    const fromEnvelope = getPathValue(r.envelope, path);
    if (fromEnvelope !== undefined) return fromEnvelope;
  }

  // 3. Proposals & Runs fallback: check spec.input or spec root
  if (r.spec) {
    if (r.spec.input) {
      const fromInput = getPathValue(r.spec.input, path);
      if (fromInput !== undefined) return fromInput;
    }
    const fromSpec = getPathValue(r.spec, path);
    if (fromSpec !== undefined) return fromSpec;
  }

  // 4. Results fallback on runs
  if (r.result) {
    const fromResult = getPathValue(r.result, path);
    if (fromResult !== undefined) return fromResult;
  }

  // 5. Workers fallback: check labels
  if (r.labels) {
    const fromLabels = getPathValue(r.labels, path);
    if (fromLabels !== undefined) return fromLabels;
  }

  // 6. Agents fallback: check limits, workspace, capabilities
  if (r.limits) {
    const fromLimits = getPathValue(r.limits, path);
    if (fromLimits !== undefined) return fromLimits;
  }
  if (r.workspace) {
    const fromWorkspace = getPathValue(r.workspace, path);
    if (fromWorkspace !== undefined) return fromWorkspace;
  }

  return undefined;
}
