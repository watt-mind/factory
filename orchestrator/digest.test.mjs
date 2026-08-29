/**
 * Digest is plane-aware (WM-1062). The regression this file locks in: a
 * GitHub-backed repo whose board holds an open `ai:blocked` ticket used to
 * report `0 held`, because the digest ran a Linear-only raw GraphQL query
 * through whatever plane the workspace default happened to be. It now reads
 * each repo through its OWN plane — Linear via the label-history raw query,
 * GitHub via the neutral `listTickets`/`listComments` verbs.
 */
import { describe, test, expect } from "bun:test";
import { heldForRepo, heldFromLinear, heldFromAdapter } from "./digest.mjs";
import { AI_BLOCKED } from "./reply-detection.mjs";

const REPO = { name: "factory", team: "WM", project: "Factory" };

/**
 * A GitHub-shaped control-plane fake: it answers the two neutral verbs the
 * digest uses and REFUSES `raw`, standing in for the hard `gh` error a Linear
 * GraphQL query is on a GitHub adapter.
 */
function githubFake({ tickets = [], comments = {} } = {}) {
  const calls = [];
  return {
    kind: "github",
    async listTickets({ team, project, states } = {}) {
      calls.push({ op: "listTickets", team, project, states });
      const wanted = states?.length
        ? new Set(states.map((s) => s.toLowerCase()))
        : null;
      return tickets.filter(
        (t) => !wanted || wanted.has((t.state?.name ?? "").toLowerCase()),
      );
    },
    async listComments(identifier) {
      calls.push({ op: "listComments", identifier });
      return comments[identifier] ?? [];
    },
    raw() {
      throw new Error(
        "Linear GraphQL must not be issued through the GitHub adapter",
      );
    },
    calls,
  };
}

/** A Linear-shaped fake: `raw` returns the seeded issue nodes. */
function linearFake(nodes = []) {
  return {
    kind: "linear",
    async raw() {
      return { issues: { nodes } };
    },
  };
}

describe("digest: GitHub held-ticket accounting (WM-1062)", () => {
  test("an open Blocked ai:blocked GitHub ticket is counted as held (was false-zero)", async () => {
    const cp = githubFake({
      tickets: [
        {
          identifier: "watt-mind/factory#840",
          title: "Something needs a human decision",
          state: { name: "Blocked" },
          labels: [{ name: AI_BLOCKED }],
        },
      ],
      comments: {
        "watt-mind/factory#840": [
          {
            body: "Should we ship A or B? Need a call before proceeding.",
            createdAt: "2026-08-27T10:00:00Z",
          },
        ],
      },
    });

    const held = await heldForRepo(REPO, { kind: "github", load: () => cp });

    expect(held).toHaveLength(1);
    expect(held[0].identifier).toBe("watt-mind/factory#840");
    // GitHub label history is not in the neutral contract: hold age and reply
    // timing are unknown, so the row is shown with a limitation note and never
    // claimed as answered — but it IS counted and IS shown.
    expect(held[0].timingKnown).toBe(false);
    expect(held[0].heldAtMs).toBeNull();
    expect(held[0].reply).toBeNull();
    expect(held[0].question?.body).toMatch(/ship A or B/);
    // Never a Linear GraphQL query through the GitHub adapter.
    expect(cp.calls.some((c) => c.op === "listTickets")).toBe(true);
  });

  test("only Triage/Blocked ai:blocked tickets are held; other labels/states are ignored", async () => {
    const cp = githubFake({
      tickets: [
        {
          identifier: "watt-mind/factory#1",
          title: "held in triage",
          state: { name: "Triage" },
          labels: [{ name: AI_BLOCKED }],
        },
        {
          identifier: "watt-mind/factory#2",
          title: "blocked but not ai:blocked",
          state: { name: "Blocked" },
          labels: [{ name: "type:bug" }],
        },
      ],
      comments: {},
    });

    const held = await heldFromAdapter(REPO, cp);
    expect(held.map((h) => h.identifier)).toEqual(["watt-mind/factory#1"]);
    // No comment on the hold — surfaced, not dropped.
    expect(held[0].question).toBeNull();
    // listTickets asked only for the two hold states.
    expect(cp.calls[0]).toMatchObject({ states: ["Triage", "Blocked"] });
  });

  test("newest comment is used as the blocking question", async () => {
    const cp = githubFake({
      tickets: [
        {
          identifier: "watt-mind/factory#5",
          title: "t",
          state: { name: "Blocked" },
          labels: [{ name: AI_BLOCKED }],
        },
      ],
      comments: {
        "watt-mind/factory#5": [
          { body: "older note", createdAt: "2026-08-20T10:00:00Z" },
          {
            body: "newest blocking question",
            createdAt: "2026-08-25T10:00:00Z",
          },
        ],
      },
    });
    const held = await heldFromAdapter(REPO, cp);
    expect(held[0].question.body).toBe("newest blocking question");
  });
});

describe("digest: Linear behavior unchanged (WM-1062)", () => {
  const labelIds = new Set(["lbl-blocked"]);

  test("Linear hold is dated from label history and reply is detected", async () => {
    const heldAt = "2026-08-20T10:00:00Z";
    const node = {
      identifier: "WM-840",
      title: "linear hold",
      state: { name: "Blocked" },
      comments: {
        nodes: [
          { createdAt: "2026-08-20T10:00:30Z", body: "blocking question?" },
          { createdAt: "2026-08-22T09:00:00Z", body: "here is the answer" },
        ],
      },
      history: {
        nodes: [{ createdAt: heldAt, addedLabelIds: ["lbl-blocked"] }],
      },
    };
    const held = await heldFromLinear(REPO, linearFake([node]), labelIds);

    expect(held).toHaveLength(1);
    expect(held[0].timingKnown).toBe(true);
    expect(held[0].heldAtMs).toBe(Date.parse(heldAt));
    expect(held[0].question.body).toBe("blocking question?");
    expect(held[0].reply.body).toBe("here is the answer");
  });

  test("Linear ticket not in a hold state is excluded", async () => {
    const node = {
      identifier: "WM-1",
      title: "in progress, stale label",
      state: { name: "In Progress" },
      comments: { nodes: [] },
      history: { nodes: [] },
    };
    const held = await heldFromLinear(REPO, linearFake([node]), labelIds);
    expect(held).toHaveLength(0);
  });
});

describe("digest: mixed Linear/GitHub run (WM-1062)", () => {
  test("GitHub repo is read through the adapter, never through raw GraphQL", async () => {
    const cp = githubFake({
      tickets: [
        {
          identifier: "watt-mind/factory#840",
          title: "held",
          state: { name: "Blocked" },
          labels: [{ name: AI_BLOCKED }],
        },
      ],
      comments: {},
    });
    // If the digest fell back to a Linear raw query on the GitHub plane, this
    // would throw from githubFake.raw.
    const held = await heldForRepo(REPO, { kind: "github", load: () => cp });
    expect(held).toHaveLength(1);
  });
});
