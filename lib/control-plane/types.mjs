/**
 * ControlPlane connector — the factory's one surface for the tracker (WM-797).
 *
 * "Control plane" is the neutral word for Linear / GitHub Issues / an
 * in-memory fake: the thing that holds tickets, labels, assignees and
 * comments. Everything outside `lib/control-plane/` speaks this vocabulary
 * (`ticket`, `claim`, `transition`) and never names Linear GraphQL;
 * `linear.mjs` owns the Linear specifics, `memory.mjs` is the in-process fake
 * the contract suite and the offline demo run against, and GitHub Issues
 * lands as a third implementation (WM-798).
 *
 * The interface is trimmed to the verbs `tools/linear.mjs` and the factory
 * loops actually use today. It grows when a call site needs a verb, not
 * before — do not design for imagined trackers here.
 *
 * Error contract: every method either returns the parsed answer or throws a
 * {@link ControlPlaneError}. `claim` is the exception that returns
 * `{ ok: false }` on a lost race — that is a protocol outcome, not a
 * transport failure. Linear has no compare-and-swap; the read-back after
 * claiming IS the concurrency control, and both implementations honour it.
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
 * @property {string} team
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
 * @property {"linear"|"memory"} kind
 * @property {(identifier: string) => Promise<Ticket>} getTicket
 * @property {(identifier: string) => Promise<TicketComment[]>} listComments
 * @property {(opts: { team: string, project?: string }) => Promise<Ticket[]>} listDispatchable
 *   Todo + `ai:agent-ready` + unassigned. The same predicate the dispatcher
 *   uses; agents must not invent their own.
 * @property {(identifier: string, opts?: { harness?: string }) => Promise<ClaimResult>} claim
 *   Move to In Progress, assign the viewer, swap claim labels, then read
 *   the assignee back. `ok: false` means another actor won the race.
 * @property {(identifier: string, body: string) => Promise<void>} comment
 * @property {(identifier: string, state: string, opts?: TransitionOpts) => Promise<void>} transition
 * @property {(identifier: string, change?: LabelChange) => Promise<void>} setLabels
 *   Linear's update takes the COMPLETE label set. Implementations compute
 *   that set from the current names plus `add`/`remove`; they must not send
 *   a delta.
 * @property {(opts: FileTicketOpts) => Promise<{ identifier: string, url: string }>} file
 * @property {(identifier: string, markdown: string) => Promise<{ appended: boolean }>} appendDetail
 * @property {(query: string, variables?: object) => Promise<object>} raw
 *   Escape hatch: tracker-native query (Linear GraphQL). Grows only when a
 *   call site cannot be expressed with the verbs above.
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
export const CONTROL_PLANE_KINDS = Object.freeze(["linear", "memory"]);
