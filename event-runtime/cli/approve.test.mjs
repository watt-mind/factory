import { describe, expect, test } from "bun:test";
import { approveProposal } from "./approve.mjs";

function capture(run) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  return run()
    .then((value) => ({ value, lines }))
    .finally(() => {
      console.log = original;
    });
}

function apiError(status, body) {
  const err = new Error(body.error);
  err.status = status;
  err.body = body;
  return err;
}

describe("approve command", () => {
  test("reports the queued run on approval", async () => {
    const { lines } = await capture(() =>
      approveProposal(
        { approve: async () => ({ approved: true, runId: "run-1" }) },
        "p-1",
      ),
    );

    expect(lines).toEqual(["approved — run run-1 queued"]);
  });

  test("names the fresh proposal after a re-plan", async () => {
    const { lines } = await capture(() =>
      approveProposal(
        {
          approve: async () => ({
            approved: false,
            replanned: true,
            proposal: { id: "p-2" },
          }),
        },
        "p-1",
      ),
    );

    expect(lines[0]).toContain("re-planned");
    expect(lines[0]).toContain("p-2");
  });

  // A corrupt stored row is not a re-plan: the CLI must not tell the operator
  // to go approve a fresh proposal that does not exist.
  test("fails with a corruption message naming the proposal id", async () => {
    const client = {
      approve: async () => {
        throw apiError(409, {
          error: "proposal p-1: malformed_event_envelope",
          reason: "malformed_stored_row",
          kind: "malformed_event_envelope",
        });
      },
    };

    const err = await approveProposal(client, "p-1").then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("p-1");
    expect(err.message).toContain("corrupt");
    expect(err.message).toContain("malformed_event_envelope");
  });

  test("propagates unrelated API errors unchanged", async () => {
    const original = apiError(404, { error: "unknown proposal p-9" });
    const err = await approveProposal(
      {
        approve: async () => {
          throw original;
        },
      },
      "p-9",
    ).then(
      () => null,
      (e) => e,
    );

    expect(err).toBe(original);
  });
});
