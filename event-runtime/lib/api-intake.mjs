/** Health, signed webhook intake, GitHub intake, and loopback replay. */
import {
  admitExternalEvent,
  admitSignedEvent,
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

function successfulPullRequestWorkflow({
  event,
  deliveryId,
  payload,
  repos,
  nowMs,
}) {
  const run = payload?.workflow_run;
  if (
    event !== "workflow_run" ||
    payload?.action !== "completed" ||
    run?.conclusion !== "success"
  )
    return null;
  if (!deliveryId || typeof deliveryId !== "string") {
    return { ok: false, ignored: false, reason: "missing_delivery_id" };
  }

  const repo = repoForGitHubSlug(repos, payload.repository?.full_name);
  if (!repo) return { ok: false, ignored: true, reason: "unconfigured_repo" };
  if (repo.reportOnly)
    return { ok: false, ignored: true, reason: "repo_report_only" };
  if (run.event !== "pull_request")
    return { ok: false, ignored: true, reason: "not_pull_request_head" };

  const pullRequests = Array.isArray(run.pull_requests)
    ? run.pull_requests
    : [];
  const selected = pullRequests.filter((pr) => pr?.base?.ref === repo.base);
  if (selected.length === 0)
    return { ok: false, ignored: true, reason: "not_base_branch" };
  if (selected.length !== 1)
    return { ok: false, ignored: false, reason: "ambiguous_pull_request_head" };

  const prNumber = selected[0]?.number;
  const headSha = run.head_sha;
  if (
    !Number.isInteger(prNumber) ||
    prNumber < 1 ||
    typeof headSha !== "string" ||
    headSha.trim() === ""
  ) {
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

/** The bot handle a comment must open with to be treated as a typed command. */
const COMMAND_MENTION_PREFIX = "@watt-mind-factory";
/** Label that (with unassigned + open) marks a tracker issue agent-ready. */
const AGENT_READY_LABEL = "ai:agent-ready";
/** `issues` actions that can change agent-readiness; everything else is benign. */
const ISSUE_ACTIONS = new Set([
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "reopened",
]);

/** First open PR number in `prs` whose base ref matches the repo's base, or null. */
function firstPrNumberOnBase(prs, repo) {
  if (!Array.isArray(prs)) return null;
  for (const pr of prs) {
    if (pr?.base?.ref !== repo.base) continue;
    if (Number.isInteger(pr.number) && pr.number >= 1) return pr.number;
  }
  return null;
}

/**
 * A `factory.merge.requested` envelope for `repo` (short name), optionally
 * scoped to explicit PR numbers — the registered shape merge-scan@2 consumes
 * (schemas/merge-scan.input.json). Used as the concrete reaction to every
 * "the merge lane may have changed" GitHub signal: a reopened PR, a submitted
 * review, a completed check, or the base branch moving under the open PRs.
 */
function mergeRequestedEnvelope(base, repo, prNumbers) {
  const payload = { repo: repo.name };
  if (Array.isArray(prNumbers) && prNumbers.length > 0)
    payload.prNumbers = prNumbers;
  return {
    ok: true,
    envelope: {
      ...base,
      type: "factory.merge.requested",
      subject: repo.name,
      payload,
    },
  };
}

/**
 * Map the wider GitHub webhook event set (WM-1150) to internal `factory.*`
 * events, extending the existing intake seam. Returns null for the events the
 * older `translateGitHubEvent`/`successfulPullRequestWorkflow` already own
 * (workflow_run, and pull_request actions other than `reopened`) so they fall
 * through untouched — no regression to those paths. Everything mapped here is
 * idempotent on the delivery id (eventId = deliveryId, like translateGitHubEvent),
 * so a redelivery dedupes on (source, eventId) at admission.
 *
 *   issues                       labeled/unlabeled/assigned/unassigned/reopened;
 *                                when the ticket is agent-ready (label
 *                                `ai:agent-ready`, unassigned, open) →
 *                                `factory.work.requested {repo}` (work-scan
 *                                re-scans the repo queue; the ticket drives the
 *                                readiness decision but work-scan.input takes
 *                                only {repo}). Irrelevant actions are ignored.
 *   pull_request reopened        → `factory.merge.requested` (opened/synchronize/
 *                                ready_for_review stay with translateGitHubEvent).
 *   pull_request_review submitted→ merge-lane signal `factory.merge.requested`.
 *   check_run / check_suite       completed on a PR head → advance merge gating
 *                                via `factory.merge.requested`.
 *   issue_comment /              created + body opening with the bot mention →
 *   pull_request_review_comment  recognized as a typed command but NOT admitted;
 *                                the command handler is Stage 03 (#1149), so this
 *                                is a documented benign stub (`command_recognized_stub`).
 *   push to the base branch       → lightweight "base moved" signal, realized as a
 *                                `factory.merge.requested` re-scan of the repo.
 *
 * @returns {null
 *         | { ok: true, envelope: object }
 *         | { ok: false, ignored: boolean, reason: string }}
 */
export function mapGitHubEvent({
  event,
  deliveryId,
  payload,
  repos,
  now = Date.now(),
}) {
  const ownsPullRequest =
    event === "pull_request" &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.action === "reopened";
  const OWNED = new Set([
    "issues",
    "pull_request_review",
    "check_run",
    "check_suite",
    "issue_comment",
    "pull_request_review_comment",
    "push",
  ]);
  if (!OWNED.has(event) && !ownsPullRequest) return null;

  if (!deliveryId || typeof deliveryId !== "string") {
    return { ok: false, ignored: false, reason: "missing_delivery_id" };
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { ok: false, ignored: false, reason: "malformed_payload" };
  }

  const base = {
    schemaVersion: "factory.event/v1",
    eventId: deliveryId,
    source: "github",
    occurredAt: new Date(
      typeof now === "number" ? now : Date.now(),
    ).toISOString(),
    correlationId: deliveryId,
    causationId: null,
  };
  const repo = repoForGitHubSlug(repos, payload.repository?.full_name);
  const unconfigured = {
    ok: false,
    ignored: true,
    reason: "unconfigured_repo",
  };
  const reportOnly = { ok: false, ignored: true, reason: "repo_report_only" };

  if (event === "issues") {
    if (!ISSUE_ACTIONS.has(payload.action))
      return { ok: false, ignored: true, reason: "unhandled_action" };
    if (!repo) return unconfigured;
    if (repo.reportOnly) return reportOnly;
    const issue = payload.issue;
    if (!issue || typeof issue !== "object")
      return { ok: false, ignored: false, reason: "malformed_payload" };
    const labels = Array.isArray(issue.labels)
      ? issue.labels.map((l) => (typeof l === "string" ? l : l?.name))
      : [];
    const assignees = Array.isArray(issue.assignees) ? issue.assignees : [];
    const agentReady =
      labels.includes(AGENT_READY_LABEL) &&
      assignees.length === 0 &&
      issue.state === "open";
    if (!agentReady)
      return { ok: false, ignored: true, reason: "not_agent_ready" };
    return {
      ok: true,
      envelope: {
        ...base,
        type: "factory.work.requested",
        subject: repo.name,
        payload: { repo: repo.name },
      },
    };
  }

  if (event === "pull_request") {
    // Only `reopened` reaches here; the other PR actions fall through above.
    const pr = payload.pull_request;
    if (!pr || typeof pr !== "object")
      return { ok: false, ignored: false, reason: "malformed_payload" };
    if (pr.draft === true)
      return { ok: false, ignored: true, reason: "draft_pr" };
    if (!repo) return unconfigured;
    if (pr.base?.ref !== repo.base)
      return { ok: false, ignored: true, reason: "not_base_branch" };
    if (repo.reportOnly) return reportOnly;
    const prNumbers =
      Number.isInteger(pr.number) && pr.number >= 1 ? [pr.number] : [];
    return mergeRequestedEnvelope(base, repo, prNumbers);
  }

  if (event === "pull_request_review") {
    if (payload.action !== "submitted")
      return { ok: false, ignored: true, reason: "unhandled_action" };
    if (!repo) return unconfigured;
    if (repo.reportOnly) return reportOnly;
    const pr = payload.pull_request;
    if (!pr || typeof pr !== "object")
      return { ok: false, ignored: false, reason: "malformed_payload" };
    if (pr.base?.ref !== repo.base)
      return { ok: false, ignored: true, reason: "not_base_branch" };
    const prNumbers =
      Number.isInteger(pr.number) && pr.number >= 1 ? [pr.number] : [];
    return mergeRequestedEnvelope(base, repo, prNumbers);
  }

  if (event === "check_run" || event === "check_suite") {
    if (payload.action !== "completed")
      return { ok: false, ignored: true, reason: "unhandled_action" };
    if (!repo) return unconfigured;
    if (repo.reportOnly) return reportOnly;
    const check =
      event === "check_run" ? payload.check_run : payload.check_suite;
    if (!check || typeof check !== "object")
      return { ok: false, ignored: false, reason: "malformed_payload" };
    const prNumber = firstPrNumberOnBase(check.pull_requests, repo);
    // A completed check with no PR head on the base branch (e.g. a check on the
    // base branch itself) is benign, exactly like a non-PR workflow_run.
    if (prNumber === null)
      return { ok: false, ignored: true, reason: "not_pull_request_head" };
    return mergeRequestedEnvelope(base, repo, [prNumber]);
  }

  if (event === "issue_comment" || event === "pull_request_review_comment") {
    if (payload.action !== "created")
      return { ok: false, ignored: true, reason: "unhandled_action" };
    const body = payload.comment?.body;
    if (
      typeof body !== "string" ||
      !body.trimStart().startsWith(COMMAND_MENTION_PREFIX)
    ) {
      return { ok: false, ignored: true, reason: "not_a_command" };
    }
    if (!repo) return unconfigured;
    // The typed command is recognized here, but the command handler is a later
    // ticket. Admitting an unregistered command event would park as
    // human_needed, so this is a documented benign stub until then.
    // TODO(Stage 03, #1149): admit a `factory.command.requested` event carrying
    // {repo, issue/pr number, command text} once the command handler lands.
    return { ok: false, ignored: true, reason: "command_recognized_stub" };
  }

  if (event === "push") {
    if (!repo) return unconfigured;
    if (repo.reportOnly) return reportOnly;
    if (payload.deleted === true)
      return { ok: false, ignored: true, reason: "branch_deleted" };
    const ref = payload.ref;
    const defaultBranch = payload.repository?.default_branch;
    const onBase = ref === `refs/heads/${repo.base}`;
    const onDefault =
      typeof defaultBranch === "string" &&
      defaultBranch !== "" &&
      ref === `refs/heads/${defaultBranch}`;
    if (!onBase && !onDefault)
      return { ok: false, ignored: true, reason: "not_base_branch" };
    // "Base moved" is realized as a merge re-scan: the open PRs may now need
    // rebasing or re-verification against the advanced base.
    return mergeRequestedEnvelope(base, repo, []);
  }

  return null;
}

/**
 * Decouple RESPONDING from PLANNING (WM-1162). A webhook handler must return
 * 2xx immediately; the plan signal (`onEvent` → serve's `loopTick`, whose
 * control-plane `gh` calls are blocking `spawnSync`) must run OFF the HTTP
 * response path, or a single delivery stalls serve's event loop for seconds and
 * GitHub gives up past its ~10s webhook timeout. We schedule the signal with
 * `setImmediate` so it fires only after the response has been written to the
 * socket (the check phase runs after the poll phase's I/O), never awaited before
 * responding. The event is *persisted* (admitted) before we respond, so if the
 * process dies between the response and the deferred plan, the tick loop's
 * periodic re-scan of admitted-but-unplanned events recovers it — the event is
 * never dropped, only planned slightly later.
 */
function planAfterResponse(onEvent, kind = "admitted") {
  setImmediate(() => {
    try {
      onEvent(kind);
    } catch {
      // A planning failure must never surface on the already-sent response;
      // the tick loop re-scans admitted events, so a miss here is recoverable.
    }
  });
}

export function sendPayloadMismatch(send, eventId) {
  return send(409, { error: "payload_mismatch", eventId });
}

function admit(
  db,
  registry,
  send,
  buffer,
  nowMs,
  onEvent,
  parseJson,
  admitEnvelope = admitExternalEvent,
) {
  const parsed = parseJson(buffer);
  if (parsed.error) return send(422, { errors: [parsed.error] });
  const outcome = admitEnvelope(db, registry, parsed.value, {
    now: nowMs,
  });
  if (outcome.conflict) {
    return sendPayloadMismatch(send, parsed.value.eventId);
  }
  if (!outcome.admitted && !outcome.duplicate)
    return send(422, { errors: outcome.errors });
  // Respond first, then plan off the response path (WM-1162).
  const response = send(200, {
    admitted: outcome.admitted,
    duplicate: outcome.duplicate,
    eventId: outcome.event.event_id,
  });
  if (outcome.admitted) planAfterResponse(onEvent);
  return response;
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
    return admit(
      db,
      registry,
      send,
      raw,
      nowMs,
      onEvent,
      parseJson,
      admitSignedEvent,
    );
  }

  // The production Cloudflare tunnel forwards the literal path
  // POST /webhooks/github (it does not rewrite to /github), so that path is a
  // pure alias for the GitHub webhook intake: identical signature verification,
  // event mapping, and delivery-id idempotency. Both must be in api.mjs's
  // intake route whitelist for this branch to be reached.
  if (route === "POST /github" || route === "POST /webhooks/github") {
    // The GitHub App's webhook points at this endpoint; the App's
    // webhook secret is read from FACTORY_GITHUB_WEBHOOK_SECRET (see
    // githubWebhookSecret() in intake.mjs) and every delivery is verified with
    // GitHub's raw-body HMAC scheme BEFORE the body is parsed (fail closed).
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
      mapGitHubEvent(translationInput) ??
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
    if (outcome.conflict)
      return sendPayloadMismatch(send, translated.envelope.eventId);
    if (!outcome.admitted && !outcome.duplicate)
      return send(422, { errors: outcome.errors });
    // Ack GitHub immediately; plan off the response path (WM-1162).
    const response = send(200, {
      admitted: outcome.admitted,
      duplicate: outcome.duplicate,
      eventId: outcome.event.event_id,
    });
    if (outcome.admitted) planAfterResponse(onEvent);
    return response;
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
