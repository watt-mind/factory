/**
 * In-process control plane for `factory demo` (WM-799).
 *
 * WM-797 will land `lib/control-plane/memory.mjs` with the same seed shape
 * and verbs. This copy is scoped to the quickstart loop so the demo does
 * not wait on that ticket, and so a missing `lib/control-plane/` cannot
 * fail `bin/factory demo --dry`.
 *
 * Seed shape matches WM-797:
 *   { viewer, team, states, labels, tickets }
 * Mutations are recorded on `plane.calls`.
 */
export class ControlPlaneError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ControlPlaneError";
    this.status = status;
  }
}

const clone = (v) => structuredClone(v);
const teamOf = (key) => String(key).split("-")[0];

const AGENT_READY = "ai:agent-ready";
const IN_PROGRESS = "ai:in-progress";
const NEEDS_REVIEW = "ai:needs-review";

const agentLabel = (harness) =>
  `agent:${harness === "claude" ? "claude-code" : harness}`;

/**
 * @param {object} [seed]
 * @returns {object}
 */
export function memoryControlPlane(seed = {}) {
  const state = seed;
  state.viewer ??= { id: "user-me", name: "Ada" };
  state.team ??= { id: "team-demo", key: "DEMO" };
  state.states ??= [
    { id: "s-triage", name: "Triage" },
    { id: "s-todo", name: "Todo" },
    { id: "s-progress", name: "In Progress" },
    { id: "s-review", name: "In Review" },
    { id: "s-blocked", name: "Blocked" },
    { id: "s-done", name: "Done" },
  ];
  state.labels ??= [];
  state.tickets ??= [];
  const calls = [];
  let nextId = 1;

  const findTicket = (key) =>
    state.tickets.find((t) => t.identifier === key || t.id === key);

  const requireTicket = (key) => {
    const t = findTicket(key);
    if (!t) throw new ControlPlaneError(`no such issue: ${key}`);
    return t;
  };

  const requireState = (name, teamKey) => {
    const target = state.states.find(
      (s) => s.name.toLowerCase() === String(name).toLowerCase(),
    );
    if (!target) {
      throw new ControlPlaneError(
        `no state "${name}" on team ${teamKey} — have: ${state.states.map((s) => s.name).join(", ")}`,
      );
    }
    return target;
  };

  const asTicket = (t) =>
    clone({
      id: t.id,
      identifier: t.identifier,
      title: t.title,
      description: t.description ?? "",
      url: t.url ?? "",
      state: t.state ?? null,
      assignee: t.assignee ?? null,
      team: t.team ?? null,
      project: t.project ?? null,
      labels: [...(t.labels ?? [])],
    });

  const applyNames = (ticket, add, remove) => {
    const dropped = new Set(remove);
    const kept = (ticket.labels ?? [])
      .map((l) => l.name)
      .filter((n) => !dropped.has(n));
    const names = [...new Set([...kept, ...add])];
    ticket.labels = names.map((name) => {
      let row = state.labels.find((l) => l.name === name);
      if (!row) {
        row = { id: `lab-${state.labels.length + 1}`, name };
        state.labels.push(row);
      }
      return row;
    });
  };

  return {
    kind: "memory",
    calls,
    seed: state,

    async getTicket(identifier) {
      calls.push({ op: "getTicket", identifier });
      return asTicket(requireTicket(identifier));
    },

    async listComments(identifier) {
      calls.push({ op: "listComments", identifier });
      return clone(requireTicket(identifier).comments ?? []);
    },

    async listDispatchable({ team, project } = {}) {
      calls.push({ op: "listDispatchable", team, project });
      if (!team) throw new ControlPlaneError("listDispatchable requires team");
      return state.tickets
        .filter((t) => {
          if ((t.team?.key ?? teamOf(t.identifier)) !== team) return false;
          if (project && t.project?.name !== project) return false;
          if ((t.state?.name ?? "").toLowerCase() !== "todo") return false;
          if (t.assignee) return false;
          return (t.labels ?? []).some((l) => l.name === AGENT_READY);
        })
        .map(asTicket);
    },

    async claim(identifier, { harness = "fake" } = {}) {
      calls.push({ op: "claim", identifier, harness });
      const ticket = requireTicket(identifier);
      const teamKey = ticket.team?.key ?? teamOf(identifier);
      ticket.state = { ...requireState("In Progress", teamKey) };
      ticket.assignee = { ...state.viewer };
      const mine = agentLabel(harness);
      const current = (ticket.labels ?? []).map((l) => l.name);
      applyNames(
        ticket,
        [IN_PROGRESS, mine],
        [
          AGENT_READY,
          ...current.filter((n) => n.startsWith("agent:") && n !== mine),
        ],
      );
      return {
        ok: ticket.assignee?.id === state.viewer.id,
        identifier,
        assignee: ticket.assignee?.name ?? null,
      };
    },

    async comment(identifier, body) {
      calls.push({ op: "comment", identifier, body });
      if (!body) throw new ControlPlaneError("comment requires a body");
      const ticket = requireTicket(identifier);
      (ticket.comments ??= []).push({
        id: `c-${nextId++}`,
        body,
        createdAt: new Date().toISOString(),
        user: { ...state.viewer },
      });
    },

    async transition(
      identifier,
      nextState,
      { add = [], remove = [], unassign } = {},
    ) {
      calls.push({
        op: "transition",
        identifier,
        state: nextState,
        add,
        remove,
        unassign,
      });
      const ticket = requireTicket(identifier);
      if (nextState) {
        const teamKey = ticket.team?.key ?? teamOf(identifier);
        ticket.state = { ...requireState(nextState, teamKey) };
      }
      if (add.length || remove.length) applyNames(ticket, add, remove);
      if (unassign) ticket.assignee = null;
    },

    async setLabels(identifier, { add = [], remove = [] } = {}) {
      calls.push({ op: "setLabels", identifier, add, remove });
      if (!add.length && !remove.length) return;
      applyNames(requireTicket(identifier), add, remove);
    },
  };
}

export const DEMO_LABELS = {
  AGENT_READY,
  IN_PROGRESS,
  NEEDS_REVIEW,
};
