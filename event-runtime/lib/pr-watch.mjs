/**
 * Observe-only GitHub PR-watch webhook pubsub hub (GH-2465).
 *
 * Pure, dependency-free in-memory ring buffer and subscriber fan-out for thin
 * GitHub PR/check wakeups. Never mutates planner state or spawns workflows.
 */

const CHECK_EVENTS = new Set(["check_suite", "check_run", "workflow_run"]);
const PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "closed",
]);

function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function extractPrNumbers(pullRequests) {
  if (!Array.isArray(pullRequests)) return [];
  const seen = new Set();
  for (const item of pullRequests) {
    const num = positiveInt(item?.number);
    if (num !== null) seen.add(num);
  }
  return [...seen];
}

/**
 * Extract thin PR-watch wakeup objects from a verified GitHub webhook payload.
 * Returns `[]` for unhandled events/actions or missing repository identity.
 *
 * @param {string} githubEvent - Value of `x-github-event`.
 * @param {unknown} payload - Parsed JSON webhook body.
 * @param {{ deliveryId?: string | null, at?: string }} [options]
 * @returns {Array<{
 *   repo: string,
 *   pr: number | null,
 *   headSha: string | null,
 *   githubEvent: string,
 *   action: string,
 *   conclusion: string | null,
 *   deliveryId: string | null,
 *   at: string,
 * }>}
 */
export function extractPrWatchEvents(
  githubEvent,
  payload,
  { deliveryId = null, at = new Date().toISOString() } = {},
) {
  if (
    typeof githubEvent !== "string" ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return [];
  }

  const repo = nonEmptyString(payload.repository?.full_name);
  if (!repo) return [];

  const action = nonEmptyString(payload.action);
  if (!action) return [];

  const normalizedDeliveryId = nonEmptyString(deliveryId);
  const timestamp = nonEmptyString(at) ?? new Date().toISOString();

  if (CHECK_EVENTS.has(githubEvent)) {
    if (action !== "completed") return [];
    const subject = payload[githubEvent];
    if (!subject || typeof subject !== "object" || Array.isArray(subject)) {
      return [];
    }
    const headSha = nonEmptyString(subject.head_sha);
    const conclusion = nonEmptyString(subject.conclusion);
    const prNumbers = extractPrNumbers(subject.pull_requests);
    const targets = prNumbers.length > 0 ? prNumbers : [null];
    return targets.map((pr) => ({
      repo,
      pr,
      headSha,
      githubEvent,
      action,
      conclusion,
      deliveryId: normalizedDeliveryId,
      at: timestamp,
    }));
  }

  if (githubEvent === "pull_request") {
    if (!PULL_REQUEST_ACTIONS.has(action)) return [];
    const prObj = payload.pull_request;
    if (!prObj || typeof prObj !== "object" || Array.isArray(prObj)) {
      return [];
    }
    const pr = positiveInt(prObj.number);
    const headSha = nonEmptyString(prObj.head?.sha);
    const conclusion = prObj.merged === true ? "merged" : null;
    return [
      {
        repo,
        pr,
        headSha,
        githubEvent,
        action,
        conclusion,
        deliveryId: normalizedDeliveryId,
        at: timestamp,
      },
    ];
  }

  return [];
}

function normalizePrSet(pr, prs) {
  const result = new Set();
  const addValue = (value) => {
    if (value instanceof Set || Array.isArray(value)) {
      for (const item of value) {
        const num = positiveInt(item);
        if (num !== null) result.add(num);
      }
      return;
    }
    const num = positiveInt(value);
    if (num !== null) result.add(num);
  };
  if (prs !== undefined && prs !== null) addValue(prs);
  if (pr !== undefined && pr !== null) addValue(pr);
  return result.size > 0 ? result : null;
}

function normalizeFilter(filter = {}) {
  if (!filter || typeof filter !== "object") {
    return { repo: null, prs: null, sha: null };
  }
  const repo = nonEmptyString(filter.repo);
  const sha = nonEmptyString(filter.sha);
  return {
    repo: repo ? repo.toLowerCase() : null,
    prs: normalizePrSet(filter.pr, filter.prs),
    sha: sha ? sha.toLowerCase() : null,
  };
}

function matchesFilter(event, filter) {
  if (filter.repo !== null) {
    if (typeof event.repo !== "string") return false;
    if (event.repo.toLowerCase() !== filter.repo) return false;
  }
  if (filter.prs !== null) {
    if (event.pr === null || !filter.prs.has(event.pr)) return false;
  }
  if (filter.sha !== null) {
    if (typeof event.headSha !== "string") return false;
    if (!event.headSha.toLowerCase().startsWith(filter.sha)) return false;
  }
  return true;
}

/**
 * Create a bounded, observe-only in-memory PR-watch pubsub hub.
 *
 * - `publish(event)` appends to the ring buffer (evicting oldest past
 *   `maxRecent`) and fans out to matching subscribers, isolating errors.
 * - `recent({ repo, pr, prs, sha, limit })` returns matching wakeups ordered
 *   newest-first.
 * - `subscribe(filter, listener)` returns an idempotent `unsubscribe()`
 *   function, or `null` (fail-closed) when `maxSubscribers` is reached.
 * - `stats()` returns `{ subscribers, recentCount }`.
 */
export function createPrWatchHub({
  maxRecent = 200,
  maxSubscribers = 64,
} = {}) {
  const recentCap =
    Number.isInteger(maxRecent) && maxRecent > 0 ? maxRecent : 200;
  const subscriberCap =
    Number.isInteger(maxSubscribers) && maxSubscribers > 0
      ? maxSubscribers
      : 64;

  const ring = [];
  const subscribers = new Set();

  function publish(event) {
    if (!event || typeof event !== "object") return 0;
    ring.push(event);
    if (ring.length > recentCap) {
      ring.splice(0, ring.length - recentCap);
    }
    let delivered = 0;
    for (const sub of [...subscribers]) {
      if (!matchesFilter(event, sub.filter)) continue;
      try {
        sub.listener(event);
        delivered += 1;
      } catch {
        // A broken subscriber must never crash webhook intake or block others.
      }
    }
    return delivered;
  }

  function recent({ repo, pr, prs, sha, limit = 50 } = {}) {
    const filter = normalizeFilter({ repo, pr, prs, sha });
    const parsedLimit =
      Number.isInteger(limit) && limit >= 0
        ? Math.min(limit, recentCap)
        : Math.min(50, recentCap);
    if (parsedLimit === 0) return [];
    const matched = [];
    for (let i = ring.length - 1; i >= 0 && matched.length < parsedLimit; i--) {
      const event = ring[i];
      if (matchesFilter(event, filter)) matched.push(event);
    }
    return matched;
  }

  function subscribe(filter, listener) {
    if (typeof listener !== "function") {
      throw new TypeError("prWatch.subscribe requires a listener function");
    }
    if (subscribers.size >= subscriberCap) {
      return null;
    }
    const entry = {
      filter: normalizeFilter(filter),
      listener,
    };
    subscribers.add(entry);
    let active = true;
    return function unsubscribe() {
      if (!active) return;
      active = false;
      subscribers.delete(entry);
    };
  }

  function stats() {
    return {
      subscribers: subscribers.size,
      recentCount: ring.length,
    };
  }

  return {
    publish,
    recent,
    subscribe,
    stats,
  };
}
