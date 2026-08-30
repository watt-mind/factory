import { describe, expect, test } from "bun:test";
import { proposals } from "./proposals.mjs";

const rows = [
  {
    id: "proposal-run",
    runId: "run-1",
    eventId: "event-1",
    decision: "run",
    agent: "worker@1",
    ttl_seconds: 900,
    created_at: "2026-08-30T12:00:00.000Z",
    expired: false,
    reason: null,
  },
  {
    id: "proposal-human-needed",
    runId: "run-2",
    eventId: "event-2",
    decision: "human_needed",
    agent: "worker@1",
    ttl_seconds: 900,
    created_at: "2026-08-30T12:01:00.000Z",
    expired: false,
    reason: "policy requires a human",
  },
  {
    id: "proposal-expired",
    runId: "run-3",
    eventId: "event-3",
    decision: "run",
    agent: "worker@1",
    ttl_seconds: 900,
    created_at: "2026-08-30T12:02:00.000Z",
    expired: true,
    reason: "expired",
  },
];

async function captureOutput(run) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

function client(proposals = rows) {
  return { proposals: async () => ({ proposals }) };
}

describe("proposals command", () => {
  test("prints the stable JSON schema with derived approvability", async () => {
    const lines = await captureOutput(() => proposals(client(), ["--json"]));

    expect(lines).toHaveLength(1);
    const output = JSON.parse(lines[0]);
    expect(output).toHaveLength(3);
    expect(Object.keys(output[0])).toEqual([
      "id",
      "runId",
      "eventId",
      "decision",
      "agent",
      "ttlSeconds",
      "createdAt",
      "expired",
      "approvable",
      "reason",
    ]);
    expect(output).toEqual([
      {
        id: "proposal-run",
        runId: "run-1",
        eventId: "event-1",
        decision: "run",
        agent: "worker@1",
        ttlSeconds: 900,
        createdAt: "2026-08-30T12:00:00.000Z",
        expired: false,
        approvable: true,
        reason: null,
      },
      expect.objectContaining({
        id: "proposal-human-needed",
        decision: "human_needed",
        expired: false,
        approvable: false,
      }),
      expect.objectContaining({
        id: "proposal-expired",
        decision: "run",
        expired: true,
        approvable: false,
      }),
    ]);
  });

  test("filters approvable rows in JSON and text output", async () => {
    const jsonLines = await captureOutput(() =>
      proposals(client(), ["--approvable", "--json"]),
    );
    expect(JSON.parse(jsonLines[0]).map((row) => row.id)).toEqual([
      "proposal-run",
    ]);

    const textLines = await captureOutput(() =>
      proposals(client(), ["--approvable"]),
    );
    expect(textLines.join("\n")).toContain("proposal-run");
    expect(textLines.join("\n")).not.toContain("proposal-human-needed");
    expect(textLines.join("\n")).not.toContain("proposal-expired");
  });

  test("prints an empty JSON array for no open proposals", async () => {
    const lines = await captureOutput(() => proposals(client([]), ["--json"]));
    expect(lines).toEqual(["[]"]);
  });
});
