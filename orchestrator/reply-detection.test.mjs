import { describe, expect, test } from "bun:test";
import { answeredIdentifiers, holdInfo, REPLY_GRACE_MS } from "./reply-detection.mjs";

const LABEL_ID = "label-ai-blocked";
const IDS = new Set([LABEL_ID]);
const T0 = Date.parse("2026-08-04T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

/** A held issue: label-add events and comments given as offsets from T0. */
function issue({ id = "CLNT-1", state = "Blocked", adds = [], comments = [], addedIds = [LABEL_ID] } = {}) {
  return {
    identifier: id,
    state: { name: state },
    comments: { nodes: comments.map((ms) => ({ createdAt: iso(T0 + ms) })) },
    history: { nodes: adds.map((ms) => ({ createdAt: iso(T0 + ms), addedLabelIds: addedIds })) },
  };
}

describe("answeredIdentifiers", () => {
  test("comment well after the label-add is answered", () => {
    const held = [issue({ adds: [0], comments: [-2000, 30 * 60_000] })];
    expect(answeredIdentifiers(held, IDS)).toEqual(new Set(["CLNT-1"]));
  });

  test("the blocking comment itself does not trigger — before or slightly after the label", () => {
    // comment-then-label (the usual order) and label-then-comment ~10s later
    // (observed on CLNT-887 et al.) both stay inside the grace window.
    const before = issue({ id: "A", adds: [0], comments: [-1500] });
    const after = issue({ id: "B", adds: [0], comments: [10_000] });
    expect(answeredIdentifiers([before, after], IDS)).toEqual(new Set());
  });

  test("grace boundary: answered strictly beyond REPLY_GRACE_MS", () => {
    const at = issue({ id: "AT", adds: [0], comments: [REPLY_GRACE_MS] });
    const past = issue({ id: "PAST", adds: [0], comments: [REPLY_GRACE_MS + 1] });
    expect(answeredIdentifiers([at, past], IDS)).toEqual(new Set(["PAST"]));
  });

  test("re-adding the label resets the clock", () => {
    // Held at 0, answered at +10m, triage re-held at +11m with a sharper
    // question: not answered again until a comment lands after the re-add.
    const held = [issue({ adds: [0, 11 * 60_000], comments: [-1000, 10 * 60_000, 11 * 60_000 - 5000] })];
    expect(answeredIdentifiers(held, IDS)).toEqual(new Set());
  });

  test("conservative on missing evidence: no label-add event or no comments", () => {
    const noEvent = issue({ id: "NOEV", adds: [], comments: [60 * 60_000] });
    const otherLabel = issue({ id: "OTHER", adds: [0], comments: [60 * 60_000], addedIds: ["some-other-label"] });
    const noComments = issue({ id: "NOC", adds: [0], comments: [] });
    expect(answeredIdentifiers([noEvent, otherLabel, noComments], IDS)).toEqual(new Set());
  });

  test("only Triage and Blocked states count", () => {
    const inProgress = issue({ id: "IP", state: "In Progress", adds: [0], comments: [60 * 60_000] });
    const backlog = issue({ id: "BL", state: "Backlog", adds: [0], comments: [60 * 60_000] });
    const triage = issue({ id: "TR", state: "Triage", adds: [0], comments: [60 * 60_000] });
    expect(answeredIdentifiers([inProgress, backlog, triage], IDS)).toEqual(new Set(["TR"]));
  });

  test("tolerates missing nested fields", () => {
    const bare = { identifier: "BARE", state: { name: "Blocked" } };
    expect(answeredIdentifiers([bare], IDS)).toEqual(new Set());
    expect(answeredIdentifiers(null, IDS)).toEqual(new Set());
  });
});

describe("holdInfo", () => {
  const withBodies = ({ comments, ...spec }) => ({
    ...issue(spec),
    comments: { nodes: comments.map(([ms, body]) => ({ createdAt: iso(T0 + ms), body })) },
  });

  test("splits the blocking question from the reply", () => {
    const node = withBodies({ adds: [0], comments: [[-1500, "need a decision on X"], [60 * 60_000, "go with option A"]] });
    const info = holdInfo(node, IDS);
    expect(info.heldAtMs).toBe(T0);
    expect(info.question.body).toBe("need a decision on X");
    expect(info.reply.body).toBe("go with option A");
  });

  test("a label-then-comment hold keeps its comment as the question, not a reply", () => {
    const node = withBodies({ adds: [0], comments: [[10_000, "blocked: which env?"]] });
    const info = holdInfo(node, IDS);
    expect(info.question.body).toBe("blocked: which env?");
    expect(info.reply).toBeNull();
  });

  test("no add event: newest comment is the question guess, heldAtMs null, no reply ever", () => {
    const node = withBodies({ adds: [], comments: [[0, "old"], [60 * 60_000, "newest"]] });
    const info = holdInfo(node, IDS);
    expect(info.heldAtMs).toBeNull();
    expect(info.question.body).toBe("newest");
    expect(info.reply).toBeNull();
  });

  test("non-hold states return null", () => {
    expect(holdInfo(issue({ state: "In Progress", adds: [0], comments: [0] }), IDS)).toBeNull();
    expect(holdInfo(undefined, IDS)).toBeNull();
  });

  test("agrees with answeredIdentifiers on the grace boundary", () => {
    const at = issue({ id: "AT", adds: [0], comments: [REPLY_GRACE_MS] });
    const past = issue({ id: "PAST", adds: [0], comments: [REPLY_GRACE_MS + 1] });
    expect(holdInfo(at, IDS).reply).toBeNull();
    expect(holdInfo(past, IDS).reply).not.toBeNull();
  });
});
