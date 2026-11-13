/**
 * Runtime-managed repository registry routes (gh-1639).
 *
 * The host registry file (`config/repos.yaml`) is the single source of truth:
 * every mutation is written through to it atomically and validated with the
 * real loader before it is committed, so a restart sees exactly what the API
 * reported and an invalid write never reaches disk.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadInRepoConfig,
  loadRepos,
  RepoError,
  reposConfigPath,
  reposRoot,
  reposView,
} from "./repos.mjs";

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
/** API field → host registry key. */
const HOST_KEYS = {
  name: "name",
  github: "github",
  path: "path",
  controlPlane: "control_plane",
  base: "base",
  reportOnly: "report_only",
  maxInFlight: "max_in_flight",
  runnerLabels: "runner_labels",
};
const HOST_CONFIG_SNAPSHOT = Symbol("host config snapshot");

class HostConfigConflictError extends RepoError {}

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
    Object.hasOwn(value, "path") &&
    !path.isAbsolute(value.path) &&
    value.path !== "~" &&
    !value.path.startsWith("~/")
  )
    return "path must be absolute or ~-prefixed";
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

/**
 * Re-read one checkout's in-repo overlay. The loader is uncached — every
 * `repos()` call parses `.factory.yaml` afresh — so this is the whole of what
 * a "sync" can do: read it now and report whether it is being applied.
 */
function readOverlay(repo) {
  if (typeof repo.path !== "string" || !repo.path)
    return { status: "absent", error: null };
  try {
    const config = loadInRepoConfig(repo.path);
    return config
      ? { status: "applied", error: null }
      : { status: "absent", error: null };
  } catch (err) {
    if (!(err instanceof RepoError)) throw err;
    // Mirrors loadRepos: a malformed overlay is ignored, host config applies.
    return { status: "ignored", error: err.message };
  }
}

function repositoryHealth(repo) {
  if (typeof repo.path !== "string" || !repo.path) {
    return { status: "unconfigured", path: null };
  }
  return existsSync(repo.path)
    ? { status: "healthy", path: repo.path }
    : { status: "missing_checkout", path: repo.path };
}

/**
 * Active runs naming this repo, filtered in SQL rather than by parsing every
 * active spec in JS. A run names its repo the same three ways
 * `repoNamesFromInput` (api-runs.mjs) recognises: `input.repo`,
 * `input.repoPin.repo`, and `input.repos[]` entries (string or `{name}`).
 * `json_valid` guards the JSON functions: a malformed historic spec must not
 * make the registry unreadable.
 */
function activeRunCount(db, name) {
  const placeholders = ACTIVE_RUN_STATES.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM runs
       WHERE state IN (${placeholders})
         AND json_valid(spec_json)
         AND (
           json_extract(spec_json, '$.input.repo') = ?
           OR json_extract(spec_json, '$.input.repoPin.repo') = ?
           OR EXISTS (
             SELECT 1 FROM json_each(spec_json, '$.input.repos') AS entry
             WHERE entry.value = ?
               OR (entry.type = 'object'
                   AND json_extract(entry.value, '$.name') = ?)
           )
         )`,
    )
    .get(...ACTIVE_RUN_STATES, name, name, name, name);
  return row?.n ?? 0;
}

function hostConfigError(message, file) {
  // The loader names the scratch copy it validated; report the real file.
  return message.split(file).join("config/repos.yaml");
}

function localReposConfigPath(root) {
  return path.join(root, "config", "repos.yaml");
}

/**
 * Read the effective host registry as raw YAML (the loader's projection drops
 * keys it does not model, and a write must not lose them). A read that falls
 * back to the tracked example still records the local path as its write
 * target: mutations explicitly fork the example into operator-owned config.
 */
function readHostConfig(root) {
  const file = reposConfigPath(root);
  const target = localReposConfigPath(root);
  if (!existsSync(file)) {
    const parsed = { repos: [] };
    Object.defineProperty(parsed, HOST_CONFIG_SNAPSHOT, {
      value: { file, target, contents: null, stat: null },
    });
    return parsed;
  }
  const contents = readFileSync(file, "utf8");
  const parsed = Bun.YAML.parse(contents);
  if (!isObject(parsed))
    throw new RepoError(`${file}: repos config must be a YAML mapping`);
  if (parsed.repos === undefined || parsed.repos === null) parsed.repos = [];
  if (!Array.isArray(parsed.repos))
    throw new RepoError(`${file}: repos must be a list`);
  Object.defineProperty(parsed, HOST_CONFIG_SNAPSHOT, {
    value: { file, target, contents, stat: statSync(file) },
  });
  return parsed;
}

function hostConfigUnchanged(snapshot) {
  if (!snapshot?.stat) return !existsSync(snapshot?.file);
  if (!existsSync(snapshot.file)) return false;
  const current = statSync(snapshot.file);
  const sourceUnchanged =
    readFileSync(snapshot.file, "utf8") === snapshot.contents &&
    current.dev === snapshot.stat.dev &&
    current.ino === snapshot.stat.ino &&
    current.size === snapshot.stat.size &&
    current.mtimeMs === snapshot.stat.mtimeMs &&
    current.ctimeMs === snapshot.stat.ctimeMs;
  return (
    sourceUnchanged &&
    (snapshot?.target === snapshot?.file || !existsSync(snapshot?.target))
  );
}

function assertHostConfigUnchanged(snapshot) {
  if (!hostConfigUnchanged(snapshot)) {
    throw new HostConfigConflictError(
      "config/repos.yaml changed while this request was pending; retry the request",
    );
  }
}

/**
 * Validate `config` with the real loader, then commit it atomically to the
 * local `config/repos.yaml` (tmp file + rename). Throws RepoError without
 * touching the registry when the loader rejects the result.
 */
function writeHostConfig(root, config) {
  const yaml = Bun.YAML.stringify(config, null, 2);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "factory-repos-"));
  try {
    const scratchFile = path.join(scratch, "config", "repos.yaml");
    mkdirSync(path.dirname(scratchFile), { recursive: true });
    writeFileSync(scratchFile, yaml);
    try {
      loadRepos({ root: scratch });
    } catch (err) {
      if (!(err instanceof RepoError)) throw err;
      throw new RepoError(hostConfigError(err.message, scratchFile));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const snapshot = config[HOST_CONFIG_SNAPSHOT];
  const target = snapshot?.target ?? localReposConfigPath(root);
  if (snapshot?.file && snapshot.file !== target) {
    console.warn(
      `warning: ${snapshot.file} is an example fallback; writing registry changes to ${target}`,
    );
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = openSync(tmp, "w", snapshot?.stat?.mode & 0o777 || 0o666);
    if (snapshot?.stat) fchmodSync(fd, snapshot.stat.mode & 0o777);
    writeFileSync(fd, yaml);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    assertHostConfigUnchanged(snapshot);
    renameSync(tmp, target);
    fd = openSync(path.dirname(target), "r");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

/**
 * Build the repository management routes. `repos()` is the loader projection
 * read per request; `configRoot` is the checkout whose `config/repos.yaml`
 * mutations are written through to (the same root `repos()` reads).
 */
export function createRepoApi({ repos, db, configRoot = reposRoot() }) {
  const syncs = new Map();

  function details(
    name,
    { current = repos(), host = readHostConfig(configRoot), counts } = {},
  ) {
    const repo = current.get(name);
    if (!repo) return null;
    const entry =
      host.repos.find((candidate) => candidate?.name === name) ?? {};
    let inFlight = counts?.get(name);
    if (inFlight === undefined) {
      inFlight = activeRunCount(db, name);
      counts?.set(name, inFlight);
    }
    const overlay = readOverlay(repo);
    return {
      name: repo.name,
      github: repo.github ?? null,
      path: repo.path ?? null,
      controlPlane: repo.controlPlane ?? null,
      base: repo.base ?? "main",
      reportOnly: repo.reportOnly === true,
      maxInFlight: repo.maxInFlight ?? null,
      runnerLabels: Array.isArray(entry.runner_labels)
        ? [...entry.runner_labels]
        : [],
      configSource: overlay.status === "applied" ? "in-repo" : "host",
      overlay,
      health: repositoryHealth(repo),
      inFlight,
      sync: syncs.get(name) ?? null,
    };
  }

  function collection() {
    const current = repos();
    const host = readHostConfig(configRoot);
    const counts = new Map();
    return {
      // The established inventory projection, unchanged for its consumers.
      repos: reposView(current),
      details: [...current.keys()].map((name) =>
        details(name, { current, host, counts }),
      ),
    };
  }

  function commit(send, mutate) {
    let config;
    try {
      config = readHostConfig(configRoot);
      mutate(config);
      writeHostConfig(configRoot, config);
    } catch (err) {
      if (err instanceof HostConfigConflictError)
        return send(409, { error: err.message });
      if (!(err instanceof RepoError)) throw err;
      return send(422, { error: err.message });
    }
    return null;
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
    if (repos().has(name))
      return send(409, { error: `repo ${name} is already registered` });
    const entry = {};
    for (const [field, key] of Object.entries(HOST_KEYS)) {
      if (Object.hasOwn(parsed.value, field)) entry[key] = parsed.value[field];
    }
    const failed = commit(send, (config) => {
      if (config.repos.some((candidate) => candidate?.name === name))
        throw new RepoError(`repo ${name} is already registered`);
      config.repos.push(entry);
    });
    if (failed) return failed;
    return send(201, { repo: details(name) });
  }

  async function handle(context) {
    try {
      return await routes(context);
    } catch (err) {
      // OPS-212/OPS-346: a missing or malformed repos.yaml is named, not
      // flattened into a bare internal_error.
      if (err instanceof RepoError)
        return context.send(500, { error: err.message });
      throw err;
    }
  }

  async function routes({ route, req, url, send, parseJson, readBody }) {
    if (route === "GET /repos") return send(200, collection());
    if (route === "POST /repos")
      return register({ req, send, parseJson, readBody });

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

    if (req.method === "POST" && action === "sync") {
      const repo = repos().get(name);
      if (!repo) return send(404, { error: `unknown repo ${name}` });
      const overlay = readOverlay(repo);
      syncs.set(name, { syncedAt: new Date().toISOString(), overlay });
      return send(200, { repo: details(name), overlay, refreshed: true });
    }

    if (req.method === "PATCH" && !action) {
      if (!repos().has(name))
        return send(404, { error: `unknown repo ${name}` });
      const parsed = parseJson(await readBody(req));
      if (parsed.error) return send(422, { error: "invalid_json" });
      const error = validateFields(parsed.value, PATCH_FIELDS);
      if (error) return send(422, { error });
      if (Object.keys(parsed.value).length === 0)
        return send(422, { error: "at least one runtime flag is required" });
      const failed = commit(send, (config) => {
        const entry = config.repos.find(
          (candidate) => candidate?.name === name,
        );
        if (!entry) throw new RepoError(`repo ${name} is not in the registry`);
        for (const [field, value] of Object.entries(parsed.value)) {
          entry[HOST_KEYS[field]] = value;
        }
      });
      if (failed) return failed;
      return send(200, { repo: details(name) });
    }

    if (req.method === "DELETE" && !action) {
      if (!repos().has(name))
        return send(404, { error: `unknown repo ${name}` });
      const inFlight = activeRunCount(db, name);
      if (inFlight > 0)
        return send(409, {
          error: `repo ${name} has ${inFlight} active run(s)`,
        });
      const failed = commit(send, (config) => {
        config.repos = config.repos.filter(
          (candidate) => candidate?.name !== name,
        );
      });
      if (failed) return failed;
      syncs.delete(name);
      return send(200, { deleted: name });
    }

    return false;
  }

  return { repos, handle };
}

export { HostConfigConflictError, readHostConfig, writeHostConfig };
