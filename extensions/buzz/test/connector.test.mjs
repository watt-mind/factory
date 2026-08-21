import { describe, expect, test } from "bun:test";
import {
  KIND_CHAT,
  KIND_GIFT_WRAP,
  KIND_REACTION,
  pubkeyFromSecret,
  signEvent,
} from "../lib/nostr.mjs";
import {
  QUEUE_LIMIT,
  REJECT_REASON_PROMPT,
  createBuzzRuntime,
  resolveIdentity,
} from "../lib/runtime.mjs";

const AGENT_SECRET = "0".repeat(63) + "2";
const OWNER_SECRET = "0".repeat(63) + "1";
const OWNER_PUB = pubkeyFromSecret(OWNER_SECRET);
const CHANNEL = "91572011-2505-5288-b6f5-4a7d74abf106";
const AUTH_TAG = JSON.stringify([
  "auth",
  OWNER_PUB,
  "kind=1&created_at<1713957000",
  "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369",
]);

const proposal = {
  schemaVersion: "factory.decision-request/v1",
  question: "Approve?",
  options: [
    { id: "approve", label: "Approve", effect: "approve_proposal" },
    { id: "reject", label: "Reject", effect: "reject_proposal" },
    { id: "dismiss", label: "Not now", effect: "dismiss" },
  ],
  fields: [
    { id: "reason", kind: "text", required: true, whenOption: ["reject"] },
  ],
};

function inboxItem(overrides = {}) {
  return {
    id: "inbox_1",
    kind: "ESCALATED",
    title: "Decide proposal prop_1",
    refs: { issue: "WM-1", repo: "factory" },
    decision: proposal,
    ...overrides,
  };
}

function fakeClient({ items = [], onDecide, onInject, onMark } = {}) {
  const store = new Map(items.map((item) => [item.id, item]));
  return {
    inject: async (envelope) => {
      onInject?.(envelope);
      return { admitted: true, duplicate: false, event: envelope };
    },
    inbox: {
      list: () =>
        [...store.values()].filter((i) => !i.resolvedAt && !i.decidedAt),
      get: (id) => store.get(id) ?? null,
      decide: (id, response, { actor } = {}) => {
        onDecide?.({ id, response, actor });
        const item = store.get(id);
        const next = {
          ...item,
          decidedAt: "2026-08-20T00:00:00.000Z",
          decidedBy: actor,
          response,
        };
        store.set(id, next);
        return { item: next };
      },
      subscribe: () => () => {},
      markDelivered: (id, delivery) => {
        onMark?.({ id, delivery });
        const item = store.get(id);
        if (item)
          store.set(id, {
            ...item,
            delivery: { ...item.delivery, ...delivery },
          });
      },
    },
  };
}

function header(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) ?? "";
  const key = Object.keys(headers).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  return key ? String(headers[key]) : "";
}

function jsonResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
  };
}

/** In-process fake — no Bun.serve. Happy-DOM's Response is not a valid serve return. */
function startRelay({ failEvents = 0, extraEvents = [] } = {}) {
  const posted = [];
  const queries = [];
  let remainingFails = failEvents;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const auth = header(init.headers, "authorization");
    const ua = header(init.headers, "user-agent");
    if (!auth.startsWith("Nostr ")) return jsonResponse(401, "unauthorized");
    if (!ua.includes("wattmind-factory-buzz"))
      return jsonResponse(403, "forbidden ua");
    const body = init.body ?? "";
    if (parsed.pathname === "/events") {
      if (remainingFails > 0) {
        remainingFails -= 1;
        return jsonResponse(503, "down");
      }
      const event = JSON.parse(body);
      posted.push(event);
      return jsonResponse(200, { ok: true, id: event.id });
    }
    if (parsed.pathname === "/query") {
      queries.push(JSON.parse(body));
      return jsonResponse(200, extraEvents);
    }
    return jsonResponse(404, "nope");
  };
  return {
    url: "http://relay.test",
    posted,
    queries,
    fetchImpl,
  };
}

const secrets = { agentNsec: AGENT_SECRET, authTag: AUTH_TAG };

describe("egress", () => {
  test("lifecycle events post to feedChannel, never the pager channel", async () => {
    const relay = startRelay();
    const feedChannel = "8469ab53-6292-4436-938f-edf77ad2a652";
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL, feedChannel },
      secrets,
      client: {
        ...fakeClient(),
        runs: {
          // getRun (event-runtime/lib/connectors.mjs) hands the connector
          // only the artifact — run.result IS the artifact, not the whole
          // result_json (WM-975).
          get: () => ({
            runId: "run_1",
            spec: { agent: "factory-ticket" },
            result: {
              outcome: "PR_OPEN",
              ticket: "WM-975",
              prUrl: "https://github.com/watt-mind/factory/pull/975",
            },
          }),
        },
      },
      fetchImpl: relay.fetchImpl,
    });

    await runtime.onRunEvent({
      runId: "run_1",
      from: "VERIFYING",
      to: "COMPLETED",
      at: "2026-08-21T00:00:00.000Z",
    });

    expect(relay.posted).toHaveLength(1);
    expect(relay.posted[0].tags).toContainEqual(["h", feedChannel]);
    expect(relay.posted[0].tags).not.toContainEqual(["h", CHANNEL]);
    expect(relay.posted[0].content).toContain("PR opened");
    expect(relay.posted[0].content).toContain("WM-975");
  });

  test("lifecycle events are omitted when feedChannel is unset", async () => {
    const relay = startRelay();
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client: fakeClient(),
      fetchImpl: relay.fetchImpl,
    });

    await runtime.onRunEvent({ runId: "run_1", to: "RUNNING" });

    expect(relay.posted).toHaveLength(0);
  });

  test("failed lifecycle egress is queued without rejecting the event", async () => {
    const relay = startRelay({ failEvents: 1 });
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, feedChannel: "feed-channel" },
      secrets,
      client: fakeClient(),
      fetchImpl: relay.fetchImpl,
    });

    await expect(
      runtime.onRunEvent({ runId: "run_1", to: "RUNNING" }),
    ).resolves.toBeUndefined();
    expect(runtime.queue).toHaveLength(1);
  });

  test("onRunEvent skips the runs.get round-trip for a non-milestone hop", async () => {
    const relay = startRelay();
    let getCalls = 0;
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, feedChannel: "feed-channel" },
      secrets,
      client: {
        ...fakeClient(),
        runs: {
          get: () => {
            getCalls += 1;
            return null;
          },
        },
      },
      fetchImpl: relay.fetchImpl,
    });

    // QUEUED is a journal hop with no RUN_LIFECYCLE_VERBS entry — checking
    // the verb table before calling runs.get avoids fetching a run whose
    // message we are about to discard anyway.
    await runtime.onRunEvent({ runId: "run_1", to: "QUEUED" });
    expect(getCalls).toBe(0);
    expect(relay.posted).toHaveLength(0);

    await runtime.onRunEvent({ runId: "run_1", to: "RUNNING" });
    expect(getCalls).toBe(1);
  });

  test("lifecycle message coerces non-string ticket/agent and truncates long values", async () => {
    const relay = startRelay();
    const longTicket = "T".repeat(400);
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, feedChannel: "feed-channel" },
      secrets,
      client: {
        ...fakeClient(),
        runs: {
          get: () => ({
            runId: "run_1",
            spec: { agent: { name: "factory-ticket" } },
            result: { ticket: longTicket },
          }),
        },
      },
      fetchImpl: relay.fetchImpl,
    });

    await runtime.onRunEvent({ runId: "run_1", to: "RUNNING" });

    expect(relay.posted).toHaveLength(1);
    const content = relay.posted[0].content;
    expect(content).toContain("ticket: " + "T".repeat(300));
    expect(content).not.toContain("T".repeat(301));
    expect(content).toContain("agent: [object Object]");
  });

  test("poll() tails run lifecycle transitions on the connector's own cadence (WM-975)", async () => {
    const relay = startRelay();
    let cursor = 5;
    let delivered = false;
    const tailCalls = [];
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, feedChannel: "feed-channel" },
      secrets,
      client: {
        ...fakeClient(),
        runs: {
          cursor: () => cursor,
          tail: (since) => {
            tailCalls.push(since);
            if (!delivered) {
              delivered = true;
              cursor = 6;
              return {
                events: [{ runId: "run_tailed", to: "RUNNING" }],
                cursor,
              };
            }
            return { events: [], cursor: since };
          },
          get: () => null,
        },
      },
      fetchImpl: relay.fetchImpl,
    });

    // First tick only establishes the starting cursor (skips history), per
    // OPS-233: a restart must not replay the whole journal into the feed.
    await runtime.poll();
    expect(relay.posted).toHaveLength(0);

    await runtime.poll();
    expect(tailCalls).toEqual([5]);
    expect(relay.posted).toHaveLength(1);
    expect(relay.posted[0].content).toContain("run_tailed");

    await runtime.poll();
    expect(relay.posted).toHaveLength(1);
  });

  test("new inbox item becomes one kind-9 with h=channel and delivery recorded", async () => {
    const relay = startRelay();
    const marked = [];
    const client = fakeClient({
      items: [inboxItem()],
      onMark: (row) => marked.push(row),
    });
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL, pollSeconds: 15 },
      secrets,
      client,
      fetchImpl: relay.fetchImpl,
      webUrl: "http://127.0.0.1:7382",
    });
    await runtime.onInboxEvent({ type: "new-item", item: inboxItem() });
    expect(relay.posted).toHaveLength(1);
    const event = relay.posted[0];
    expect(event.kind).toBe(KIND_CHAT);
    expect(event.tags).toEqual(
      expect.arrayContaining([
        ["h", CHANNEL],
        expect.arrayContaining(["auth", OWNER_PUB]),
      ]),
    );
    expect(event.content).toContain("ESCALATED  factory  WM-1");
    expect(event.content).toContain("👍 approve · 👎 reject · 💤 not now");
    expect(event.content).toContain("http://127.0.0.1:7382/#/inbox/inbox_1");
    expect(event.content).not.toContain("\n#/inbox/");
    expect(marked[0].delivery.buzz.eventId).toBe(event.id);
    expect(runtime.posted.get("inbox_1").eventId).toBe(event.id);
  });

  test("BLOCKED items are also gift-wrapped to dmBlockedTo", async () => {
    const relay = startRelay();
    const item = inboxItem({ kind: "BLOCKED", title: "BLOCKED WM-1: q" });
    const runtime = createBuzzRuntime({
      config: {
        relayUrl: relay.url,
        channel: CHANNEL,
        dmBlockedTo: OWNER_PUB,
      },
      secrets,
      client: fakeClient({ items: [item] }),
      fetchImpl: relay.fetchImpl,
    });
    await runtime.onInboxEvent({ type: "new-item", item });
    expect(relay.posted.map((e) => e.kind).sort()).toEqual(
      [KIND_CHAT, KIND_GIFT_WRAP].sort(),
    );
    const wrap = relay.posted.find((e) => e.kind === KIND_GIFT_WRAP);
    expect(wrap.tags).toEqual([["p", OWNER_PUB]]);
  });

  test("resolved item gets a thread reply", async () => {
    const relay = startRelay();
    const item = inboxItem();
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client: fakeClient({ items: [item] }),
      fetchImpl: relay.fetchImpl,
    });
    await runtime.onInboxEvent({ type: "new-item", item });
    await runtime.onInboxEvent({
      type: "changed",
      item: {
        ...item,
        decidedAt: "2026-08-20T00:00:00.000Z",
        decidedBy: "operator",
        response: { optionId: "approve" },
      },
    });
    expect(relay.posted).toHaveLength(2);
    expect(relay.posted[1].content).toContain("✅ approve by operator");
    expect(relay.posted[1].tags).toEqual(
      expect.arrayContaining([["e", relay.posted[0].id, "", "reply"]]),
    );
  });

  test("does not post dismiss-only or ticket-less ESCALATED items", async () => {
    const relay = startRelay();
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client: fakeClient({ items: [] }),
      fetchImpl: relay.fetchImpl,
    });
    await runtime.onInboxEvent({
      type: "new-item",
      item: inboxItem({
        id: "inbox_dismiss",
        decision: {
          question: "How should the factory handle this refused run?",
          options: [{ id: "dismiss", label: "Not now", effect: "dismiss" }],
        },
      }),
    });
    await runtime.onInboxEvent({
      type: "new-item",
      item: inboxItem({
        id: "inbox_run",
        title: "ESCALATED run_abc: needs_human",
        refs: { runId: "run_abc" },
      }),
    });
    expect(relay.posted).toHaveLength(0);
  });
});

describe("ingress", () => {
  test("👍 from an approver calls inbox.decide approve, idempotent on event id", async () => {
    const decisions = [];
    const item = inboxItem();
    const client = fakeClient({
      items: [item],
      onDecide: (row) => decisions.push(row),
    });
    const postedId = "a".repeat(64);
    const reaction = signEvent(
      { kind: KIND_REACTION, tags: [["e", postedId]], content: "👍" },
      OWNER_SECRET,
      { createdAt: 1_700_000_000 },
    );
    const relay = startRelay({ extraEvents: [reaction] });
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client,
      fetchImpl: relay.fetchImpl,
    });
    runtime.posted.set("inbox_1", {
      eventId: postedId,
      postedAt: "2026-08-20T00:00:00.000Z",
      optionMap: { "👍": "approve", "👎": "reject", "💤": "dismiss" },
      kind: "decision_needed",
    });
    await runtime.poll();
    await runtime.poll();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].response.optionId).toBe("approve");
    expect(decisions[0].actor).toStartWith("buzz:npub1");
  });

  test("👎 without a reason prompts instead of deciding", async () => {
    const decisions = [];
    const item = inboxItem();
    const client = fakeClient({
      items: [item],
      onDecide: (row) => decisions.push(row),
    });
    const postedId = "b".repeat(64);
    const reaction = signEvent(
      { kind: KIND_REACTION, tags: [["e", postedId]], content: "👎" },
      OWNER_SECRET,
      { createdAt: 1_700_000_001 },
    );
    const relay = startRelay({ extraEvents: [reaction] });
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client,
      fetchImpl: relay.fetchImpl,
    });
    runtime.posted.set("inbox_1", {
      eventId: postedId,
      postedAt: "2026-08-20T00:00:00.000Z",
      optionMap: { "👍": "approve", "👎": "reject", "💤": "dismiss" },
      kind: "decision_needed",
    });
    await runtime.poll();
    expect(decisions).toHaveLength(0);
    expect(relay.posted.some((e) => e.content === REJECT_REASON_PROMPT)).toBe(
      true,
    );
  });

  test("@factory dispatch injects factory.dispatch.requested; @factory status replies", async () => {
    const injected = [];
    const client = fakeClient({ onInject: (e) => injected.push(e) });
    const dispatch = signEvent(
      {
        kind: KIND_CHAT,
        tags: [["h", CHANNEL]],
        content: "@factory dispatch WM-123 repo=factory",
      },
      OWNER_SECRET,
      { createdAt: 1_700_000_002 },
    );
    const status = signEvent(
      {
        kind: KIND_CHAT,
        tags: [["h", CHANNEL]],
        content: "@factory status",
      },
      OWNER_SECRET,
      { createdAt: 1_700_000_003 },
    );
    const ignored = signEvent(
      {
        kind: KIND_CHAT,
        tags: [["h", CHANNEL]],
        content: "please merge everything",
      },
      OWNER_SECRET,
      { createdAt: 1_700_000_004 },
    );
    const relay = startRelay({ extraEvents: [dispatch, status, ignored] });
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client,
      fetchImpl: relay.fetchImpl,
    });
    await runtime.poll();
    expect(injected).toHaveLength(1);
    expect(injected[0].type).toBe("factory.dispatch.requested");
    expect(injected[0].payload).toEqual({ repo: "factory", ticket: "WM-123" });
    expect(injected[0].eventId).toBe(`buzz:${dispatch.id}`);
    expect(relay.posted.some((e) => e.content.includes("queued WM-123"))).toBe(
      true,
    );
    expect(relay.posted.some((e) => e.content.includes("inbox open:"))).toBe(
      true,
    );
  });

  test("a tampered signature on an otherwise-valid reaction is dropped before decide", async () => {
    const decisions = [];
    const item = inboxItem();
    const client = fakeClient({
      items: [item],
      onDecide: (row) => decisions.push(row),
    });
    const postedId = "c".repeat(64);
    const reaction = signEvent(
      { kind: KIND_REACTION, tags: [["e", postedId]], content: "👍" },
      OWNER_SECRET,
      { createdAt: 1_700_000_010 },
    );
    const tampered = { ...reaction, sig: "0".repeat(128) };
    const relay = startRelay({ extraEvents: [tampered] });
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client,
      fetchImpl: relay.fetchImpl,
    });
    runtime.posted.set("inbox_1", {
      eventId: postedId,
      postedAt: "2026-08-20T00:00:00.000Z",
      optionMap: { "👍": "approve", "👎": "reject", "💤": "dismiss" },
      kind: "decision_needed",
    });
    await runtime.poll();
    expect(decisions).toHaveLength(0);
  });

  test("a tampered id on an otherwise-valid reaction is dropped before decide", async () => {
    const decisions = [];
    const item = inboxItem();
    const client = fakeClient({
      items: [item],
      onDecide: (row) => decisions.push(row),
    });
    const postedId = "d".repeat(64);
    const reaction = signEvent(
      { kind: KIND_REACTION, tags: [["e", postedId]], content: "👍" },
      OWNER_SECRET,
      { createdAt: 1_700_000_011 },
    );
    const tampered = { ...reaction, id: "1".repeat(64) };
    const relay = startRelay({ extraEvents: [tampered] });
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client,
      fetchImpl: relay.fetchImpl,
    });
    runtime.posted.set("inbox_1", {
      eventId: postedId,
      postedAt: "2026-08-20T00:00:00.000Z",
      optionMap: { "👍": "approve", "👎": "reject", "💤": "dismiss" },
      kind: "decision_needed",
    });
    await runtime.poll();
    expect(decisions).toHaveLength(0);
  });

  test("answer-option reject on a numbered decision records the chosen option, not a hardcoded reject", async () => {
    const decisions = [];
    const numberedDecision = {
      schemaVersion: "factory.decision-request/v1",
      question: "Pick one",
      options: [
        { id: "a", label: "One" },
        { id: "b", label: "Two" },
        { id: "needs-note", label: "Needs a note" },
        { id: "d", label: "Four" },
      ],
      fields: [
        {
          id: "note",
          kind: "text",
          required: true,
          whenOption: ["needs-note"],
        },
      ],
    };
    const item = inboxItem({
      id: "inbox_numbered",
      decision: numberedDecision,
    });
    const client = fakeClient({
      items: [item],
      onDecide: (row) => decisions.push(row),
    });
    const postedId = "e".repeat(64);
    const optionMap = { 1: "a", 2: "b", 3: "needs-note", 4: "d" };
    const reaction = signEvent(
      { kind: KIND_REACTION, tags: [["e", postedId]], content: "3" },
      OWNER_SECRET,
      { createdAt: 1_700_000_012 },
    );
    const relay = startRelay({ extraEvents: [reaction] });
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client,
      fetchImpl: relay.fetchImpl,
    });
    runtime.posted.set("inbox_numbered", {
      eventId: postedId,
      postedAt: "2026-08-20T00:00:00.000Z",
      optionMap,
      kind: "decision_needed",
    });
    await runtime.poll();
    expect(decisions).toHaveLength(0);
    expect(runtime.pendingReject.get(postedId)).toEqual({
      itemId: "inbox_numbered",
      optionId: "needs-note",
    });
    expect(
      relay.posted.some((e) =>
        e.content.includes("reply with a reason to needs a note"),
      ),
    ).toBe(true);

    const rootId = relay.posted[0].id;
    const followUp = signEvent(
      {
        kind: KIND_CHAT,
        tags: [["e", rootId, "", "root"]],
        content: "here is the note",
      },
      OWNER_SECRET,
      { createdAt: 1_700_000_013 },
    );
    const relay2 = startRelay({ extraEvents: [followUp] });
    const runtime2 = createBuzzRuntime({
      config: { relayUrl: relay2.url, channel: CHANNEL },
      secrets,
      client,
      fetchImpl: relay2.fetchImpl,
    });
    runtime2.posted.set("inbox_numbered", {
      eventId: postedId,
      postedAt: "2026-08-20T00:00:00.000Z",
      optionMap,
      kind: "decision_needed",
    });
    runtime2.pendingReject.set(rootId, {
      itemId: "inbox_numbered",
      optionId: "needs-note",
    });
    await runtime2.poll();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].response.optionId).toBe("needs-note");
    expect(decisions[0].response.fields).toEqual({ note: "here is the note" });
  });

  test("a decide failure on reaction is surfaced as an in-thread reply", async () => {
    const item = inboxItem();
    const client = fakeClient({
      items: [item],
      onDecide: () => {
        throw new Error("inbox locked");
      },
    });
    const postedId = "f".repeat(64);
    const reaction = signEvent(
      { kind: KIND_REACTION, tags: [["e", postedId]], content: "👍" },
      OWNER_SECRET,
      { createdAt: 1_700_000_014 },
    );
    const relay = startRelay({ extraEvents: [reaction] });
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client,
      fetchImpl: relay.fetchImpl,
    });
    runtime.posted.set("inbox_1", {
      eventId: postedId,
      postedAt: "2026-08-20T00:00:00.000Z",
      optionMap: { "👍": "approve", "👎": "reject", "💤": "dismiss" },
      kind: "decision_needed",
    });
    await runtime.poll();
    expect(
      relay.posted.some(
        (e) =>
          e.content.includes("decide failed") &&
          e.content.includes("inbox locked"),
      ),
    ).toBe(true);
  });

  test("a thread reply selects the recommended option and uses the reply as the field", async () => {
    const decisions = [];
    const item = inboxItem({
      id: "inbox_answer",
      decision: {
        schemaVersion: "factory.decision-request/v1",
        question: "How should the factory proceed with WM-1?",
        recommended: "answer",
        options: [
          {
            id: "triage",
            label: "Send back to Triage",
            effect: "send_to_triage",
          },
          { id: "answer", label: "Answer the agent", effect: "answer" },
          { id: "dismiss", label: "Not now", effect: "dismiss" },
        ],
        fields: [
          {
            id: "answer",
            kind: "text",
            required: true,
            whenOption: ["answer"],
          },
        ],
      },
    });
    const client = fakeClient({
      items: [item],
      onDecide: (row) => decisions.push(row),
    });
    const postedId = "c".repeat(64);
    const reply = signEvent(
      {
        kind: KIND_CHAT,
        tags: [["e", postedId, "", "root"]],
        content: "use the staging Stripe key",
      },
      OWNER_SECRET,
      { createdAt: 1_700_000_020 },
    );
    const relay = startRelay({ extraEvents: [reply] });
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client,
      fetchImpl: relay.fetchImpl,
    });
    runtime.posted.set("inbox_answer", {
      eventId: postedId,
      postedAt: "2026-08-20T00:00:00.000Z",
      optionMap: { "📤": "triage", "💬": "answer", "💤": "dismiss" },
      kind: "ESCALATED",
    });
    await runtime.poll();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].response.optionId).toBe("answer");
    expect(decisions[0].response.fields).toEqual({
      answer: "use the staging Stripe key",
    });
  });
});

describe("outage queue", () => {
  test("failed egress is queued and retried on the next poll", async () => {
    const relay = startRelay({ failEvents: 1 });
    const item = inboxItem();
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client: fakeClient({ items: [item] }),
      fetchImpl: relay.fetchImpl,
    });
    await runtime.onInboxEvent({ type: "new-item", item });
    expect(relay.posted).toHaveLength(0);
    expect(runtime.queue.length).toBe(1);
    expect(runtime.health().ok).toBe(false);
    await runtime.poll();
    expect(relay.posted).toHaveLength(1);
    expect(runtime.queue.length).toBe(0);
    expect(runtime.health().ok).toBe(true);
  });

  test("overflowing the outage queue logs and is counted in health().detail", async () => {
    const extraDrops = 2;
    const items = Array.from({ length: QUEUE_LIMIT + extraDrops }, (_, i) =>
      inboxItem({ id: `inbox_${i}` }),
    );
    const relay = startRelay({ failEvents: items.length });
    const logs = [];
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL },
      secrets,
      client: fakeClient({ items }),
      fetchImpl: relay.fetchImpl,
      log: (msg) => logs.push(msg),
    });
    for (const item of items) {
      await runtime.onInboxEvent({ type: "new-item", item });
    }
    expect(runtime.queue.length).toBe(QUEUE_LIMIT);
    expect(logs.some((m) => m.includes("outage queue overflow"))).toBe(true);
    // Relay recovers: flushing the queue on the next poll should succeed,
    // and the dropped-post count survives into the healthy detail string.
    await runtime.poll();
    expect(runtime.queue.length).toBe(0);
    expect(runtime.health().ok).toBe(true);
    expect(runtime.health().detail).toContain(`dropped ${extraDrops}`);
  });
});

describe("health without secrets", () => {
  test("missing nsec is ok:false and does not throw from start path", async () => {
    const runtime = createBuzzRuntime({
      config: { relayUrl: "http://127.0.0.1:9", channel: CHANNEL },
      secrets: {},
      client: fakeClient(),
    });
    expect(runtime.health()).toMatchObject({
      ok: false,
      detail: "FACTORY_EXT_BUZZ_AGENT_NSEC is unset",
    });
    await runtime.poll();
  });
});

describe("identity verification", () => {
  test("resolveIdentity flags a tampered auth-tag signature", () => {
    const tampered = JSON.stringify([
      "auth",
      OWNER_PUB,
      "kind=1&created_at<1713957000",
      "0".repeat(128),
    ]);
    const identity = resolveIdentity({
      secrets: { agentNsec: AGENT_SECRET, authTag: tampered },
      config: {},
    });
    expect(identity.authValid).toBe(false);
  });

  test("health() is ok:false with a reason when the auth tag fails verification", async () => {
    const tampered = JSON.stringify([
      "auth",
      OWNER_PUB,
      "kind=1&created_at<1713957000",
      "0".repeat(128),
    ]);
    const relay = startRelay();
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL, approvers: [OWNER_PUB] },
      secrets: { agentNsec: AGENT_SECRET, authTag: tampered },
      client: fakeClient(),
      fetchImpl: relay.fetchImpl,
    });
    expect(runtime.health()).toMatchObject({ ok: false });
    expect(runtime.health().detail).toContain("verification");
  });

  test("health() is ok:false with a reason when there are no approvers", async () => {
    const relay = startRelay();
    const runtime = createBuzzRuntime({
      config: { relayUrl: relay.url, channel: CHANNEL, approvers: [] },
      secrets: { agentNsec: AGENT_SECRET },
      client: fakeClient(),
      fetchImpl: relay.fetchImpl,
    });
    expect(runtime.health()).toMatchObject({
      ok: false,
      detail: "no approvers configured",
    });
  });
});
