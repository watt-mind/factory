/**
 * ControlPlane connector — the factory's one surface for the tracker (WM-797).
 *
 * "Control plane" is the neutral word for Linear / GitHub Issues / an
 * in-memory fake: the thing that holds tickets, labels, assignees and
 * comments. Everything outside `lib/control-plane/` speaks this vocabulary
 * (`ticket`, `claim`, `transition`) and never names Linear GraphQL;
 * `linear.mjs` owns the Linear specifics, `memory.mjs` is the in-process fake
 * the contract suite and the offline demo run against, and GitHub Issues
 * (`github.mjs`, WM-798) is selected by `loadControlPlane()` (WM-955).
 *
 * The interface is trimmed to the verbs `tools/ticket.mjs` and the factory
 * loops actually use today. It grows when a call site needs a verb, not
 * before — do not design for imagined trackers here.
 *
 * Error contract: every method either returns the parsed answer or throws a
 * {@link ControlPlaneError}. `claim` is the exception that returns
 * `{ ok: false }` on a lost race — that is a protocol outcome, not a
 * transport failure. Linear has no compare-and-swap; the read-back after
 * claiming is advisory: it detects the common case, and every adapter must
 * perform and honour it. The authoritative dispatch lock is the
 * per-repository lock at `~/.factory/locks/<repo>.dispatch.lock`, shared by
 * supervisors to serialize the claim window (the mechanism shipped in #928
 * for #877).
 */

/**
 * @typedef {object} TicketLabel
 * @property {string} [id]
 * @property {string} name
 */

/**
 * @typedef {object} Ticket
 * @property {string} id
 * @property {string} identifier
 * @property {string} title
 * @property {string} [description]
 * @property {string} [url]
 * @property {{ id?: string, name: string, type?: string }|null} [state]
 * @property {{ id: string, name?: string }|null} [assignee]
 * @property {{ key: string }|null} [team]
 * @property {{ name: string }|null} [project]
 * @property {TicketLabel[]} labels
 * @property {number|null} [priority]
 *   Lower is more urgent. `null` when the tracker has no such concept, or the
 *   ticket carries no value — those sort LAST, never first, so an
 *   unprioritised workspace degrades to createdAt order rather than jumping
 *   the queue. GitHub has no priority field; its adapter reads `priority:N`
 *   labels (WM-1008).
 * @property {string[]} [blockedBy]
 *   Identifiers of tickets that block this one and are NOT finished. Empty
 *   means dispatchable. The adapter resolves "finished" against its own
 *   tracker's completion semantics, so callers never interpret workflow
 *   states themselves.
 * @property {string} [createdAt]
 * @property {string|null} [startedAt]
 * @property {string|null} [updatedAt]
 * @property {string|null} [lastCommentAt]
 */

/**
 * @typedef {object} TicketComment
 * @property {string} [id]
 * @property {string} body
 * @property {string} [createdAt]
 * @property {{ id?: string, name?: string }|null} [user]
 */

/**
 * @typedef {object} ClaimResult
 * @property {boolean} ok          true when the read-back assignee is us
 * @property {string} identifier
 * @property {string|null} assignee  display name after the read-back
 */

/**
 * @typedef {object} FileTicketOpts
 * @property {string} [team]  Required unless the selected control plane has a
 *   configured default repository/team.
 * @property {string} title
 * @property {string} [body]
 * @property {string[]} [labels]
 * @property {string} [state]       defaults to "Triage"
 * @property {string} [projectId]
 */

/**
 * @typedef {object} LabelChange
 * @property {string[]} [add]
 * @property {string[]} [remove]
 */

/**
 * @typedef {object} TransitionOpts
 * @property {string[]} [add]
 * @property {string[]} [remove]
 * @property {boolean} [unassign]
 */

/**
 * @typedef {object} ControlPlane
 * @property {"linear"|"memory"|"github"} kind
 * @property {(identifier: string) => Promise<Ticket>} getTicket
 * @property {((identifier: string) => Promise<{identifier: string, title: string|null, url: string}>)=} getTicketTitle
 *   Optional cheap read for display-only callers (#2058): title and url
 *   without the status/trust/pin reads getTicket pays for. Planes that
 *   omit it are read through getTicket instead.
 * @property {(identifier: string) => Promise<TicketComment[]>} listComments
 * @property {(opts: { team: string, project?: string, states?: string[], includeFinished?: boolean }) => Promise<Ticket[]>} listTickets
 *   Every ticket in the given factory states (default: all not-finished),
 *   in queue order — priority asc, then createdAt asc. `description`,
 *   `priority` and `blockedBy` are populated, because the dispatcher needs
 *   Owned Paths and ordering from the same read (WM-1008).
 *   `includeFinished` asks for every tracker state and is used by maintenance
 *   jobs that must find stale protocol labels even on canceled/custom states.
 * @property {(opts: { team: string, project?: string }) => Promise<Ticket[]>} listDispatchable
 *   Todo + `ai:agent-ready` + unassigned + **no open blocker**, in queue
 *   order. The same predicate AND the same ordering the dispatcher uses;
 *   agents must not invent their own. Blocker exclusion and priority order
 *   live here rather than at each call site: a caller that forgets either
 *   does not fail loudly, it silently dispatches out of order or runs a
 *   ticket whose dependency is unfinished.
 * @property {(identifier: string, opts?: { harness?: string }) => Promise<ClaimResult>} claim
 *   Move to In Progress, assign the viewer, swap claim labels, then read
 *   the assignee back. This advisory read-back detects the common case, and
 *   every adapter must perform and honour it. The authoritative dispatch
 *   lock is the per-repository lock at
 *   `~/.factory/locks/<repo>.dispatch.lock`, shared by supervisors to
 *   serialize the claim window (the mechanism shipped in #928 for #877).
 * @property {(identifier: string, body: string) => Promise<void>} comment
 * @property {(identifier: string, state: string, opts?: TransitionOpts) => Promise<void>} transition
 * @property {(identifier: string, change?: LabelChange) => Promise<void>} setLabels
 *   Linear's update takes the COMPLETE label set. Implementations compute
 *   that set from the current names plus `add`/`remove`; they must not send
 *   a delta.
 * @property {(identifier: string) => Promise<boolean>} hasOpenPullRequest
 *   Whether an open pull request in the ticket's repository closes this
 *   ticket. Implementations must fail closed: an inconclusive lookup throws,
 *   rather than returning false.
 * @property {(opts: FileTicketOpts) => Promise<{ identifier: string, url: string }>} file
 * @property {(identifier: string, markdown: string) => Promise<{ appended: boolean }>} appendDetail
 * @property {(identifier: string, body: string) => Promise<void>} replaceDetail
 *   Replace the ticket description in full. `body` must be a non-empty string;
 *   invalid bodies and unknown tickets throw {@link ControlPlaneError}.
 *   The body is written under the calling token's identity. On GitHub, a
 *   body edited by the GitHub App bot makes the planner refuse the ticket
 *   with `ticket_untrusted_author` and the ready-pin must be re-stamped
 *   (labels remove/add), so callers must run this verb with the operator
 *   PAT, never the App token.
 * @property {(query: string, variables?: object) => Promise<object>} raw
 *   Escape hatch: tracker-native query. Linear accepts GraphQL; GitHub accepts
 *   GraphQL or a leading-slash REST path (with variables as query parameters).
 *   Grows only when a call site cannot be expressed with the verbs above.
 */

/** Thrown by every ControlPlane method when the tracker could not answer. */
export class ControlPlaneError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number|null, cause?: unknown }} [details]
   */
  constructor(message, { status = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ControlPlaneError";
    /** HTTP status of the underlying call, or null when it never ran. */
    this.status = status;
  }
}

/** Implementations `loadControlPlane()` knows how to select. */
export const CONTROL_PLANE_KINDS = Object.freeze([
  "linear",
  "memory",
  "github",
]);

/**
 * Queue order, shared by every adapter (WM-1008).
 *
 * Priority ascending, then createdAt ascending. `null`/absent priority sorts
 * LAST: an unprioritised ticket must not outrank an explicitly urgent one,
 * and a workspace that never sets priority degrades to plain FIFO. Linear
 * itself uses 0 for "no priority", so 0 is normalised to null by the adapter
 * before it reaches here — otherwise "unset" would sort as most urgent, which
 * is exactly backwards.
 */
export function byQueueOrder(a, b) {
  const pa = a?.priority == null ? Number.POSITIVE_INFINITY : a.priority;
  const pb = b?.priority == null ? Number.POSITIVE_INFINITY : b.priority;
  if (pa !== pb) return pa - pb;
  const ca = a?.createdAt ?? "";
  const cb = b?.createdAt ?? "";
  if (ca && cb && ca !== cb) return ca < cb ? -1 : 1;
  return 0;
}

/** Factory states an adapter treats as "not finished" for blocker gating. */
export const OPEN_STATE_TYPES = Object.freeze(["completed", "canceled"]);
