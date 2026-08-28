/**
 * Memory ControlPlane — an in-process fake satisfying the same contract as
 * `linear.mjs` (WM-797). For tests and the offline demo (WM-799).
 *
 * Seed shape:
 *   {
 *     viewer: { id, name },
 *     team: { id, key },
 *     states: [{ id, name }],
 *     labels: [{ id, name }],
 *     tickets: [{ id, identifier, title, description, url, state, assignee,
 *                 team, project, labels:[{id,name}], comments:[...] }],
 *     raw: { "<query>": object | (variables) => object },
 *     loseNextClaim: { id, name } | null,  // hijack the claim read-back
 *   }
 *
 * Every mutation is recorded on `plane.calls` so a test can assert what
 * would have been done.
 */
import { byQueueOrder, ControlPlaneError, OPEN_STATE_TYPES } from "./types.mjs";
import {
  AGENT_READY_LABEL,
  appendIssueDetail,
  claimLabels,
  resolveLabelIds,
  stampRun,
  validateLabels,
} from "./labels.mjs";

const clone = (v) => structuredClone(v);

const teamOf = (key) => String(key).split("-")[0];

/**
 * @param {object} [seed]
 * @returns {import("./types.mjs").ControlPlane & { calls: object[], seed: object }}
 */
export function memoryControlPlane(seed = {}) {
  // Mutate the caller's seed in place so tests can hijack `loseNextClaim`
  // (and inspect tickets) the same way the Linear fake gql does.
  const state = seed;
  state.viewer ??= { id: "user-me", name: "Ada" };
  state.team ??= { id: "team-wm", key: "WM" };
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
  state.raw ??= {};
  if (!("loseNextClaim" in state)) state.loseNextClaim = null;
  const calls = [];
  let nextId = 1;

  function findTicket(key) {
    return state.tickets.find((t) => t.identifier === key || t.id === key);
  }

  function requireTicket(key) {
    const t = findTicket(key);
    if (!t) throw new ControlPlaneError(`no such issue: ${key}`);
    return t;
  }

  function asTicket(t) {
    return clone({
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
      priority:
        typeof t.priority === "number" && t.priority > 0 ? t.priority : null,
      createdAt: t.createdAt ?? "",
      startedAt: t.startedAt ?? null,
      updatedAt: t.updatedAt ?? null,
      lastCommentAt:
        t.lastCommentAt ??
        t.comments?.[t.comments.length - 1]?.createdAt ??
        null,
      blockedBy: openBlockersOf(t),
    });
  }

  /**
   * Blockers named on the seed ticket that have not finished (WM-1008).
   * The fake stores them as plain identifiers (`blockedBy: ["WM-1"]`) and
   * resolves their state from the same ticket list, so the contract suite can
   * close a blocker and watch its dependent become dispatchable.
   */
  function openBlockersOf(t) {
    return (t.blockedBy ?? []).filter((id) => {
      const blocker = state.tickets.find((x) => x.identifier === id);
      if (!blocker) return true; // unknown blocker: fail closed, stay blocked
      const type = (
        blocker.state?.type ??
        (["done", "canceled", "duplicate"].includes(
          (blocker.state?.name ?? "").toLowerCase(),
        )
          ? "completed"
          : "started")
      ).toLowerCase();
      return !OPEN_STATE_TYPES.includes(type);
    });
  }

  function requireState(name, teamKey) {
    const target = state.states.find(
      (s) => s.name.toLowerCase() === String(name).toLowerCase(),
    );
    if (!target)
      throw new ControlPlaneError(
        `no state "${name}" on team ${teamKey} — have: ${state.states.map((s) => s.name).join(", ")}`,
      );
    return target;
  }

  function applyLabels(ticket, add, remove) {
    const bad = validateLabels(add);
    if (bad.length)
      throw new ControlPlaneError("invalid label(s):\n  " + bad.join("\n  "));
    const missing = add.filter((n) => !state.labels.some((l) => l.name === n));
    if (missing.length)
      throw new ControlPlaneError(
        `label(s) do not exist in this workspace: ${missing.join(", ")}`,
      );
    const ids = resolveLabelIds(
      (ticket.labels ?? []).map((l) => l.name),
      { add, remove },
      state.labels,
    );
    ticket.labels = ids.map((id) => state.labels.find((l) => l.id === id));
  }

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

    async listTickets({ team, project, states, includeFinished = false } = {}) {
      calls.push({
        op: "listTickets",
        team,
        project,
        states,
        includeFinished,
      });
      if (!team) throw new ControlPlaneError("listTickets requires team");
      const wanted = states?.length
        ? new Set(states.map((n) => n.toLowerCase()))
        : null;
      return state.tickets
        .filter((t) => {
          if ((t.team?.key ?? teamOf(t.identifier)) !== team) return false;
          if (project && t.project?.name !== project) return false;
          const name = (t.state?.name ?? "").toLowerCase();
          if (wanted) return wanted.has(name);
          return (
            includeFinished || !["done", "canceled", "duplicate"].includes(name)
          );
        })
        .map(asTicket)
        .sort(byQueueOrder);
    },

    async listDispatchable({ team, project } = {}) {
      calls.push({ op: "listDispatchable", team, project });
      if (!team) throw new ControlPlaneError("listDispatchable requires team");
      return (
        await this.listTickets({ team, project, states: ["Todo"] })
      ).filter(
        (t) =>
          !t.assignee &&
          (t.labels ?? []).some((l) => l.name === AGENT_READY_LABEL) &&
          (t.blockedBy ?? []).length === 0,
      );
    },

    async claim(identifier, { harness = "claude" } = {}) {
      calls.push({ op: "claim", identifier, harness });
      const ticket = requireTicket(identifier);
      const teamKey = ticket.team?.key ?? teamOf(identifier);
      const inProgress = requireState("In Progress", teamKey);
      const me = state.viewer;
      const { add, remove } = claimLabels(
        (ticket.labels ?? []).map((l) => l.name),
        harness,
      );
      applyLabels(ticket, add, remove);
      ticket.state = { ...inProgress };
      ticket.assignee = { ...me };
      if (state.loseNextClaim) {
        ticket.assignee = { ...state.loseNextClaim };
        state.loseNextClaim = null;
      }
      return {
        ok: ticket.assignee?.id === me.id,
        identifier,
        assignee: ticket.assignee?.name ?? null,
      };
    },

    async comment(identifier, body) {
      calls.push({ op: "comment", identifier, body });
      if (!body) throw new ControlPlaneError(`comment requires a body`);
      const ticket = requireTicket(identifier);
      (ticket.comments ??= []).push({
        id: `c-${nextId++}`,
        body: stampRun(body),
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
      if (!nextState && !add.length && !remove.length && !unassign)
        throw new ControlPlaneError(
          `transition requires a state name or a label change`,
        );
      const ticket = requireTicket(identifier);
      if (nextState) {
        const teamKey = ticket.team?.key ?? teamOf(identifier);
        ticket.state = { ...requireState(nextState, teamKey) };
      }
      if (add.length || remove.length) applyLabels(ticket, add, remove);
      if (unassign) ticket.assignee = null;
    },

    async setLabels(identifier, { add = [], remove = [] } = {}) {
      calls.push({ op: "setLabels", identifier, add, remove });
      const ticket = requireTicket(identifier);
      if (!add.length && !remove.length) return;
      applyLabels(ticket, add, remove);
    },

    async hasOpenPullRequest(identifier) {
      calls.push({ op: "hasOpenPullRequest", identifier });
      return Boolean(requireTicket(identifier).openPullRequest);
    },

    async file({
      team,
      title,
      body = "",
      labels = [],
      state: stateName = "Triage",
      projectId,
    } = {}) {
      calls.push({
        op: "file",
        team,
        title,
        body,
        labels,
        state: stateName,
        projectId,
      });
      if (!team || !title)
        throw new ControlPlaneError("file requires team and title");
      const bad = validateLabels(labels);
      if (bad.length)
        throw new ControlPlaneError("invalid label(s):\n  " + bad.join("\n  "));
      const missing = labels.filter(
        (n) => !state.labels.some((l) => l.name === n),
      );
      if (missing.length)
        throw new ControlPlaneError(
          `label(s) do not exist in this workspace: ${missing.join(", ")}`,
        );
      const target = requireState(stateName, team);
      if (state.team.key !== team)
        throw new ControlPlaneError(`no such team: ${team}`);
      const n =
        state.tickets.filter((t) => teamOf(t.identifier) === team).length + 1;
      const identifier = `${team}-${n}`;
      const id = `mem-${nextId++}`;
      const labelIds = resolveLabelIds([], { add: labels }, state.labels);
      const ticket = {
        id,
        identifier,
        title,
        description: stampRun(body),
        url: `memory://${identifier}`,
        state: { ...target },
        assignee: null,
        team: { key: team },
        project: projectId ? { name: projectId } : null,
        labels: labelIds.map((lid) => state.labels.find((l) => l.id === lid)),
        comments: [],
      };
      state.tickets.push(ticket);
      return { identifier, url: ticket.url };
    },

    async appendDetail(identifier, markdown) {
      calls.push({ op: "appendDetail", identifier, markdown });
      const ticket = requireTicket(identifier);
      const { description, appended } = appendIssueDetail(
        ticket.description,
        markdown,
      );
      if (!appended) return { appended: false };
      ticket.description = description;
      return { appended: true };
    },

    async raw(query, variables = {}) {
      calls.push({ op: "raw", query, variables });
      const hit = state.raw[query];
      if (hit === undefined)
        throw new ControlPlaneError(`raw query not seeded`);
      return typeof hit === "function" ? hit(variables) : clone(hit);
    },
  };
}
