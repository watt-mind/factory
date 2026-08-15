import { describe, expect, test } from "bun:test";
import {
  buildArgv,
  execute,
  probeBytes,
  substituteArgv,
  substituteRemote,
  validateRemotePlaceholders,
} from "./actions.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), p));

describe("buildArgv (OPS-410)", () => {
  test("replaces {target} and {remote} in exec template", () => {
    const exec = ["ssh", "-o", "BatchMode=yes", "{target}", "{remote}"];
    const argv = buildArgv(exec, "root@10.0.0.1", "df -h");
    expect(argv).toEqual(["ssh", "-o", "BatchMode=yes", "root@10.0.0.1", "df -h"]);
  });

  test("handles multiple occurrences of {target} or {remote}", () => {
    const exec = ["echo", "{target}", "and", "{target}", "running", "{remote}"];
    const argv = buildArgv(exec, "host1", "cmd1");
    expect(argv).toEqual(["echo", "host1", "and", "host1", "running", "cmd1"]);
  });

  test("safely handles special $ patterns in remote without regex backreference corruption", () => {
    const exec = ["ssh", "{target}", "{remote}"];
    const remoteWithDollar = "awk '{print $1}' /var/log/syslog | grep $& | sed 's/$//'";
    const argv = buildArgv(exec, "user@host", remoteWithDollar);
    expect(argv).toEqual(["ssh", "user@host", remoteWithDollar]);
  });

  test("expands array remote into argv elements when element is exact {remote}", () => {
    const exec = ["ssh", "{target}", "{remote}"];
    const argv = buildArgv(exec, "user@host", ["df", "--output=used", "-B1", "/var"]);
    expect(argv).toEqual(["ssh", "user@host", "df", "--output=used", "-B1", "/var"]);
  });
});

describe("validateRemotePlaceholders (OPS-410)", () => {
  test("accepts placeholders with anchored pattern in inputSchema", () => {
    const def = {
      probeRemote: "df --output=used -B1 {mount} | tail -1",
      actionRegistry: {
        clean: { remote: "rm -rf {mount}/tmp" },
      },
    };
    const schema = {
      type: "object",
      properties: {
        mount: { type: "string", pattern: "^/[A-Za-z0-9/._-]*$" },
      },
    };
    expect(() => validateRemotePlaceholders(def, schema)).not.toThrow();
  });

  test("accepts placeholders with enum in inputSchema", () => {
    const def = {
      probeRemote: "check {service}",
      actionRegistry: {
        restart: { remote: "systemctl restart {service}" },
      },
    };
    const schema = {
      type: "object",
      properties: {
        service: { type: "string", enum: ["nginx", "redis"] },
      },
    };
    expect(() => validateRemotePlaceholders(def, schema)).not.toThrow();
  });

  test("throws when placeholder has unanchored pattern", () => {
    const def = {
      probeRemote: "cat {path}",
    };
    const schema = {
      type: "object",
      properties: {
        path: { type: "string", pattern: "[a-z]+" },
      },
    };
    expect(() => validateRemotePlaceholders(def, schema)).toThrow(/unconstrained placeholder/);
  });

  test("throws when placeholder property lacks both enum and anchored pattern", () => {
    const def = {
      probeRemote: "df -h {mount}",
    };
    const schema = {
      type: "object",
      properties: {
        mount: { type: "string" },
      },
    };
    expect(() => validateRemotePlaceholders(def, schema)).toThrow(/unconstrained placeholder/);
  });

  test("throws when placeholder is completely missing from inputSchema", () => {
    const def = {
      probeRemote: "df -h {missing}",
    };
    const schema = {
      type: "object",
      properties: {},
    };
    expect(() => validateRemotePlaceholders(def, schema)).toThrow(/missing from input schema/);
  });
});

describe("substituteRemote", () => {
  test("substitutes placeholders from input", () => {
    const res = substituteRemote("df -h {mount}", { mount: "/data" });
    expect(res).toBe("df -h /data");
  });

  test("substitutes placeholders in array", () => {
    const res = substituteRemote(["df", "-h", "{mount}"], { mount: "/data" });
    expect(res).toEqual(["df", "-h", "/data"]);
  });

  test("throws on missing or non-primitive input field", () => {
    expect(() => substituteRemote("df -h {mount}", {})).toThrow(/missing\/non-primitive/);
    expect(() => substituteRemote("df -h {mount}", { mount: { nested: true } })).toThrow(/missing\/non-primitive/);
  });
});

describe("substituteArgv", () => {
  test("substitutes fields in argv elements", () => {
    const argv = ["echo", "{issueId}", "--action", "{action}"];
    const out = substituteArgv(argv, { issueId: "OPS-123", action: "close" });
    expect(out).toEqual(["echo", "OPS-123", "--action", "close"]);
  });

  test("throws on missing or non-primitive fields", () => {
    expect(() => substituteArgv(["echo", "{missing}"], {})).toThrow(/missing\/non-primitive/);
  });
});

describe("probeBytes", () => {
  test("parses last integer in probe output", () => {
    expect(probeBytes("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 10000 456789\n")).toBe(456789);
    expect(probeBytes("   12345   \n")).toBe(12345);
  });

  test("throws on invalid probe output without numbers", () => {
    expect(() => probeBytes("no numbers here")).toThrow(/probe output has no byte count/);
    expect(() => probeBytes("")).toThrow(/probe output has no byte count/);
  });
});

describe("execute refutations", () => {
  test("refuses execution when placeholder is unconstrained in input schema", async () => {
    const ws = tmp("evrt-ws-");
    const def = {
      ref: "test@1",
      exec: ["ssh", "{target}", "{remote}"],
      hosts: { lab: "root@10.0.0.1" },
      probeRemote: "df {unconstrained}",
      actionRegistry: { a: { remote: "echo 1" } },
      inputSchema: {
        type: "object",
        properties: {
          host: { type: "string", enum: ["lab"] },
          unconstrained: { type: "string" },
          actions: { type: "array" },
        },
      },
    };
    const spec = {
      input: { host: "lab", unconstrained: "; rm -rf /", actions: [{ action: "a" }] },
    };
    const res = await execute({ spec, def, workspaceDir: ws, timeoutMs: 5000 });
    expect(res.exitCode).toBe(1);
    expect(readFileSync(path.join(ws, ".actions.log"), "utf8")).toContain("unconstrained placeholder");
  });

  test("refuses execution on unknown host", async () => {
    const ws = tmp("evrt-ws-");
    const def = {
      ref: "test@1",
      exec: ["ssh", "{target}", "{remote}"],
      hosts: { lab: "root@10.0.0.1" },
      probeRemote: "df /",
      actionRegistry: { a: { remote: "echo 1" } },
    };
    const spec = {
      input: { host: "unknown-host", actions: [{ action: "a" }] },
    };
    const res = await execute({ spec, def, workspaceDir: ws, timeoutMs: 5000 });
    expect(res.exitCode).toBe(1);
    expect(readFileSync(path.join(ws, ".actions.log"), "utf8")).toContain("not in the definition's host allowlist");
  });
});

describe("execute item-list mode (OPS-229, WM-109, WM-116)", () => {
  test("executes registered actions and records standardized issueId from itemKey", async () => {
    const ws = tmp("evrt-ws-");
    const def = {
      ref: "merge-apply@1",
      itemsField: "plan",
      itemKey: "ticket",
      actionRegistry: {
        echo_ticket: { argv: ["echo", "ticket={ticket}", "repo={repo}"] },
        echo_reason: { argv: ["echo", "reason={reason}"] },
      },
    };
    const spec = {
      input: {
        repo: "bj29",
        plan: [
          { ticket: "WM-116", action: "echo_ticket", reason: "testing item key" },
          { ticket: "WM-117", action: "echo_reason", reason: "second item" },
        ],
      },
    };
    const res = await execute({ spec, def, workspaceDir: ws, timeoutMs: 5000 });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);

    const result = JSON.parse(readFileSync(path.join(ws, "result.json"), "utf8"));
    expect(result.schemaVersion).toBe("factory.agent-result/v1");
    expect(result.terminalState).toBe("completed");
    expect(result.artifact).toEqual({
      repo: "bj29",
      applied: [
        { issueId: "WM-116", action: "echo_ticket" },
        { issueId: "WM-117", action: "echo_reason" },
      ],
    });
  });

  test("refuses before executing any item when an action is unregistered", async () => {
    const ws = tmp("evrt-ws-");
    const def = {
      ref: "test-apply@1",
      itemsField: "plan",
      itemKey: "issueId",
      actionRegistry: {
        valid_action: { argv: ["echo", "ok"] },
      },
    };
    const spec = {
      input: {
        repo: "test-repo",
        plan: [
          { issueId: "T-1", action: "valid_action" },
          { issueId: "T-2", action: "unknown_action" },
        ],
      },
    };
    const res = await execute({ spec, def, workspaceDir: ws, timeoutMs: 5000 });
    expect(res.exitCode).toBe(1);
    expect(readFileSync(path.join(ws, ".actions.log"), "utf8")).toContain(
      'REFUSED before execution: action "unknown_action" is not in the closed action registry',
    );
  });
});

