/**
 * Loopback control API (docs/event-runtime.md §12–§14).
 *
 * This file is deliberately only the composition root. Cohesive route groups
 * and their view builders live in api-*.mjs and status-view.mjs so unrelated
 * endpoint work no longer contends on one source file.
 */
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
  readBody,
  send as sendJson,
} from "./api-http.mjs";
import { handleIntakeApiRoute } from "./api-intake.mjs";
import { handleChainApiRoute } from "./api-chain.mjs";
import { handleConfigApiRoute } from "./api-config.mjs";
import { handleMetricsApiRoute } from "./api-metrics.mjs";
import { handlePanelsApiRoute } from "./api-panels.mjs";
import { handleRegistryApiRoute } from "./api-registry.mjs";
import {
  handleRunApiRoute,
  observedModelFromTranscript,
  repoNamesFromInput,
} from "./api-runs.mjs";
import { handleScheduleApiRoute } from "./api-schedules.mjs";
import { storeStats } from "./artifacts.mjs";
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
import { loadWorkerPolicy } from "./workers.mjs";

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

/** Build the request handler independently so tests can compose it directly. */
export function createApi({
  db,
  registry,
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
} = {}) {
  const actor = "operator";
  const registryLoadedAt = new Date(now()).toISOString();
  const storeStatsTtlMs = 10_000;
  const composedInboxPlanner =
    inboxPlanner ?? decisionEffectPlanner(registry, { onEvent, policyVersion });
  let cachedStoreStats = null;
  let cachedStoreStatsAt = 0;

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
      const nowMs = now();
      const send = (status, body) => sendJson(res, status, body);
      const common = {
        route,
        req,
        res,
        url,
        db,
        registry,
        secret,
        githubSecret,
        policyVersion,
        env,
        repos,
        workerPolicy,
        workerRunDir,
        nowMs,
        actor,
        onEvent,
        send,
        readBody,
        parseJson,
      };

      if (
        [
          "GET /health",
          "POST /events",
          "POST /github",
          "POST /replay",
        ].includes(route)
      ) {
        return handleIntakeApiRoute(common);
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
                planner: composedInboxPlanner,
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
              result = retryInboxDecision(db, id, {
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
              result = decideInboxItem(db, id, parsed.value, {
                now: nowMs,
                decidedBy: actor,
                applyEffect,
              });
            }
            return send(200, result);
          } catch (err) {
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
      if (route === "GET /config") {
        return handleConfigApiRoute({
          ...common,
          root: configRoot,
          now: nowMs,
          registryLoadedAt,
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
          const schedule = scheduleView(db, registry, { now: nowMs }).find(
            (item) => item.loop === loop,
          );
          if (!schedule) return send(status, body);
          const repo = registry.schedules?.[loop]?.payload?.repo;
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
      if (
        url.pathname === "/agents" ||
        url.pathname === "/overrides" ||
        url.pathname.startsWith("/overrides/") ||
        url.pathname === "/repos" ||
        url.pathname.startsWith("/repos/")
      ) {
        const result = await handleRegistryApiRoute({ ...common, janitor });
        if (result !== false) return result;
      }
      if (
        url.pathname === "/artifacts" ||
        url.pathname.startsWith("/artifacts/")
      ) {
        const result = await handleArtifactApiRoute({
          ...common,
          clearStoreStats,
        });
        if (result !== false) return result;
      }
      return send(404, { error: `no route: ${route}` });
    } catch {
      // Never leak a stack trace across the API boundary.
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
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
