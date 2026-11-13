import { test, expect } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  expandHome,
  notifyArgv,
  notifyCommand,
  notifyScript,
  queueLocalNotification,
} from "./notify.mjs";

function tmpRoot(policy) {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-notify-policy-"));
  mkdirSync(path.join(dir, "config"));
  if (policy !== null) {
    writeFileSync(path.join(dir, "config", "policy.yaml"), policy, "utf8");
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("expandHome resolves a leading tilde", () => {
  expect(expandHome("~/scripts/n.py", "/home/op")).toBe(
    "/home/op/scripts/n.py",
  );
  expect(expandHome("~", "/home/op")).toBe("/home/op");
  expect(expandHome("/abs/n.py", "/home/op")).toBe("/abs/n.py");
});

test("missing control bearer queues a run-scoped local notification", () => {
  const home = mkdtempSync(path.join(tmpdir(), "factory-notify-outbox-"));
  try {
    const outbox = queueLocalNotification({
      home,
      runId: "run_1558",
      kind: "BLOCKED",
      title: "BLOCKED watt-mind/factory#1558: control API unavailable",
      refs: { issue: "watt-mind/factory#1558", repo: "factory" },
    });
    expect(outbox).toBe(path.join(home, "outbox", "run_1558.jsonl"));
    expect(readFileSync(outbox, "utf8")).toContain(
      '"schemaVersion":"factory.local-notify-outbox/v1"',
    );
    expect(readFileSync(outbox, "utf8")).toContain('"source":"agent:run_1558"');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("no env and no policy yields null, never a private-repo default", () => {
  const { dir, cleanup } = tmpRoot(null);
  try {
    const command = notifyCommand({ env: {}, root: dir });
    expect(command).toBeNull();
    expect(command ?? "").not.toContain("hdkiller");
    expect(notifyArgv({ env: {}, root: dir })).toBeNull();
    expect(notifyScript({ env: {}, root: dir })).toBeNull();
  } finally {
    cleanup();
  }
});

test("empty notify.command in policy is unset, not a fallback path", () => {
  const { dir, cleanup } = tmpRoot("notify:\n  command: ''\n");
  try {
    expect(notifyCommand({ env: {}, root: dir })).toBeNull();
  } finally {
    cleanup();
  }
});

test("policy notify.command is the configured transport, with ~ expanded", () => {
  const { dir, cleanup } = tmpRoot(
    "notify:\n  command: python3 ~/ops/notify.py\n",
  );
  try {
    const home = process.env.HOME;
    expect(notifyCommand({ env: {}, root: dir })).toBe(
      `python3 ${home}/ops/notify.py`,
    );
    expect(notifyScript({ env: {}, root: dir })).toBe(`${home}/ops/notify.py`);
    expect(notifyArgv({ env: {}, root: dir })).toEqual([
      "python3",
      `${home}/ops/notify.py`,
    ]);
  } finally {
    cleanup();
  }
});

test("FACTORY_NOTIFY_CMD wins over policy", () => {
  const { dir, cleanup } = tmpRoot(
    "notify:\n  command: python3 /from/policy.py\n",
  );
  try {
    expect(
      notifyCommand({
        env: { FACTORY_NOTIFY_CMD: "/usr/bin/my-notify" },
        root: dir,
      }),
    ).toBe("/usr/bin/my-notify");
    expect(
      notifyScript({
        env: { FACTORY_NOTIFY_CMD: "/usr/bin/my-notify" },
        root: dir,
      }),
    ).toBeNull();
  } finally {
    cleanup();
  }
});

test("FACTORY_NOTIFY_SCRIPT wraps as python3 <script>", () => {
  const { dir, cleanup } = tmpRoot(
    "notify:\n  command: python3 /from/policy.py\n",
  );
  try {
    expect(
      notifyCommand({
        env: { FACTORY_NOTIFY_SCRIPT: "/tmp/stub.py" },
        root: dir,
      }),
    ).toBe("python3 /tmp/stub.py");
    expect(
      notifyScript({
        env: { FACTORY_NOTIFY_SCRIPT: "/tmp/stub.py" },
        root: dir,
      }),
    ).toBe("/tmp/stub.py");
  } finally {
    cleanup();
  }
});

test("FACTORY_EVENT_NOTIFY_CMD is the third-precedence env override", () => {
  const { dir, cleanup } = tmpRoot(
    "notify:\n  command: python3 /from/policy.py\n",
  );
  try {
    expect(
      notifyCommand({
        env: { FACTORY_EVENT_NOTIFY_CMD: "/x/stub" },
        root: dir,
      }),
    ).toBe("/x/stub");
  } finally {
    cleanup();
  }
});

test("CLI --export-env prints shell exports for the resolved command", () => {
  const result = Bun.spawnSync({
    cmd: ["bun", path.resolve(import.meta.dir, "notify.mjs"), "--export-env"],
    env: {
      ...process.env,
      FACTORY_NOTIFY_CMD: "python3 /opt/notify.py",
      FACTORY_NOTIFY_SCRIPT: "",
      FACTORY_EVENT_NOTIFY_CMD: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const out = result.stdout.toString();
  expect(out).toContain('export FACTORY_NOTIFY_CMD="python3 /opt/notify.py"');
  expect(out).toContain('export FACTORY_NOTIFY_SCRIPT="/opt/notify.py"');
});

test("CLI usage lists --queue-local", () => {
  const result = Bun.spawnSync({
    cmd: ["bun", path.resolve(import.meta.dir, "notify.mjs"), "--bogus-flag"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("--queue-local");
});
