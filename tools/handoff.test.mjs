import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
  HANDOFF_MAX_BYTES,
  acceptHandoff,
  assertForcedCommandEnvironment,
  createHandoffRequest,
  fail,
  handoffErrorBody,
  resolveHandoffRepo,
  sendHandoff,
  validateHandoffRequest,
} from "./handoff.mjs";

const REQUEST = {
  schemaVersion: "factory.handoff/v1",
  requestId: "handoff-1153-test",
  repo: "factory",
  ticket: "watt-mind/factory#1153",
};

const repos = new Map([
  [
    "factory",
    {
      name: "factory",
      path: "/work/factory",
      worktreeRoot: "/work/worktrees/factory",
      github: "watt-mind/factory",
      controlPlane: "github",
      reportOnly: false,
    },
  ],
  [
    "reports",
    {
      name: "reports",
      path: "/work/reports",
      worktreeRoot: null,
      github: "watt-mind/reports",
      controlPlane: "github",
      reportOnly: true,
    },
  ],
]);

describe("strict handoff request", () => {
  test("contains only the four protocol fields", () => {
    expect(
      createHandoffRequest({
        requestId: REQUEST.requestId,
        repo: REQUEST.repo,
        ticket: REQUEST.ticket,
      }),
    ).toEqual(REQUEST);
  });

  test("rejects unknown/missing fields, invalid identifiers, and oversized input", () => {
    const cases = [
      { ...REQUEST, source: "operator" },
      { ...REQUEST, schemaVersion: "factory.event/v1" },
      { ...REQUEST, requestId: "spaces are invalid" },
      { ...REQUEST, repo: "../factory" },
      { ...REQUEST, ticket: "not-an-issue" },
    ];
    for (const value of cases) {
      expect(validateHandoffRequest(JSON.stringify(value)).ok).toBe(false);
    }
    expect(validateHandoffRequest("{").ok).toBe(false);
    expect(validateHandoffRequest("x".repeat(HANDOFF_MAX_BYTES + 1)).ok).toBe(
      false,
    );
  });

  test("derives the configured repo from cwd and validates explicit names", () => {
    expect(resolveHandoffRepo({ repos, cwd: "/work/factory/src" })).toBe(
      "factory",
    );
    expect(
      resolveHandoffRepo({ repos, cwd: "/work/worktrees/factory/GH-1153" }),
    ).toBe("factory");
    expect(resolveHandoffRepo({ repos, cwd: "/tmp", repo: "factory" })).toBe(
      "factory",
    );
    expect(() =>
      resolveHandoffRepo({ repos, cwd: "/tmp", repo: "missing" }),
    ).toThrow(/unconfigured repo/);
  });
});

describe("forced-command accept server", () => {
  test("derives handoff provenance and signs the exact POST /events bytes", async () => {
    const calls = [];
    const secret = "existing-runtime-secret";
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url, options });
      let response;
      if (options.method === "POST") {
        response = {
          admitted: true,
          duplicate: false,
          eventId: REQUEST.requestId,
        };
      } else if (url.endsWith("/proposals/prop-1")) {
        response = { proposal: { status: "approved" } };
      } else if (url.endsWith("/runs/run-1")) {
        response = { run: { state: "QUEUED" } };
      } else {
        response = {
          events: [
            {
              source: "handoff",
              eventId: REQUEST.requestId,
              status: "planned",
              proposalId: "prop-1",
              runId: "run-1",
            },
          ],
        };
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const receipt = await acceptHandoff(JSON.stringify(REQUEST), {
      repos,
      secret,
      now,
      fetchImpl,
      eventUrl: "http://127.0.0.1:7381",
      dashboardUrl: "https://factory.example.test",
      controlApiToken: "control-token",
    });

    const posted = calls[0];
    expect(posted.url).toBe("http://127.0.0.1:7381/events");
    const envelope = JSON.parse(posted.options.body);
    expect(envelope).toEqual({
      schemaVersion: "factory.event/v1",
      eventId: REQUEST.requestId,
      type: "factory.dispatch.requested",
      source: "handoff",
      subject: REQUEST.ticket,
      occurredAt: "2026-08-24T12:00:00.000Z",
      correlationId: REQUEST.requestId,
      causationId: null,
      payload: { repo: "factory", ticket: "watt-mind/factory#1153" },
    });
    const timestamp = posted.options.headers["x-factory-timestamp"];
    const expected = `sha256=${createHmac("sha256", secret)
      .update(`${timestamp}.${posted.options.body}`)
      .digest("hex")}`;
    expect(posted.options.headers["x-factory-signature"]).toBe(expected);
    for (const call of calls.slice(1)) {
      expect(call.options.headers.authorization).toBe("Bearer control-token");
    }
    expect(receipt).toEqual({
      schemaVersion: "factory.handoff-receipt/v1",
      requestId: REQUEST.requestId,
      admitted: true,
      duplicate: false,
      event: { id: REQUEST.requestId, state: "planned" },
      proposal: { id: "prop-1", state: "approved" },
      run: { id: "run-1", state: "QUEUED" },
      dashboardUrl: "https://factory.example.test",
    });
  });

  test("rejects unconfigured, report-only, and mismatched ticket repos before HTTP", async () => {
    let called = false;
    const options = {
      repos,
      secret: "secret",
      fetchImpl: async () => {
        called = true;
        throw new Error("must not fetch");
      },
    };
    for (const request of [
      { ...REQUEST, repo: "missing" },
      {
        ...REQUEST,
        repo: "reports",
        ticket: "watt-mind/reports#1",
      },
      { ...REQUEST, ticket: "other/repo#1153" },
    ]) {
      await expect(
        acceptHandoff(JSON.stringify(request), options),
      ).rejects.toThrow();
    }
    expect(called).toBe(false);
  });

  test("paginates event history so retries receive the original run receipt", async () => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push(url);
      if (options.method === "POST") {
        return Response.json({
          admitted: false,
          duplicate: true,
          eventId: REQUEST.requestId,
        });
      }
      if (url.endsWith("/events?limit=100")) {
        return Response.json({ events: [], nextBefore: "older-page" });
      }
      if (url.endsWith("/events?limit=100&before=older-page")) {
        return Response.json({
          events: [
            {
              source: "handoff",
              eventId: REQUEST.requestId,
              status: "planned",
              proposalId: "prop-old",
              runId: "run-old",
              envelope: {
                schemaVersion: "factory.event/v1",
                eventId: REQUEST.requestId,
                type: "factory.dispatch.requested",
                source: "handoff",
                subject: REQUEST.ticket,
                correlationId: REQUEST.requestId,
                causationId: null,
                payload: {
                  repo: REQUEST.repo,
                  ticket: REQUEST.ticket,
                  memoPin: {
                    foldedAt: "2026-08-24T12:00:01.000Z",
                    entries: [{ sha256: "planner-owned" }],
                  },
                },
              },
            },
          ],
          nextBefore: null,
        });
      }
      if (url.endsWith("/proposals/prop-old"))
        return Response.json({ proposal: { status: "approved" } });
      if (url.endsWith("/runs/run-old"))
        return Response.json({ run: { state: "QUEUED" } });
      throw new Error(`unexpected URL ${url}`);
    };

    const receipt = await acceptHandoff(JSON.stringify(REQUEST), {
      repos,
      secret: "secret",
      fetchImpl,
      now: Date.parse("2026-08-24T12:00:00.000Z"),
    });
    expect(calls).toContain(
      "http://127.0.0.1:7381/events?limit=100&before=older-page",
    );
    expect(receipt.run).toEqual({ id: "run-old", state: "QUEUED" });
  });

  test("warns when fresh-admission state lookup fails instead of claiming admitted state", async () => {
    const lookupFailure = new Error("connect ECONNREFUSED 127.0.0.1:7381");
    const stderr = [];
    const fetchImpl = async (_url, options = {}) => {
      if (options.method === "POST") {
        return Response.json({
          admitted: true,
          duplicate: false,
          eventId: REQUEST.requestId,
        });
      }
      throw lookupFailure;
    };
    const originalError = console.error;
    console.error = (line) => stderr.push(line);
    let receipt;
    try {
      receipt = await acceptHandoff(JSON.stringify(REQUEST), {
        repos,
        secret: "secret",
        fetchImpl,
      });
    } finally {
      console.error = originalError;
    }

    expect(receipt.event).toEqual({ id: REQUEST.requestId, state: "unknown" });
    expect(receipt.warnings).toEqual([
      "state_unavailable: connect ECONNREFUSED 127.0.0.1:7381",
    ]);
    expect(stderr).toEqual(receipt.warnings);
  });

  test("rejects request-id reuse for a different ticket", async () => {
    const fetchImpl = async (url, options = {}) => {
      if (options.method === "POST") {
        return Response.json({
          admitted: false,
          duplicate: true,
          eventId: REQUEST.requestId,
        });
      }
      if (url.endsWith("/events?limit=100")) {
        return Response.json({
          events: [
            {
              source: "handoff",
              eventId: REQUEST.requestId,
              status: "planned",
              proposalId: null,
              runId: null,
              envelope: {
                schemaVersion: "factory.event/v1",
                eventId: REQUEST.requestId,
                type: "factory.dispatch.requested",
                source: "handoff",
                subject: "watt-mind/factory#999",
                correlationId: REQUEST.requestId,
                causationId: null,
                payload: { repo: "factory", ticket: "watt-mind/factory#999" },
              },
            },
          ],
          nextBefore: null,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    await expect(
      acceptHandoff(JSON.stringify(REQUEST), {
        repos,
        secret: "secret",
        fetchImpl,
      }),
    ).rejects.toThrow(/idempotency_conflict/);
  });

  test("fails closed without the existing runtime secret", async () => {
    await expect(
      acceptHandoff(JSON.stringify(REQUEST), { repos, secret: null }),
    ).rejects.toThrow(/FACTORY_EVENT_SECRET/);
  });

  test("preserves a fail cause in the forced-command error body", () => {
    const cause = new Error("HTTP 503 runtime unavailable");
    try {
      fail("runtime_status_failed", "runtime status lookup failed", cause);
      expect.unreachable();
    } catch (err) {
      expect(handoffErrorBody(err)).toEqual({
        schemaVersion: "factory.handoff-error/v1",
        error: "runtime_status_failed",
        message: "runtime status lookup failed",
        cause: "Error: HTTP 503 runtime unavailable",
      });
    }
  });

  test("rejects a caller-supplied SSH original command", () => {
    expect(() =>
      assertForcedCommandEnvironment({ SSH_ORIGINAL_COMMAND: "uname -a" }),
    ).toThrow(/ssh_original_command_forbidden/);
    expect(() => assertForcedCommandEnvironment({})).not.toThrow();
  });
});

describe("handoff SSH client", () => {
  test("rejects option-like SSH hosts before spawning ssh", async () => {
    let called = false;
    await expect(
      sendHandoff(REQUEST, {
        host: "-oProxyCommand=touch /tmp/nope",
        ssh: async () => {
          called = true;
          throw new Error("must not spawn");
        },
      }),
    ).rejects.toThrow(/ssh_host_invalid/);
    expect(called).toBe(false);
  });

  test("writes only the strict request and parses a machine receipt", async () => {
    let invocation;
    const receipt = {
      schemaVersion: "factory.handoff-receipt/v1",
      requestId: REQUEST.requestId,
      admitted: false,
      duplicate: true,
      event: { id: REQUEST.requestId, state: "queued" },
      proposal: { id: "prop-1", state: "approved" },
      run: { id: "run-1", state: "QUEUED" },
      dashboardUrl: null,
    };
    const ssh = async (host, input) => {
      invocation = { host, input };
      return { exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" };
    };
    expect(await sendHandoff(REQUEST, { host: "factory-runner", ssh })).toEqual(
      receipt,
    );
    expect(invocation).toEqual({
      host: "factory-runner",
      input: JSON.stringify(REQUEST),
    });
  });

  test("surfaces forced-command errors and rejects malformed receipts", async () => {
    await expect(
      sendHandoff(REQUEST, {
        host: "factory-runner",
        ssh: async () => ({
          exitCode: 1,
          stdout: JSON.stringify({ error: "repo_report_only" }),
          stderr: "",
        }),
      }),
    ).rejects.toThrow(/repo_report_only/);
    await expect(
      sendHandoff(REQUEST, {
        host: "factory-runner",
        ssh: async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }),
      }),
    ).rejects.toThrow(/invalid receipt/);
  });
});
