/**
 * Tracker-neutral label and description helpers for the ControlPlane
 * (WM-797). Copied from the protocol `tools/linear.mjs` already enforces so
 * the Linear adapter and the memory fake share one implementation. The
 * call-site migration will import these from here instead of carrying a
 * second copy in the CLI.
 */

/** The eight values that resolve; `type:chore` fails the mutation. */
export const TYPE_LABELS = [
  "bug",
  "feature",
  "ui-ux",
  "security",
  "performance",
  "maintenance",
  "docs",
  "a11y",
];
export const SOURCE_LABELS = ["agent", "human", "sentry", "client-support"];

/** The tier keys `config/policy.yaml` accepts (docs/event-runtime-dispatch.md §"Per-ticket model tier"). */
export const TIER_LABELS = ["light", "standard", "strong"];

export const AGENT_READY_LABEL = "ai:agent-ready";
export const IN_PROGRESS_LABEL = "ai:in-progress";
export const BLOCKED_LABEL = "ai:blocked";

/** Reject label typos before the tracker does, with a useful message. */
export function validateLabels(names) {
  const bad = [];
  for (const n of names) {
    if (n.startsWith("type:") && !TYPE_LABELS.includes(n.slice(5))) {
      bad.push(`${n} — type:* must be one of ${TYPE_LABELS.join(" ")}`);
    }
    if (n.startsWith("source:") && !SOURCE_LABELS.includes(n.slice(7))) {
      bad.push(`${n} — source:* must be one of ${SOURCE_LABELS.join(" ")}`);
    }
    if (n.startsWith("tier:") && !TIER_LABELS.includes(n.slice(5))) {
      bad.push(`${n} — tier:* must be one of ${TIER_LABELS.join(" ")}`);
    }
  }
  return bad;
}

/**
 * The label set after an add/remove, as ids.
 *
 * Trackers that take the COMPLETE label set (Linear's issueUpdate) silently
 * drop every other label if you pass only the ones you want added. That is
 * the sharp edge this function exists to blunt.
 */
export function resolveLabelIds(
  currentNames,
  { add = [], remove = [] },
  allLabels,
) {
  const idOf = (n) => allLabels.find((l) => l.name === n)?.id;
  const dropped = new Set(remove);
  const kept = currentNames.filter((n) => !dropped.has(n));
  return [...new Set([...kept, ...add].map(idOf).filter(Boolean))];
}

/**
 * Harness name -> the `agent:*` label that exists in the workspace.
 *
 * The Claude harness is `claude` on the command line but `agent:claude-code`
 * in Linear, and nothing enforces that they agree. A wrong name just means
 * the ticket never says which harness holds it.
 */
export const agentLabel = (harness) =>
  `agent:${harness === "claude" ? "claude-code" : harness}`;

/**
 * Claiming drops `ai:agent-ready` and adds `ai:in-progress` + the agent label.
 * agent-ready means "waiting to be picked up" — keeping it alongside
 * ai:in-progress leaves the ticket asserting two lifecycle states at once.
 */
export function claimLabels(currentNames, harness) {
  const mine = agentLabel(harness);
  return {
    add: [IN_PROGRESS_LABEL, mine],
    remove: [
      AGENT_READY_LABEL,
      ...currentNames.filter((n) => n.startsWith("agent:") && n !== mine),
    ],
  };
}

/**
 * The exact inverse of {@link claimLabels}: give the ticket back (WM-1024).
 *
 * `to: "Todo"` must produce a **dispatchable** ticket — `Todo` + no assignee
 * is not enough, the dispatchable predicate (docs/protocol.md §4) also
 * requires `ai:agent-ready`. Releasing without it does not re-queue the
 * ticket, it makes it invisible: the board still shows `Todo`, every view
 * looks healthy, and no dispatcher will ever pick it up again. Three tickets
 * (WM-1008, WM-1015, WM-534) were lost this way in one night, each after a
 * transient test failure.
 *
 * `to: "Blocked"` is the opposite requirement: `ai:blocked` and explicitly
 * NOT `ai:agent-ready`, or a ticket a human must look at re-enters the queue
 * and loops.
 *
 * Both drop every `agent:*` label. A stale one claims a harness still holds
 * work it has already given up, which is what made the casualties look
 * claimed rather than dropped.
 *
 * @param {string[]} currentNames
 * @param {{ to?: "Todo"|"Blocked" }} [opts]
 * @returns {{ add: string[], remove: string[] }}
 */
export function releaseLabels(currentNames, { to = "Todo" } = {}) {
  const staleAgents = currentNames.filter((n) => n.startsWith("agent:"));
  if (to === "Blocked") {
    return {
      add: [BLOCKED_LABEL],
      remove: [IN_PROGRESS_LABEL, AGENT_READY_LABEL, ...staleAgents],
    };
  }
  return {
    add: [AGENT_READY_LABEL],
    remove: [IN_PROGRESS_LABEL, BLOCKED_LABEL, ...staleAgents],
  };
}

/** Build an idempotent description update for `appendDetail`. */
export function appendIssueDetail(currentDescription, rawDetail) {
  const detail = String(rawDetail ?? "").trim();
  if (!detail) throw new Error("detail must not be empty");

  const current = currentDescription ?? "";
  if (current.includes(detail))
    return { description: current, appended: false };

  const separator =
    current.length === 0 || current.endsWith("\n\n")
      ? ""
      : current.endsWith("\n")
        ? "\n"
        : "\n\n";
  return { description: `${current}${separator}${detail}\n`, appended: true };
}

/**
 * Attribution stamp (OPS-76). Factory spawns set FACTORY_RUN_ID to the
 * transcript basename; stamping it here makes every comment and filed issue
 * joinable back to the exact run that wrote it. Skipped when the id is
 * already in the body and when unset (interactive human use stays clean).
 *
 * Off by default so the public tracker timeline stays clean: run→ticket
 * attribution already lives in the runtime DB (lifecycle_events), so the
 * visible `run:<id>` tail on every comment is redundant noise. Opt back in
 * with FACTORY_COMMENT_ATTRIBUTION=1 when a deployment wants it in-band.
 */
export function stampRun(body) {
  if (process.env.FACTORY_COMMENT_ATTRIBUTION !== "1") return body;
  const id = process.env.FACTORY_RUN_ID;
  if (!id || !body || body.includes(`run:${id}`)) return body;
  return `${body}\n\nrun:${id}`;
}
