import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendEvent,
  activeSession,
  readEvents,
  resolveSessionId,
  eventLabel,
  SESSION_IDLE_MS,
} from "./factory-state.mjs";

test("appendEvent groups events into one session per repo/harness window", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-state-"));
  const file = path.join(dir, "events.jsonl");
  const t0 = Date.UTC(2026, 7, 10, 17, 0, 0);

  appendEvent(
    {
      type: "session-start",
      repo: "bj29",
      harness: "cursor",
      session: "cursor-bj29-test",
    },
    { file, now: t0 },
  );
  const start = appendEvent(
    {
      type: "recommend",
      repo: "bj29",
      harness: "cursor",
      command: "factory-triage",
      args: "5",
      session: "cursor-bj29-test",
    },
    { file, now: t0 + 1000 },
  );
  appendEvent(
    {
      type: "start",
      repo: "bj29",
      harness: "cursor",
      command: "factory-triage",
      args: "5",
      session: "cursor-bj29-test",
    },
    { file, now: t0 + 2000 },
  );

  expect(start.session).toBe("cursor-bj29-test");
  expect(readEvents({ repo: "bj29", file })).toHaveLength(3);

  const active = activeSession({
    repo: "bj29",
    harness: "cursor",
    now: t0 + 60_000,
    file,
    idleMs: SESSION_IDLE_MS,
  });
  expect(active?.id).toBe(start.session);

  rmSync(dir, { recursive: true, force: true });
});

test("activeSession expires after idle gap", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-state-"));
  const file = path.join(dir, "events.jsonl");
  const t0 = Date.UTC(2026, 7, 10, 17, 0, 0);

  appendEvent(
    { type: "start", repo: "bj29", harness: "pi", command: "factory-work" },
    { file, now: t0 },
  );
  expect(
    activeSession({ repo: "bj29", now: t0 + SESSION_IDLE_MS + 1, file }),
  ).toBeNull();

  rmSync(dir, { recursive: true, force: true });
});

test("resolveSessionId respects FACTORY_SESSION_ID", () => {
  const prev = process.env.FACTORY_SESSION_ID;
  process.env.FACTORY_SESSION_ID = "custom-session";
  expect(resolveSessionId({ repo: "bj29", harness: "cursor" })).toBe(
    "custom-session",
  );
  process.env.FACTORY_SESSION_ID = prev;
});

test("eventLabel formats recommend and complete rows", () => {
  expect(
    eventLabel({ type: "recommend", command: "factory-merge", args: "" }),
  ).toBe("recommend   /factory-merge");
  expect(eventLabel({ type: "complete", summary: "merged 2 PRs" })).toBe(
    "complete    merged 2 PRs",
  );
});

test("appendEvent enforces 0700 state dir and 0600 journal file under permissive umask (GH-957)", () => {
  if (process.platform === "win32") return; // POSIX mode bits not enforced on win32
  const prevUmask = process.umask(0o022);
  const root = mkdtempSync(path.join(tmpdir(), "factory-state-perms-"));
  const stateDir = path.join(root, "state");
  const file = path.join(stateDir, "events.jsonl");
  try {
    appendEvent({ type: "start", repo: "factory" }, { file });
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Pre-existing broader permissions are repaired on next append
    chmodSync(stateDir, 0o755);
    chmodSync(file, 0o644);
    appendEvent({ type: "complete", repo: "factory" }, { file });
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(prevUmask);
    rmSync(root, { recursive: true, force: true });
  }
});
