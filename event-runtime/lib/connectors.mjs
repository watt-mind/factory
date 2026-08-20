/**
 * Connectors — long-running extension processes with a narrow loopback
 * client (WM-919, docs/extensions.md § Connectors).
 *
 * An extension declares `contributes.connectors: { name: "./path.mjs" }`.
 * The loader (lib/extensions.mjs) imports and contract-checks each module
 * at load, the same way it does hooks/adapters. `serve` then calls
 * `startConnectors` after the registry is up: a `start()` that throws or
 * rejects within 10s is a configuration anomaly that disables *that
 * connector*, not the extension. Other contributions stay loaded.
 *
 * Contract of a connector module:
 *
 *   export const id = "publisher/extension:name";
 *   export default async function start(ctx) {
 *     return {
 *       stop(): Promise<void>,
 *       health(): { ok: boolean, detail?: string, lastEventAt?: string },
 *     };
 *   }
 *
 * `ctx = { config, secrets, client, log, signal }`. `client` is the only
 * runtime surface: inject (stamped `source: connector:<ext>/<name>`),
 * inbox list/get/decide/subscribe, proposals.get, runs.get. No DB handle,
 * no registry mutation. A connector cannot approve a proposal it injected;
 * the event follows the normal planner/approval path.
 *
 * Secrets never arrive through `ctx.config`. The loader resolves
 * `format: "secret"` (and heuristic `nsec|token|secret|key|password` keys)
 * from `FACTORY_EXT_<NAMESPACE>_<KEY>` / `~/.factory/secrets.env` into
 * `ctx.secrets`.
 */
import { ADAPTER_NAME_PATTERN } from "./adapters/index.mjs";
import { decideInboxItem, getInboxItem, listInboxItems } from "./inbox.mjs";
import { admitExternalEvent } from "./intake.mjs";
import { getProposal } from "./proposals.mjs";

/** Connector names match adapter names: lower-case identifiers. */
export const CONNECTOR_NAME_PATTERN = ADAPTER_NAME_PATTERN;

/** `publisher[/extension]:name`, same shape as a hook id. */
export const CONNECTOR_ID_PATTERN =
  /^[a-z0-9-]+(\/[a-z0-9-]+)?:[a-z0-9][a-z0-9-]*$/;

/** A `start()` that has not returned by then is a failed start. */
export const CONNECTOR_START_TIMEOUT_MS = 10_000;

const SECRET_KEY_HEURISTIC = /nsec|token|secret|key|password/i;

/** Typed error for a module that fails the connector contract. */
export class ConnectorError extends Error {
  /**
   * @param {string} code - `connector_module_invalid` | `connector_name_invalid`
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
  }
}

/**
 * Prove a module satisfies the connector contract without calling it: a
 * `default` export that is a function and a string `id` shaped
 * `publisher[/ext]:name`. Throws a ConnectorError naming the fault; the
 * loader turns that into the anomaly that disables the extension.
 *
 * @param {unknown} module
 * @returns {{ id: string, start: Function }}
 */
export function validateConnectorModule(module) {
  if (typeof module !== "object" || module === null) {
    throw new ConnectorError(
      "connector_module_invalid",
      "connector module must be an ES module namespace or object",
    );
  }
  if (typeof module.default !== "function") {
    throw new ConnectorError(
      "connector_module_invalid",
      "connector module must export a default async function start(ctx) → { stop, health }",
    );
  }
  if (typeof module.id !== "string" || !CONNECTOR_ID_PATTERN.test(module.id)) {
    throw new ConnectorError(
      "connector_module_invalid",
      `connector module must export a string id matching ${CONNECTOR_ID_PATTERN} (got ${JSON.stringify(module.id ?? null)})`,
    );
  }
  return { id: module.id, start: module.default };
}

/**
 * Modules the last `loadExtensions` run accepted. `startConnectors` reads
 * this; a failed start does not remove the descriptor (the extension stays
 * loaded). Replaced wholesale on every load.
 *
 * @typedef {{
 *   extension: string,
 *   name: string,
 *   id: string,
 *   module: object,
 *   config: object,
 *   secrets: object,
 * }} LoadedConnector
 */
let LOADED = [];

/** @type {LoadedConnector[]} */
export function setLoadedConnectors(list) {
  LOADED = Array.isArray(list) ? list : [];
}

export function loadedConnectors() {
  return LOADED;
}

const inboxListeners = new Set();

/**
 * Register a callback for inbox new-item / changed events. The connector
 * client's `inbox.subscribe` is this bus; tests (and a follow-up that
 * hooks lib/inbox.mjs's write path) call `emitInboxChange`.
 *
 * @param {(event: { type: string, item?: object, at?: string }) => void} cb
 * @returns {() => void} unsubscribe
 */
export function subscribeInboxWrites(cb) {
  if (typeof cb !== "function") {
    throw new ConnectorError(
      "connector_module_invalid",
      "inbox.subscribe callback must be a function",
    );
  }
  inboxListeners.add(cb);
  return () => inboxListeners.delete(cb);
}

/** Fan out an inbox write to every subscriber. Isolates callback throws. */
export function emitInboxChange(event) {
  const payload = {
    type: event?.type ?? "changed",
    item: event?.item ?? null,
    at: event?.at ?? new Date().toISOString(),
  };
  for (const cb of inboxListeners) {
    try {
      cb(payload);
    } catch {
      // A connector that throws from subscribe must not take down the others.
    }
  }
}

function clearInboxListeners() {
  inboxListeners.clear();
}

/**
 * Attribution strings a connector client stamps on the events and decisions
 * it produces. `inject` overwrites envelope.source; `inbox.decide` records
 * decidedBy. A connector has no approve() — injected events go through the
 * normal planner / approval path.
 */
export function connectorSource(extension, name) {
  return `connector:${extension}/${name}`;
}

export function connectorActor(extension, name, actor) {
  const who =
    typeof actor === "string" && actor.trim() !== "" ? actor.trim() : "unknown";
  return `connector:${extension}/${name}:${who}`;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getRun(db, id) {
  const row = db.query(`SELECT * FROM runs WHERE run_id = ?`).get(id);
  if (!row) return null;
  return {
    runId: row.run_id,
    state: row.state,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    spec: row.spec_json ? JSON.parse(row.spec_json) : null,
  };
}

/**
 * Narrow loopback client one connector may hold. The db and registry stay
 * inside this closure; the connector never receives them.
 *
 * @param {{ db: object, registry: object, extension: string, name: string }} opts
 */
export function createConnectorClient({ db, registry, extension, name }) {
  const source = connectorSource(extension, name);
  return Object.freeze({
    async inject(envelope) {
      if (
        !envelope ||
        typeof envelope !== "object" ||
        Array.isArray(envelope)
      ) {
        throw new Error("inject envelope must be an object");
      }
      const stamped = { ...envelope, source };
      return admitExternalEvent(db, registry, stamped);
    },
    inbox: Object.freeze({
      list(options = {}) {
        return listInboxItems(db, options);
      },
      get(id) {
        return getInboxItem(db, id);
      },
      decide(id, response, { actor } = {}) {
        const decidedBy = connectorActor(extension, name, actor);
        const result = decideInboxItem(db, id, response, { decidedBy });
        emitInboxChange({
          type: "changed",
          item: result?.item ?? null,
        });
        return result;
      },
      subscribe(cb) {
        return subscribeInboxWrites(cb);
      },
    }),
    proposals: Object.freeze({
      get(id) {
        return getProposal(db, id);
      },
    }),
    runs: Object.freeze({
      get(id) {
        return getRun(db, id);
      },
    }),
  });
}

/**
 * Split an extension's effective config into the public object a connector
 * may read (`config`) and the secret bag (`secrets`). `format: "secret"`
 * fields come first; remaining keys matching the heuristic are moved too
 * so a schema that predates WM-920 still does not leak credentials into
 * `ctx.config`.
 *
 * @param {object|null|undefined} values
 * @param {Array<{ path: string[] }>} secretFields
 */
export function splitConfigSecrets(values, secretFields = []) {
  const config = cloneJson(values) ?? {};
  const secrets = {};
  const move = (keyPath) => {
    let node = values;
    for (const key of keyPath) {
      if (
        node === null ||
        typeof node !== "object" ||
        !Object.hasOwn(node, key)
      )
        return;
      node = node[key];
    }
    setAt(secrets, keyPath, node);
    deleteAt(config, keyPath);
  };
  for (const field of secretFields) move(field.path);
  moveHeuristic(config, secrets, []);
  return { config, secrets };
}

function moveHeuristic(from, secrets, path) {
  if (!from || typeof from !== "object" || Array.isArray(from)) return;
  for (const [key, inner] of Object.entries(from)) {
    const next = [...path, key];
    if (SECRET_KEY_HEURISTIC.test(key) && !isPlainObject(inner)) {
      setAt(secrets, next, inner);
      delete from[key];
      continue;
    }
    moveHeuristic(inner, secrets, next);
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setAt(obj, keyPath, value) {
  let node = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keyPath[keyPath.length - 1]] = value;
}

function deleteAt(obj, keyPath) {
  let node = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    if (!isPlainObject(node[key])) return;
    node = node[key];
  }
  delete node[keyPath[keyPath.length - 1]];
}

function connectorLog(log, extension, name) {
  return (message) => {
    log(`connector ${extension}/${name}: ${message}`);
  };
}

function readHealth(handle) {
  const raw = handle.health();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "health() did not return an object" };
  }
  return {
    ok: Boolean(raw.ok),
    ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
    ...(typeof raw.lastEventAt === "string"
      ? { lastEventAt: raw.lastEventAt }
      : {}),
  };
}

/**
 * @typedef {{
 *   extension: string,
 *   name: string,
 *   id: string,
 *   handle: { stop: Function, health: Function }|null,
 *   controller: AbortController,
 *   startedAt: string|null,
 *   startError: string|null,
 * }} ConnectorInstance
 */

/** @type {ConnectorInstance[]} */
let INSTANCES = [];

function formatStartFailure(extension, name, err) {
  const msg = err?.message ?? String(err);
  return `connector ${extension}/${name} failed to start: ${msg}`;
}

function validateHandle(handle) {
  if (!handle || typeof handle !== "object" || Array.isArray(handle)) {
    throw new Error("start() must return { stop(), health() }");
  }
  if (typeof handle.stop !== "function") {
    throw new Error("start() must return a stop() function");
  }
  if (typeof handle.health !== "function") {
    throw new Error("start() must return a health() function");
  }
  return handle;
}

async function withTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start every connector the last load accepted. Per-connector: a throw,
 * rejection, bad return, or overrun of `timeoutMs` records an anomaly and
 * leaves the rest of the extension loaded. Idempotent against a previous
 * start — running instances are stopped first.
 *
 * @returns {Promise<{ instances: ConnectorInstance[], anomalies: string[] }>}
 */
export async function startConnectors({
  db,
  registry,
  log = () => {},
  timeoutMs = CONNECTOR_START_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  await stopConnectors();
  const anomalies = [];
  const instances = [];
  for (const loaded of LOADED) {
    const { extension, name, id, module, config, secrets } = loaded;
    const controller = new AbortController();
    const startedAt = new Date(now()).toISOString();
    const client = createConnectorClient({ db, registry, extension, name });
    const ctx = {
      config: cloneJson(config) ?? {},
      secrets: cloneJson(secrets) ?? {},
      client,
      log: connectorLog(log, extension, name),
      signal: controller.signal,
    };
    const start = module.default;
    const startPromise = Promise.resolve()
      .then(() => start(ctx))
      .then(validateHandle);
    try {
      const handle = await withTimeout(startPromise, timeoutMs, () =>
        controller.abort(),
      );
      instances.push({
        extension,
        name,
        id,
        handle,
        controller,
        startedAt,
        startError: null,
      });
    } catch (err) {
      controller.abort();
      startPromise.then((handle) => handle?.stop?.()).catch(() => {});
      const detail = formatStartFailure(extension, name, err);
      anomalies.push(detail);
      instances.push({
        extension,
        name,
        id,
        handle: null,
        controller,
        startedAt: null,
        startError: detail,
      });
      log(detail);
    }
  }
  INSTANCES = instances;
  return { instances, anomalies };
}

/** Stop every running connector. Isolates per-connector stop errors. */
export async function stopConnectors() {
  const running = INSTANCES;
  INSTANCES = [];
  clearInboxListeners();
  for (const inst of running) {
    inst.controller?.abort();
    if (typeof inst.handle?.stop !== "function") continue;
    try {
      await inst.handle.stop();
    } catch {
      // Shutdown must not fail because a connector's stop() threw.
    }
  }
}

/**
 * `GET /status.connectors` projection: one row per loaded connector,
 * including those that failed to start (`ok: false`, `detail` is the
 * anomaly line).
 */
export function connectorStatus() {
  return INSTANCES.map((inst) => {
    const base = {
      extension: inst.extension,
      name: inst.name,
      startedAt: inst.startedAt,
    };
    if (inst.startError || !inst.handle) {
      return {
        ...base,
        ok: false,
        detail: inst.startError ?? "not started",
        lastEventAt: undefined,
      };
    }
    try {
      const health = readHealth(inst.handle);
      return {
        ...base,
        ok: health.ok,
        ...(health.detail !== undefined ? { detail: health.detail } : {}),
        ...(health.lastEventAt !== undefined
          ? { lastEventAt: health.lastEventAt }
          : {}),
      };
    } catch (err) {
      return {
        ...base,
        ok: false,
        detail: err?.message ?? String(err),
      };
    }
  });
}
