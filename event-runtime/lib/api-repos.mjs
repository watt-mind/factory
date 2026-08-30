/** Runtime-managed repository registry routes. */
import { existsSync } from "node:fs";
import path from "node:path";

const CONTROL_PLANES = new Set(["github", "linear", "memory"]);
const ACTIVE_RUN_STATES = ["QUEUED", "LEASED", "RUNNING", "VERIFYING"];
const REGISTRATION_FIELDS = new Set([
  "name",
  "github",
  "path",
  "controlPlane",
  "base",
  "reportOnly",
  "maxInFlight",
]);
const PATCH_FIELDS = new Set([
  "maxInFlight",
  "reportOnly",
  "controlPlane",
  "runnerLabels",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validName(value) {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
  );
}

function validGithub(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
  );
}

function validateFields(value, allowed, required = []) {
  if (!isObject(value)) return "body must be a JSON object";
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) return `unknown fields: ${unknown.join(", ")}`;
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return `${key} is required`;
  }
  if (Object.hasOwn(value, "name") && !validName(value.name))
    return "name must contain only letters, numbers, dot, underscore, or hyphen";
  if (Object.hasOwn(value, "github") && !validGithub(value.github))
    return "github must be an owner/repository slug";
  if (
    Object.hasOwn(value, "path") &&
    (typeof value.path !== "string" || !value.path.trim())
  )
    return "path must be a non-empty string";
  if (
    Object.hasOwn(value, "controlPlane") &&
    !CONTROL_PLANES.has(value.controlPlane)
  )
    return "controlPlane must be one of github, linear, memory";
  if (
    Object.hasOwn(value, "base") &&
    (typeof value.base !== "string" || !value.base.trim())
  )
    return "base must be a non-empty string";
  if (
    Object.hasOwn(value, "reportOnly") &&
    typeof value.reportOnly !== "boolean"
  )
    return "reportOnly must be a boolean";
  if (
    Object.hasOwn(value, "maxInFlight") &&
    (!Number.isInteger(value.maxInFlight) || value.maxInFlight < 1)
  )
    return "maxInFlight must be a positive integer";
  if (Object.hasOwn(value, "runnerLabels")) {
    if (
      !Array.isArray(value.runnerLabels) ||
      value.runnerLabels.some(
        (label) => typeof label !== "string" || !label.trim(),
      )
    )
      return "runnerLabels must be an array of non-empty strings";
  }
  return null;
}

function hasInRepoConfig(repo) {
  if (typeof repo.path !== "string") return false;
  return [".factory.yaml", ".factory/config.yaml"].some((file) =>
    existsSync(path.join(repo.path, file)),
  );
}

function repositoryHealth(repo) {
  if (typeof repo.path !== "string" || !repo.path) {
    return { status: "unconfigured", path: null };
  }
  return existsSync(repo.path)
    ? { status: "healthy", path: repo.path }
    : { status: "missing_checkout", path: repo.path };
}

function activeCounts(db) {
  const counts = new Map();
  const placeholders = ACTIVE_RUN_STATES.map(() => "?").join(", ");
  const rows = db
    .query(`SELECT spec_json FROM runs WHERE state IN (${placeholders})`)
    .all(...ACTIVE_RUN_STATES);
  for (const row of rows) {
    try {
      const name = JSON.parse(row.spec_json)?.input?.repo;
      if (typeof name === "string")
        counts.set(name, (counts.get(name) ?? 0) + 1);
    } catch {
      // A malformed historic run must not make the registry unreadable.
    }
  }
  return counts;
}

function response(repo, { dynamic, source, flags, inFlight }) {
  const effective = { ...repo, ...flags };
  return {
    name: effective.name,
    github: effective.github ?? null,
    path: effective.path ?? null,
    controlPlane: effective.controlPlane ?? null,
    base: effective.base ?? "main",
    reportOnly: effective.reportOnly === true,
    maxInFlight: effective.maxInFlight ?? null,
    runnerLabels: effective.runnerLabels ?? [],
    configSource: dynamic
      ? "runtime"
      : hasInRepoConfig(repo)
        ? "in-repo"
        : "host",
    health: repositoryHealth(effective),
    inFlight: inFlight ?? 0,
    sync: source?.syncedAt ?? null,
  };
}

/**
 * Build the mutable, process-local registry used by the control API. Host
 * entries remain the baseline; runtime additions, removals, and allowed
 * runtime flags are layered over a fresh host read on each request.
 */
export function createRepoApi({ repos, db }) {
  const additions = new Map();
  const removals = new Set();
  const flags = new Map();
  const syncs = new Map();

  function registry() {
    const current = new Map(repos());
    for (const name of removals) current.delete(name);
    for (const [name, repo] of additions) current.set(name, { ...repo });
    for (const [name, patch] of flags) {
      const repo = current.get(name);
      if (repo) current.set(name, { ...repo, ...patch });
    }
    return current;
  }

  function details(name) {
    const base = repos();
    const repo = registry().get(name);
    if (!repo) return null;
    const inFlight = activeCounts(db).get(name) ?? 0;
    return response(repo, {
      dynamic: additions.has(name),
      source: syncs.get(name),
      flags: flags.get(name) ?? {},
      inFlight,
      host: base.get(name),
    });
  }

  async function handle({ route, req, url, send, parseJson, readBody }) {
    if (route === "GET /repos") {
      // Keep the established collection projection byte-compatible; the
      // existing registry handler supplies it below. Per-repository GET adds
      // operational state without widening that public inventory response.
      return false;
    }

    const match = url.pathname.match(/^\/repos\/([^/]+)(?:\/(sync))?$/);
    if (!match) return false;
    const name = decodeURIComponent(match[1]);
    const action = match[2] ?? null;

    if (req.method === "GET" && !action) {
      const item = details(name);
      return item
        ? send(200, { repo: item })
        : send(404, { error: `unknown repo ${name}` });
    }

    if (req.method === "POST" && !action && url.pathname === "/repos") {
      return false;
    }

    if (req.method === "POST" && action === "sync") {
      const repo = registry().get(name);
      if (!repo) return send(404, { error: `unknown repo ${name}` });
      // `repos()` is deliberately read on every request. Calling it here
      // re-fetches the in-repo overlay before recording the invalidation.
      repos();
      syncs.set(name, {
        syncedAt: new Date().toISOString(),
        invalidated: true,
      });
      return send(200, { repo: details(name), invalidated: true });
    }

    if (req.method === "PATCH" && !action) {
      if (!registry().has(name))
        return send(404, { error: `unknown repo ${name}` });
      const parsed = parseJson(await readBody(req));
      if (parsed.error) return send(422, { error: "invalid_json" });
      const error = validateFields(parsed.value, PATCH_FIELDS);
      if (error) return send(422, { error });
      if (Object.keys(parsed.value).length === 0)
        return send(422, { error: "at least one runtime flag is required" });
      flags.set(name, { ...(flags.get(name) ?? {}), ...parsed.value });
      return send(200, { repo: details(name) });
    }

    if (req.method === "DELETE" && !action) {
      if (!registry().has(name))
        return send(404, { error: `unknown repo ${name}` });
      const inFlight = activeCounts(db).get(name) ?? 0;
      if (inFlight > 0)
        return send(409, {
          error: `repo ${name} has ${inFlight} active run(s)`,
        });
      additions.delete(name);
      flags.delete(name);
      syncs.delete(name);
      if (repos().has(name)) removals.add(name);
      return send(200, { deleted: name });
    }

    return false;
  }

  async function register({ req, send, parseJson, readBody }) {
    const parsed = parseJson(await readBody(req));
    if (parsed.error) return send(422, { error: "invalid_json" });
    const error = validateFields(parsed.value, REGISTRATION_FIELDS, [
      "name",
      "github",
    ]);
    if (error) return send(422, { error });
    const { name } = parsed.value;
    if (registry().has(name))
      return send(409, { error: `repo ${name} is already registered` });
    removals.delete(name);
    additions.set(name, {
      name,
      github: parsed.value.github,
      path: parsed.value.path ?? null,
      controlPlane: parsed.value.controlPlane ?? null,
      base: parsed.value.base ?? "main",
      reportOnly: parsed.value.reportOnly === true,
      maxInFlight: parsed.value.maxInFlight ?? null,
    });
    return send(201, { repo: details(name) });
  }

  return {
    repos: registry,
    handle: async (context) => {
      if (context.route === "POST /repos") return register(context);
      return handle(context);
    },
  };
}
