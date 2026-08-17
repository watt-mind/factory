/** Health, signed webhook intake, GitHub intake, and loopback replay. */
import {
  admitExternalEvent,
  translateGitHubEvent,
  verifyGitHubWebhook,
  verifyWebhook,
} from "./intake.mjs";
import { RepoError } from "./repos.mjs";

function repoForGitHubSlug(repos, slug) {
  if (typeof slug !== "string" || slug === "") return null;
  for (const repo of repos.values()) {
    if (repo.github === slug) return repo;
  }
  return null;
}

function successfulPullRequestWorkflow({ event, deliveryId, payload, repos, nowMs }) {
  const run = payload?.workflow_run;
  if (event !== "workflow_run" || payload?.action !== "completed" || run?.conclusion !== "success") return null;
  if (!deliveryId || typeof deliveryId !== "string") {
    return { ok: false, ignored: false, reason: "missing_delivery_id" };
  }

  const repo = repoForGitHubSlug(repos, payload.repository?.full_name);
  if (!repo) return { ok: false, ignored: true, reason: "unconfigured_repo" };
  if (repo.reportOnly) return { ok: false, ignored: true, reason: "repo_report_only" };
  if (run.event !== "pull_request") return { ok: false, ignored: true, reason: "not_pull_request_head" };

  const pullRequests = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  const selected = pullRequests.filter((pr) => pr?.base?.ref === repo.base);
  if (selected.length === 0) return { ok: false, ignored: true, reason: "not_base_branch" };
  if (selected.length !== 1) return { ok: false, ignored: false, reason: "ambiguous_pull_request_head" };

  const prNumber = selected[0]?.number;
  const headSha = run.head_sha;
  if (!Number.isInteger(prNumber) || prNumber < 1 || typeof headSha !== "string" || headSha.trim() === "") {
    return { ok: false, ignored: false, reason: "malformed_payload" };
  }
  const eventId = `merge-pr:${repo.name}:${prNumber}:${headSha}`;
  return {
    ok: true,
    envelope: {
      schemaVersion: "factory.event/v1",
      eventId,
      type: "factory.merge.requested",
      source: "github",
      subject: repo.name,
      occurredAt: new Date(nowMs).toISOString(),
      correlationId: eventId,
      causationId: null,
      payload: { repo: repo.name, prNumbers: [prNumber] },
    },
  };
}

function admit(db, registry, send, buffer, nowMs, onEvent, parseJson) {
  const parsed = parseJson(buffer);
  if (parsed.error) return send(422, { errors: [parsed.error] });
  const outcome = admitExternalEvent(db, registry, parsed.value, {
    now: nowMs,
  });
  if (!outcome.admitted && !outcome.duplicate)
    return send(422, { errors: outcome.errors });
  if (outcome.admitted) onEvent("admitted");
  return send(200, {
    admitted: outcome.admitted,
    duplicate: outcome.duplicate,
    eventId: outcome.event.event_id,
  });
}

export async function handleIntakeApiRoute({
  route,
  req,
  db,
  registry,
  secret,
  githubSecret,
  policyVersion,
  env,
  repos,
  nowMs,
  onEvent,
  send,
  readBody,
  parseJson,
}) {
  if (route === "GET /health") {
    return send(200, {
      ok: true,
      policyVersion,
      env,
      webhookSecret: secret ? "set" : "absent",
      githubWebhookSecret: githubSecret ? "set" : "absent",
    });
  }

  if (route === "POST /events") {
    const raw = await readBody(req);
    const verdict = verifyWebhook({
      rawBody: raw,
      signature: req.headers["x-factory-signature"],
      timestamp: req.headers["x-factory-timestamp"],
      secret,
      now: nowMs,
    });
    // Fail closed: nothing is parsed, nothing is written (§14).
    if (!verdict.ok) return send(401, { error: verdict.reason });
    return admit(db, registry, send, raw, nowMs, onEvent, parseJson);
  }

  if (route === "POST /github") {
    const raw = await readBody(req);
    const verdict = verifyGitHubWebhook({
      rawBody: raw,
      signature: req.headers["x-hub-signature-256"],
      secret: githubSecret,
    });
    if (!verdict.ok) return send(401, { error: verdict.reason });
    const parsed = parseJson(raw);
    if (parsed.error) return send(422, { errors: [parsed.error] });
    let repoRegistry;
    try {
      repoRegistry = repos();
    } catch (err) {
      if (err instanceof RepoError) return send(500, { error: err.message });
      throw err;
    }
    const translationInput = {
      event: req.headers["x-github-event"],
      deliveryId: req.headers["x-github-delivery"],
      payload: parsed.value,
      repos: repoRegistry,
      now: nowMs,
    };
    const translated =
      successfulPullRequestWorkflow({ ...translationInput, nowMs }) ??
      translateGitHubEvent(translationInput);
    if (!translated.ok) {
      if (translated.ignored) {
        return send(200, {
          admitted: false,
          ignored: true,
          reason: translated.reason,
        });
      }
      return send(422, { errors: [translated.reason] });
    }
    const outcome = admitExternalEvent(db, registry, translated.envelope, {
      now: nowMs,
    });
    if (!outcome.admitted && !outcome.duplicate)
      return send(422, { errors: outcome.errors });
    if (outcome.admitted) onEvent("admitted");
    return send(200, {
      admitted: outcome.admitted,
      duplicate: outcome.duplicate,
      eventId: outcome.event.event_id,
    });
  }

  if (route === "POST /replay") {
    return admit(
      db,
      registry,
      send,
      await readBody(req),
      nowMs,
      onEvent,
      parseJson,
    );
  }

  return false;
}
