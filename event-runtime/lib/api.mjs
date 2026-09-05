/**
 * Loopback control API (docs/event-runtime.md §12–§14).
 *
 * This file is deliberately only the composition root. Cohesive route groups
 * and their view builders live in api-*.mjs and status-view.mjs so unrelated
 * endpoint work no longer contends on one source file.
 */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import {
  handleArtifactApiRoute,
  TRANSCRIPT_MODEL_SCAN_BYTES,
} from "./api-artifacts.mjs";
import { handleInboxApiRoute } from "./api-inbox.mjs";
import { handleMemosApiRoute } from "./api-memos.mjs";
import {
  isLoopbackHost,
  isLoopbackOrigin,
  parseJson,
  PayloadTooLargeError,
  readBody,
  send as sendJson,
} from "./api-http.mjs";
import { handleIntakeApiRoute } from "./api-intake.mjs";
import { handleChainApiRoute } from "./api-chain.mjs";
import { handleConfigApiRoute } from "./api-config.mjs";
import { handleMetricsApiRoute } from "./api-metrics.mjs";
import { handlePanelsApiRoute } from "./api-panels.mjs";
import { createRepoApi } from "./api-repos.mjs";
import { handleRegistryApiRoute } from "./api-registry.mjs";
import {
  handleRunApiRoute,
  observedModelFromTranscript,
  repoNamesFromInput,
} from "./api-runs.mjs";
import { handleScheduleApiRoute } from "./api-schedules.mjs";
import {
  artifactInventory,
  artifactReferenceIndex,
  listArtifactPage,
  storeStats,
} from "./artifacts.mjs";
import {
  API_HOST,
  DEFAULT_PORT,
  FACTORY_ROOT,
  artifactsRoot,
  environmentName,
  runtimeHome,
  webhookSecret,
} from "./config.mjs";
import { githubWebhookSecret } from "./intake.mjs";
import {
  bindInboxProposal,
  decideInboxItem,
  getInboxItem,
  retryInboxDecision,
} from "./inbox.mjs";
import {
  applyDecisionEffect,
  decisionEffectPlanner,
  linearDecisionTransport,
} from "./decision-effects.mjs";
import { janitorArgv, spawnFactoryJanitor } from "./janitor.mjs";
import { notifyCommand, sendNotification } from "./notify.mjs";
import { loadRepos, reposRoot } from "./repos.mjs";
import { scheduleView } from "./schedules.mjs";
import { handleStatusApiRoute, workerCapacityView } from "./status-view.mjs";
import { terminateLiveWorkerLease } from "./worker.mjs";
import { IllegalTransition } from "./lifecycle.mjs";
import { loadWorkerPolicy } from "./workers.mjs";
import { loadLinearBudget } from "../../tools/ticket.mjs";

export {
  isLoopbackHost,
  isLoopbackOrigin,
  janitorArgv,
  observedModelFromTranscript,
  repoNamesFromInput,
  spawnFactoryJanitor,
  TRANSCRIPT_MODEL_SCAN_BYTES,
  workerCapacityView,
};

/**
 * Routes exempt from the bearer gate (WM-1152). Liveness stays open; the two
 * webhook intakes authenticate by their own HMAC signature (`POST /events`
 * factory HMAC, `POST /github` GitHub HMAC) — an external sender cannot present
 * a bearer, so requiring one would break intake. Every other route — including
 * the loopback `POST /replay` inject — is gated when a token is configured.
 * Exact `METHOD path` matches, so `GET /events` (list) and `POST /events/*`
 * stay gated.
 */
const BEARER_EXEMPT_ROUTES = new Set([
  "GET /health",
  "POST /events",
  "POST /github",
  // The production tunnel's /webhooks/github alias is the same GitHub HMAC
  // intake as POST /github, so it authenticates by signature and must be
  // exempt too — an external GitHub sender cannot present a bearer (WM-1150).
  "POST /webhooks/github",
]);

function payloadTooLargeBody(err) {
  if (!(err instanceof PayloadTooLargeError)) return null;
  return { error: err.code, limitBytes: err.limitBytes };
}

/**
 * Constant-time bearer check (WM-1152). Returns true only for a well-formed
 * `Authorization: Bearer <token>` whose token equals the configured one. The
 * length guard is required because timingSafeEqual throws on unequal-length
 * buffers; it leaks only the token length, never its content.
 */
function bearerAuthorized(authHeader, token) {
  if (typeof authHeader !== "string") return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const presented = Buffer.from(authHeader.slice(prefix.length), "utf8");
  const expected = Buffer.from(token, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/** Build the request handler independently so tests can compose it directly. */
export function createApi({
  db,
  registry,
  registryRef,
  secret = webhookSecret(),
  githubSecret = githubWebhookSecret(),
  now = () => Date.now(),
  policyVersion = "unknown",
  env = { name: environmentName(), home: runtimeHome(), adapter: null },
  onEvent = () => {},
  // Registries are read per request so file edits do not require a restart.
  repos = () => loadRepos(),
  workerPolicy = () => loadWorkerPolicy(),
  workerRunDir = process.env.FACTORY_RUN_DIR ??
    path.join(homedir(), ".factory", "run"),
  janitor = spawnFactoryJanitor,
  inboxSend = sendNotification,
  inboxCommand = notifyCommand(),
  inboxWebUrl = process.env.FACTORY_WEB_URL,
  inboxApplyEffect = applyDecisionEffect,
  inboxLinear = linearDecisionTransport,
  inboxPlanner = null,
  // Config inventory follows the same checkout override as repos/registry.
  configRoot = reposRoot(),
  // Root of the config/policy.yaml the run endpoints consult (tests point it elsewhere).
  policyRoot = FACTORY_ROOT,
  // Application-level bearer for the control API. Every non-exempt route
  // fails closed when this is absent and requires the matching bearer when it
  // is present. Never logged.
  controlApiToken = process.env.FACTORY_CONTROL_API_TOKEN || null,
  // Injectable only so API tests can count cache rebuilds.
  buildArtifactReferenceIndex = artifactReferenceIndex,
  buildArtifactInventory = artifactInventory,
  getTickStats = null,
  getLinearBudget = loadLinearBudget,
  // Injectable so dispatcher tests can prove a route group receives a path.
  registryApi = handleRegistryApiRoute,
} = {}) {
  const actor = "operator";
  const staticRegistryLoadedAt = new Date(now()).toISOString();
  // GET /artifacts snapshots the inventory for 10 s, so an out-of-band blob
  // removal can remain listed until that snapshot expires.
  const storeStatsTtlMs = 10_000;
  let cachedStoreStats = null;
  let cachedStoreStatsAt = 0;
  let cachedArtifactReferences = null;
  let cachedArtifactResultsRowid = null;
  let cachedArtifactInventory = null;
  let cachedArtifactInventoryAt = 0;
  const repoApi = createRepoApi({ repos, db, configRoot });

  function getStoreStats(nowMs) {
    if (cachedStoreStats && nowMs - cachedStoreStatsAt < storeStatsTtlMs)
      return cachedStoreStats;
    cachedStoreStats = storeStats(db, artifactsRoot(env?.home), { now: nowMs });
    cachedStoreStatsAt = nowMs;
    return cachedStoreStats;
  }

  function clearStoreStats() {
    cachedStoreStats = null;
    cachedStoreStatsAt = 0;
  }

  function clearArtifactPage() {
    cachedArtifactReferences = null;
    cachedArtifactResultsRowid = null;
    cachedArtifactInventory = null;
    cachedArtifactInventoryAt = 0;
  }

  function sameArtifactShaSet(previous, current) {
    if (previous.length !== current.length) return false;
    const seen = new Set(previous.map((entry) => entry.sha256));
    return current.every((entry) => seen.has(entry.sha256));
  }

  function getArtifactPage(options, nowMs) {
    const storeRoot = artifactsRoot(env?.home);
    const resultsRowid =
      db.query(`SELECT MAX(rowid) AS rowid FROM results`).get().rowid ?? 0;
    const resultsChanged = resultsRowid !== cachedArtifactResultsRowid;
    const inventoryStale =
      resultsChanged ||
      !cachedArtifactInventory ||
      nowMs - cachedArtifactInventoryAt >= storeStatsTtlMs;
    let inventoryChanged = false;
    if (inventoryStale) {
      const inventory = buildArtifactInventory(storeRoot);
      // A TTL refresh that finds the same blob set leaves the reference
      // index valid: only a changed sha set can add or drop references.
      inventoryChanged =
        !cachedArtifactInventory ||
        !sameArtifactShaSet(cachedArtifactInventory, inventory);
      cachedArtifactInventory = inventory;
      cachedArtifactInventoryAt = nowMs;
    }
    if (resultsChanged || inventoryChanged || !cachedArtifactReferences) {
      cachedArtifactReferences = buildArtifactReferenceIndex(
        db,
        cachedArtifactInventory,
      );
      cachedArtifactResultsRowid = resultsRowid;
    }
    return listArtifactPage(db, storeRoot, {
      ...options,
      references: cachedArtifactReferences,
      inventory: cachedArtifactInventory,
    });
  }

  return async function handle(req, res) {
    try {
      if (!isLoopbackHost(req.headers.host)) {
        return sendJson(res, 403, { error: "invalid_host" });
      }
      const originHeader = req.headers.origin;
      if (originHeader && !isLoopbackOrigin(originHeader)) {
        return sendJson(res, 403, { error: "cross_origin_rejected" });
      }

      const url = new URL(req.url, `http://${API_HOST}`);
      const route = `${req.method} ${url.pathname}`;

      // Reject before any work or body read, so an uncredentialed caller never
      // triggers side effects. Loopback is a network boundary, not an
      // authentication mechanism.
      if (!BEARER_EXEMPT_ROUTES.has(route)) {
        if (!controlApiToken) {
          return sendJson(res, 503, { error: "control_api_token_unset" });
        }
        if (!bearerAuthorized(req.headers.authorization, controlApiToken)) {
          return sendJson(res, 401, { error: "unauthorized" });
        }
      }

      const nowMs = now();
      // One coherent snapshot per request.  A swap between requests is
      // visible immediately; a swap during a request cannot mix definitions.
      const currentRegistry = registryRef?.current ?? registry;
      const registryState = registryRef?.state?.() ?? {
        loadedAt: staticRegistryLoadedAt,
        stamp: null,
        lastReloadError: null,
      };
      const send = (status, body) => sendJson(res, status, body);
      const common = {
        route,
        req,
        res,
        url,
        db,
        registry: currentRegistry,
        registryHealth: registryState,
        secret,
        githubSecret,
        policyVersion,
        env,
        repos: repoApi.repos,
        workerPolicy,
        workerRunDir,
        nowMs,
        actor,
        onEvent,
        getTickStats,
        getLinearBudget,
        send,
        readBody,
        parseJson,
      };

      if (
        [
          "GET /health",
          "POST /events",
          "POST /github",
          // Production Cloudflare tunnel forwards the literal path
          // /webhooks/github (no rewrite), so it is an alias of POST /github.
          "POST /webhooks/github",
          "POST /replay",
        ].includes(route)
      ) {
        return await handleIntakeApiRoute(common);
      }
      if (url.pathname === "/inbox" || url.pathname.startsWith("/inbox/")) {
        const detailMatch = url.pathname.match(/^\/inbox\/([^/]+)$/);
        if (req.method === "GET" && detailMatch) {
          const item = getInboxItem(db, decodeURIComponent(detailMatch[1]));
          return item ? send(200, { item }) : send(404, { error: "not_found" });
        }

        const decisionMatch = url.pathname.match(
          /^\/inbox\/([^/]+)\/decide(?:\/(retry))?$/,
        );
        if (req.method === "POST" && decisionMatch) {
          const id = decodeURIComponent(decisionMatch[1]);
          try {
            let result;
            const applyEffect = (effectDb, item, response) =>
              inboxApplyEffect(effectDb, item, response, {
                linear: inboxLinear,
                planner:
                  inboxPlanner ??
                  decisionEffectPlanner(currentRegistry, {
                    onEvent,
                    policyVersion,
                  }),
                now: nowMs,
              });
            if (decisionMatch[2] === "retry") {
              const raw = await readBody(req);
              if (raw.length > 0) {
                const parsed = parseJson(raw);
                if (parsed.error)
                  return send(400, {
                    error: "invalid_json",
                    message: parsed.error,
                  });
              }
              result = await retryInboxDecision(db, id, {
                now: nowMs,
                applyEffect,
              });
            } else {
              const parsed = parseJson(await readBody(req));
              if (parsed.error)
                return send(400, {
                  error: "invalid_json",
                  message: parsed.error,
                });
              result = await decideInboxItem(db, id, parsed.value, {
                now: nowMs,
                decidedBy: actor,
                applyEffect,
              });
            }
            return send(200, result);
          } catch (err) {
            const body = payloadTooLargeBody(err);
            if (body) return send(413, body);
            const status = Number(err?.status) || 400;
            return send(status, {
              error: err?.code ?? "invalid_response",
              message: err?.message ?? String(err),
              ...(err?.errors ? { errors: err.errors } : {}),
            });
          }
        }

        const result = await handleInboxApiRoute({
          ...common,
          inboxCommand,
          inboxSend,
          inboxWebUrl,
        });
        if (result !== false) return result;
      }
      if (route === "GET /status" || route === "GET /workers") {
        return handleStatusApiRoute({ ...common, getStoreStats });
      }
      // Keep the established stale-lease recovery request below in api-runs.
      // A deliberate workspace termination opts in with `terminate: true`: it
      // cancels the active run, which aborts its executor and lets normal run
      // cleanup remove the worktree rather than merely expiring its lease.
      const workspaceRelease = url.pathname.match(
        /^\/workers\/([^/]+)\/release$/,
      );
      if (
        req.method === "POST" &&
        workspaceRelease &&
        url.searchParams.get("terminate") === "true"
      ) {
        const parsed = parseJson(await readBody(req));
        if (parsed.error) return send(400, { error: "invalid_json" });
        const body = parsed.value ?? {};
        if (typeof body.runId !== "string" || body.runId === "")
          return send(422, { error: "runId required" });
        const workerId = decodeURIComponent(workspaceRelease[1]);
        const worker = db
          .query(`SELECT state, current_run FROM workers WHERE worker_id = ?`)
          .get(workerId);
        if (!worker) return send(404, { error: `unknown worker ${workerId}` });
        if (worker.state === "stopped" || worker.current_run !== body.runId) {
          return send(409, {
            error: `worker ${workerId} does not hold ${body.runId}`,
          });
        }
        try {
          const outcome = terminateLiveWorkerLease(
            db,
            { workerId, runId: body.runId },
            { actor, now: nowMs, policyVersion },
          );
          if (!outcome.released) {
            // A run that finished between the operator's click and this
            // request has nothing left to terminate. Answer in operator
            // terms — what state the run reached — rather than leaking the
            // state machine's own wording.
            return send(409, {
              error: `run ${body.runId} already finished (${outcome.state ?? "unknown state"}); nothing to terminate`,
            });
          }
          return send(200, {
            released: true,
            runId: outcome.runId,
            terminated: true,
          });
        } catch (err) {
          if (String(err.message).startsWith("unknown run"))
            return send(404, { error: err.message });
          // A concurrent settlement can still race the delegated cancel.
          if (err instanceof IllegalTransition) {
            return send(409, {
              error: `run ${body.runId} already finished (${err.from ?? "unknown state"}); nothing to terminate`,
            });
          }
          return send(409, { error: err.message });
        }
      }
      if (route === "GET /config") {
        return handleConfigApiRoute({
          ...common,
          root: configRoot,
          now: nowMs,
          registryLoadedAt: registryState.loadedAt,
        });
      }
      if (route === "GET /memos") {
        const result = handleMemosApiRoute({
          ...common,
          artifactsDir: artifactsRoot(env?.home),
        });
        if (result !== false) return result;
      }
      if (
        url.pathname === "/metrics" ||
        url.pathname === "/metrics/breakdown"
      ) {
        const result = handleMetricsApiRoute(common);
        if (result !== false) return result;
      }
      if (url.pathname === "/chains" || url.pathname.startsWith("/chain/")) {
        const result = handleChainApiRoute(common);
        if (result !== false) return result;
      }
      if (
        url.pathname === "/events" ||
        url.pathname.startsWith("/events/") ||
        url.pathname === "/proposals" ||
        url.pathname.startsWith("/proposals/") ||
        url.pathname === "/journal" ||
        url.pathname === "/outbox" ||
        url.pathname === "/runs" ||
        url.pathname.startsWith("/runs/") ||
        url.pathname === "/tickets" ||
        url.pathname.startsWith("/tickets/") ||
        url.pathname.startsWith("/workers/")
      ) {
        const result = await handleRunApiRoute({
          ...common,
          artifactsDir: artifactsRoot(env?.home),
          policyRoot,
        });
        if (result !== false) return result;
      }
      if (
        url.pathname === "/schedules" ||
        url.pathname.startsWith("/schedules/")
      ) {
        const triggerMatch = url.pathname.match(
          /^\/schedules\/([^/]+)\/(run|trigger)$/,
        );
        const scheduleSend = (status, body) => {
          if (req.method !== "POST" || status !== 200 || !triggerMatch) {
            return send(status, body);
          }
          const loop = decodeURIComponent(triggerMatch[1]);
          const schedule = scheduleView(db, currentRegistry, {
            now: nowMs,
          }).find((item) => item.loop === loop);
          if (!schedule) return send(status, body);
          const repo = currentRegistry.schedules?.[loop]?.payload?.repo;
          if (
            loop.startsWith("ship-") &&
            typeof repo === "string" &&
            repo !== "" &&
            typeof body?.proposalId === "string"
          ) {
            bindInboxProposal(db, {
              kind: "RC READY",
              repo,
              proposalId: body.proposalId,
            });
          }
          return send(status, {
            ...body,
            schedule: {
              ...schedule,
              repo: typeof repo === "string" && repo !== "" ? repo : null,
            },
          });
        };
        const result = await handleScheduleApiRoute({
          ...common,
          send: scheduleSend,
        });
        if (result !== false) return result;
      }
      if (url.pathname === "/panels") {
        const result = handlePanelsApiRoute(common);
        if (result !== false) return result;
      }
      if (url.pathname === "/repos" || url.pathname.startsWith("/repos/")) {
        const result = await repoApi.handle(common);
        if (result !== false) return result;
      }
      if (
        url.pathname === "/agents" ||
        url.pathname === "/overrides" ||
        url.pathname.startsWith("/overrides/") ||
        url.pathname.startsWith("/promotion/") ||
        url.pathname === "/repos" ||
        url.pathname.startsWith("/repos/")
      ) {
        const result = await registryApi({ ...common, janitor });
        if (result !== false) return result;
      }
      if (
        url.pathname === "/artifacts" ||
        url.pathname.startsWith("/artifacts/")
      ) {
        const result = await handleArtifactApiRoute({
          ...common,
          clearStoreStats,
          clearArtifactPage,
          getArtifactPage,
        });
        if (result !== false) return result;
      }
      return send(404, { error: `no route: ${route}` });
    } catch (err) {
      // Never leak a stack trace across the API boundary.
      const body = payloadTooLargeBody(err);
      if (!res.headersSent && body) sendJson(res, 413, body);
      else if (!res.headersSent)
        sendJson(res, 500, { error: "internal_error" });
      else res.end();
    }
  };
}

/** Start the control API on loopback by default. */
export function startApi({
  port = DEFAULT_PORT,
  host = API_HOST,
  ...opts
} = {}) {
  const server = http.createServer(createApi(opts));
  server.listen(port, host);
  return server;
}
