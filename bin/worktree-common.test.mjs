import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, expect, test } from "bun:test";
import { until } from "../event-runtime/lib/test-helpers-timing.mjs";

const COMMON = path.resolve(import.meta.dir, "worktree-common.sh");
const WORKTREE_UP = path.resolve(import.meta.dir, "worktree-up.sh");
const WORKTREE_DAEMONS = path.resolve(import.meta.dir, "worktree-daemons.sh");

// Private port band for this test run (WM-113). Fixed in-band ports (7752,
// 7772, …) collide with real runtimes, leftover servers, and concurrent CI
// jobs — EADDRINUSE before the assertion even runs. Instead, probe random
// even bases in the ephemeral-ish 20000–60000 range until every offset the
// fixtures bind is free, and pass the band to the scripts via
// FACTORY_PORT_BASE / FACTORY_PORT_SPAN. No absolute ports below.
const PORT_SPAN = 200;
const FIXTURE_OFFSETS = [
  352, 353, 360, 361, 362, 363, 364, 365, 366, 367, 372, 373, 374, 375, 396,
  397,
];

function offsetsBindable(base) {
  for (const off of FIXTURE_OFFSETS) {
    try {
      const l = Bun.listen({
        hostname: "127.0.0.1",
        port: base + off,
        socket: { data() {} },
      });
      l.stop(true);
    } catch {
      return false;
    }
  }
  return true;
}

function pickPortBase() {
  for (let i = 0; i < 50; i++) {
    // Even base in 20000–59998 so every slot in the band stays even.
    const candidate = 20000 + 2 * Math.floor(Math.random() * 20000);
    if (offsetsBindable(candidate)) return candidate;
  }
  throw new Error("could not find a free port band for worktree-common tests");
}

const PORT_BASE = pickPortBase();
const PORT_RESERVATION_ROOT = mkdtempSync(
  path.join(tmpdir(), "factory-port-reservations-"),
);
// The handoff verifier exposes read-only /usr but intentionally starts with an
// empty /etc. On Debian, /usr/bin/awk points through /etc/alternatives, so give
// shell fixtures a direct wrapper to the real executable they are testing with.
const TEST_TOOL_BIN = mkdtempSync(path.join(tmpdir(), "factory-test-tools-"));
writeFileSync(
  path.join(TEST_TOOL_BIN, "awk"),
  '#!/bin/bash\nexec /usr/bin/mawk "$@"\n',
);
chmodSync(path.join(TEST_TOOL_BIN, "awk"), 0o755);
const TEST_PATH = `${TEST_TOOL_BIN}:${process.env.PATH}`;
const P = (offset) => PORT_BASE + offset;
const BAND_ENV = {
  FACTORY_PORT_BASE: String(PORT_BASE),
  FACTORY_PORT_SPAN: String(PORT_SPAN),
  FACTORY_PORT_RESERVATION_ROOT: PORT_RESERVATION_ROOT,
};

afterAll(() => {
  rmSync(PORT_RESERVATION_ROOT, { recursive: true, force: true });
  rmSync(TEST_TOOL_BIN, { recursive: true, force: true });
});

function sh(body, extraEnv = {}) {
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", `source "${COMMON}"\n${body}`],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: TEST_PATH, ...BAND_ENV, ...extraEnv },
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function command(cmd, cwd, extraEnv = {}) {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: TEST_PATH, ...extraEnv },
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("run log rotation retains bounded generations and copy-truncates a live owner", () => {
  const r = sh(`
    dir="$(mktemp -d)"
    trap 'rm -rf "$dir"' EXIT
    log="$dir/worker.log"
    printf 'new' > "$log"
    printf 'one' > "$log.1"
    printf 'two' > "$log.2"
    printf 'three' > "$log.3"
    printf 'stale' > "$log.4"
    printf 'staler' > "$log.7"
    rotate_run_log "$log" 1 3 >/dev/null
    printf 'generations=%s/%s/%s current=%s stale=%s\\n' "$(cat "$log.1")" "$(cat "$log.2")" "$(cat "$log.3")" "$(wc -c < "$log" | tr -d '[:space:]')" "$(ls "$dir" | grep -c 'worker\\.log\\.[4-9]' || true)"

    exec 9>> "$log"
    printf 'before' >&9
    printf '%s\\n' $$ > "$dir/worker.pid"
    rotate_run_log "$log" 1 3 >/dev/null
    printf 'after' >&9
    exec 9>&-
    printf 'live-current=%s archive=%s\\n' "$(cat "$log")" "$(cat "$log.1")"
  `);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("generations=new/one/two current=0 stale=0");
  expect(r.stdout).toContain("live-current=after archive=before");
});

function git(cwd, ...args) {
  const result = command(["git", ...args], cwd);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function worktreeUpFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "wm-934-worktree-up-"));
  const remote = path.join(root, "origin.git");
  const worktrees = mkdtempSync(path.join(tmpdir(), "wm-934-worktrees-"));
  const mockBin = mkdtempSync(path.join(tmpdir(), "wm-934-gh-"));
  mkdirSync(path.join(root, "bin"));
  cpSync(COMMON, path.join(root, "bin", "worktree-common.sh"));
  cpSync(WORKTREE_DAEMONS, path.join(root, "bin", "worktree-daemons.sh"));
  cpSync(WORKTREE_UP, path.join(root, "bin", "worktree-up.sh"));
  chmodSync(path.join(root, "bin", "worktree-up.sh"), 0o755);
  writeFileSync(
    path.join(mockBin, "gh"),
    "#!/usr/bin/env bash\nprintf '0\\n'\n",
  );
  chmodSync(path.join(mockBin, "gh"), 0o755);
  git(root, "init", "-q", "-b", "develop");
  git(root, "config", "user.name", "Worktree test");
  git(root, "config", "user.email", "worktree-test@example.test");
  git(root, "add", "bin");
  git(root, "commit", "-qm", "base");
  git(root, "init", "-q", "--bare", remote);
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-qu", "origin", "develop");
  return { root, remote, worktrees, mockBin };
}

function runWorktreeUp(fixture, ticket) {
  return command(
    ["bash", "bin/worktree-up.sh", ticket, "--checkout-only"],
    fixture.root,
    {
      FACTORY_WT_ROOT: fixture.worktrees,
      PATH: `${fixture.mockBin}:${TEST_PATH}`,
    },
  );
}

async function shAsync(body, extraEnv = {}) {
  const proc = Bun.spawn(["bash", "-c", `source "${COMMON}"\n${body}`], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: TEST_PATH, ...BAND_ENV, ...extraEnv },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  return { status, stdout, stderr };
}

function firstPortNotListening(preferred) {
  for (let port = preferred, i = 0; i < PORT_SPAN; port += 2, i++) {
    // Use the allocator's own availability probe instead of assuming a port
    // in the test band stayed free after pickPortBase checked it.
    if (sh(`port_listening ${port}`).status !== 0) return port;
  }
  throw new Error(`could not find a free API port at or after ${preferred}`);
}

function expectPortBindable(port) {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port,
    socket: { data() {} },
  });
  listener.stop(true);
}

async function waitForPort(port) {
  await until(
    `port ${port} to listen`,
    () => sh(`port_listening ${port}`).status === 0,
  );
}

function mockLsofDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "wm-473-lsof-"));
  const executable = path.join(dir, "lsof");
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
pid=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-p" ]]; then pid="$2"; shift 2; else shift; fi
done
pid="\${MOCK_LSOF_PID:-$pid}"
printf '%s\\n' 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME'
printf 'mock %s user 1u IPv4 0 0t0 TCP 127.0.0.1:%s (LISTEN)\\n' "$pid" "$MOCK_LSOF_PORT"
`,
  );
  chmodSync(executable, 0o755);
  return dir;
}

test("ticket_api_port hashes the full id so N and N+200 do not share a slot", () => {
  const a = sh("ticket_api_port OPS-201");
  const b = sh("ticket_api_port OPS-401");
  expect(a.status).toBe(0);
  expect(b.status).toBe(0);
  expect(a.stdout).not.toBe(b.stdout);
  for (const port of [Number(a.stdout), Number(b.stdout)]) {
    expect(port % 2).toBe(0);
    // Preferred-slot math must follow the overridden base, not the default.
    expect(port).toBeGreaterThanOrEqual(PORT_BASE);
    expect(port).toBeLessThan(PORT_BASE + 2 * PORT_SPAN);
  }
});

test("ticket_api_port treats OPS-123 and OPS-123-scratch as different tickets", () => {
  const a = sh("ticket_api_port OPS-123");
  const b = sh("ticket_api_port OPS-123-scratch");
  expect(a.status).toBe(0);
  expect(b.status).toBe(0);
  expect(a.stdout).not.toBe(b.stdout);
});

test("write_ports / read_ports round-trip", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "ops-460-ports-"));
  try {
    const written = sh(
      `write_ports "${wt}" ${P(352)} ${P(353)}\nread_ports "${wt}"`,
    );
    expect(written.status).toBe(0);
    expect(written.stdout.trim()).toBe(`${P(352)} ${P(353)}`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("provision_instance_local_configs copies ignored local config and skips absent files", () => {
  const source = mkdtempSync(path.join(tmpdir(), "wm-1005-config-source-"));
  const checkout = mkdtempSync(path.join(tmpdir(), "wm-1005-config-checkout-"));
  try {
    mkdirSync(path.join(source, "config"), { recursive: true });
    mkdirSync(path.join(checkout, "config"), { recursive: true });
    writeFileSync(
      path.join(checkout, ".gitignore"),
      "config/repos.yaml\nconfig/policy.yaml\nconfig/schedule.yaml\n",
    );
    writeFileSync(path.join(source, "config", "repos.yaml"), "repos: []\n");
    writeFileSync(path.join(source, "config", "policy.yaml"), "limits: {}\n");
    const r = sh(
      [
        `git -C "${checkout}" init -q`,
        `provision_instance_local_configs "${checkout}" "${source}"`,
        `test "$(cat "${checkout}/config/repos.yaml")" = "repos: []"`,
        `test "$(cat "${checkout}/config/policy.yaml")" = "limits: {}"`,
        `git -C "${checkout}" check-ignore -q config/repos.yaml`,
        `git -C "${checkout}" check-ignore -q config/policy.yaml`,
      ].join("\n"),
    );
    expect(r.status).toBe(0);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

function graphifyFixture() {
  const source = mkdtempSync(path.join(tmpdir(), "graphify-source-"));
  const checkout = mkdtempSync(path.join(tmpdir(), "graphify-checkout-"));
  mkdirSync(path.join(source, "graphify-out"), { recursive: true });
  writeFileSync(
    path.join(source, "graphify-out", "graph.json"),
    '{"nodes": []}\n',
  );
  mkdirSync(path.join(checkout, "config"), { recursive: true });
  return {
    source,
    checkout,
    cleanup() {
      rmSync(source, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    },
  };
}

test("provision_instance_local_configs seeds graphify-out when the target ignores it (#1228)", () => {
  const f = graphifyFixture();
  try {
    writeFileSync(
      path.join(f.checkout, ".gitignore"),
      "config/repos.yaml\nconfig/policy.yaml\ngraphify-out/\n",
    );
    const r = sh(
      [
        `git -C "${f.checkout}" init -q`,
        `provision_instance_local_configs "${f.checkout}" "${f.source}"`,
        `test "$(cat "${f.checkout}/graphify-out/graph.json")" = '{"nodes": []}'`,
        `test ! -e "${f.checkout}/graphify-out.tmp."*`,
        `git -C "${f.checkout}" check-ignore -q "graphify-out/"`,
      ].join("\n"),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("graphify-out seed skipped");
  } finally {
    f.cleanup();
  }
});

test("provision_instance_local_configs does not seed graphify-out when the target tracks it (#1228)", () => {
  const f = graphifyFixture();
  try {
    writeFileSync(
      path.join(f.checkout, ".gitignore"),
      "config/repos.yaml\nconfig/policy.yaml\n",
    );
    const r = sh(
      [
        `git -C "${f.checkout}" init -q`,
        `provision_instance_local_configs "${f.checkout}" "${f.source}"`,
        `test ! -e "${f.checkout}/graphify-out"`,
      ].join("\n"),
    );
    expect(r.status).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("provision_instance_local_configs skips the graphify-out seed under FACTORY_PROVISION_GRAPHIFY=0 (#1228)", () => {
  const f = graphifyFixture();
  try {
    writeFileSync(
      path.join(f.checkout, ".gitignore"),
      "config/repos.yaml\nconfig/policy.yaml\ngraphify-out/\n",
    );
    const r = sh(
      [
        `git -C "${f.checkout}" init -q`,
        `FACTORY_PROVISION_GRAPHIFY=0 provision_instance_local_configs "${f.checkout}" "${f.source}"`,
        `test ! -e "${f.checkout}/graphify-out"`,
      ].join("\n"),
    );
    expect(r.status).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("provision_instance_local_configs never materializes the operator schedule overlay (#1051)", () => {
  const source = mkdtempSync(path.join(tmpdir(), "gh-1051-config-source-"));
  const checkout = mkdtempSync(path.join(tmpdir(), "gh-1051-config-checkout-"));
  try {
    mkdirSync(path.join(source, "config"), { recursive: true });
    mkdirSync(path.join(checkout, "config"), { recursive: true });
    writeFileSync(
      path.join(checkout, ".gitignore"),
      "config/repos.yaml\nconfig/policy.yaml\nconfig/schedule.yaml\n",
    );
    writeFileSync(path.join(source, "config", "repos.yaml"), "repos: []\n");
    // A stale, partial operator overlay: a loop trimmed out of the branch's
    // kernel, left with `enabled: true` and no cadence. Copied in, it would
    // break the repo verify gate with `unparseable cadence "undefined"`.
    writeFileSync(
      path.join(source, "config", "schedule.yaml"),
      "schedules:\n  work-bj29:\n    enabled: true\n",
    );
    const r = sh(
      [
        `git -C "${checkout}" init -q`,
        `provision_instance_local_configs "${checkout}" "${source}"`,
        `test "$(cat "${checkout}/config/repos.yaml")" = "repos: []"`,
        `test ! -e "${checkout}/config/schedule.yaml"`,
      ].join("\n"),
    );
    expect(r.status).toBe(0);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("provision_instance_local_configs silently skips a source without local files", () => {
  const source = mkdtempSync(path.join(tmpdir(), "wm-1005-empty-source-"));
  const checkout = mkdtempSync(path.join(tmpdir(), "wm-1005-empty-checkout-"));
  try {
    const r = sh(
      `provision_instance_local_configs "${checkout}" "${source}"\ntest ! -e "${checkout}/config/repos.yaml"`,
    );
    expect(r.status).toBe(0);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("normalize_path is portable and accepts a missing final component", () => {
  const root = mkdtempSync(path.join(tmpdir(), "gh-937-normalize-"));
  const mockBin = mkdtempSync(path.join(tmpdir(), "gh-937-realpath-"));
  try {
    mkdirSync(path.join(root, "existing"));
    writeFileSync(
      path.join(mockBin, "realpath"),
      "#!/usr/bin/env bash\nprintf '%s\\n' 'realpath: illegal option -- m' >&2\nexit 1\n",
    );
    chmodSync(path.join(mockBin, "realpath"), 0o755);
    const missing = path.join(root, "existing", "missing-leaf");
    const r = sh(`normalize_path "${root}/existing/../existing/missing-leaf"`, {
      PATH: `${mockBin}:${TEST_PATH}`,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(missing);
    expect(r.stderr).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
  }
});

test("provision_instance_local_configs does not invoke GNU-only realpath", () => {
  const source = mkdtempSync(path.join(tmpdir(), "gh-937-config-source-"));
  const checkout = mkdtempSync(path.join(tmpdir(), "gh-937-config-checkout-"));
  const mockBin = mkdtempSync(path.join(tmpdir(), "gh-937-realpath-"));
  try {
    mkdirSync(path.join(source, "config"));
    mkdirSync(path.join(checkout, "config"));
    writeFileSync(path.join(source, "config", "repos.yaml"), "repos: []\n");
    writeFileSync(path.join(checkout, ".gitignore"), "config/repos.yaml\n");
    writeFileSync(
      path.join(mockBin, "realpath"),
      "#!/usr/bin/env bash\nprintf '%s\\n' 'realpath: illegal option -- m' >&2\nexit 1\n",
    );
    chmodSync(path.join(mockBin, "realpath"), 0o755);
    const r = sh(
      [
        `git -C "${checkout}" init -q`,
        `provision_instance_local_configs "${checkout}" "${source}"`,
        `test "$(cat "${checkout}/config/repos.yaml")" = "repos: []"`,
      ].join("\n"),
      { PATH: `${mockBin}:${TEST_PATH}` },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
    rmSync(mockBin, { recursive: true, force: true });
  }
});

test("listen_tcp_port rejects a dead pid even if lsof returns a listener", () => {
  const dir = mockLsofDir();
  const pidfile = path.join(dir, "dead.pid");
  writeFileSync(pidfile, "2147483647\n");
  try {
    // Override the initial guard to reproduce the kill/lsof TOCTOU window on
    // platforms where lsof correctly rejects a dead -p value.
    const r = sh(`pid_alive() { return 0; }\nlisten_tcp_port "${pidfile}"`, {
      PATH: `${dir}:${TEST_PATH}`,
      MOCK_LSOF_PORT: String(P(352)),
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listen_tcp_port rejects a recovered port outside the configured band", () => {
  const dir = mockLsofDir();
  const pidfile = path.join(dir, "live.pid");
  try {
    const r = sh(
      `printf '%s\\n' $$ > "${pidfile}"\nlisten_tcp_port "${pidfile}"`,
      {
        PATH: `${dir}:${TEST_PATH}`,
        MOCK_LSOF_PORT: String(PORT_BASE + 2 * PORT_SPAN),
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listen_tcp_port accepts the fixed --here web port below the ticket band", () => {
  const dir = mockLsofDir();
  const pidfile = path.join(dir, "here.pid");
  try {
    const r = sh(
      `printf '%s\\n' $$ > "${pidfile}"\nlisten_tcp_port "${pidfile}"`,
      {
        PATH: `${dir}:${TEST_PATH}`,
        MOCK_LSOF_PORT: "7392",
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("7392");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve_worktree_ports reuses free recorded ports for --here", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "wm-176-recorded-"));
  try {
    const r = sh(
      [
        `write_ports "${wt}" ${P(352)} ${P(353)}`,
        `resolve_worktree_ports "${wt}" ${P(360)} "${wt}/.factory/event-runtime"`,
        'printf "resolved=%s %s\\n" "$API_PORT" "$WEB_PORT"',
        `printf "recorded=%s\\n" "$(read_ports "${wt}")"`,
      ].join("\n"),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`resolved=${P(352)} ${P(353)}`);
    expect(r.stdout).toContain(`recorded=${P(352)} ${P(353)}`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("resolve_worktree_ports falls back when the preferred --here port is occupied", async () => {
  const wt = mkdtempSync(path.join(tmpdir(), "wm-176-collision-"));
  const preferred = P(360);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: preferred,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") {
        return Response.json({
          ok: true,
          env: { home: "/other/checkout/.factory/event-runtime" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const r = await shAsync(
      [
        `resolve_worktree_ports "${wt}" ${preferred} "${wt}/.factory/event-runtime"`,
        'printf "resolved=%s %s\\n" "$API_PORT" "$WEB_PORT"',
        `printf "recorded=%s\\n" "$(read_ports "${wt}")"`,
      ].join("\n"),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`resolved=${P(362)} ${P(363)}`);
    expect(r.stdout).toContain(`recorded=${P(362)} ${P(363)}`);
  } finally {
    server.stop(true);
    rmSync(wt, { recursive: true, force: true });
  }
});

test("resolve_worktree_ports skips a preferred pair whose web port is occupied", async () => {
  const wt = mkdtempSync(path.join(tmpdir(), "wm-176-web-collision-"));
  const preferred = P(360);
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: P(361),
    socket: { data() {} },
  });
  try {
    const r = await shAsync(
      [
        `resolve_worktree_ports "${wt}" ${preferred} "${wt}/.factory/event-runtime"`,
        'printf "resolved=%s %s\\n" "$API_PORT" "$WEB_PORT"',
      ].join("\n"),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`resolved=${P(362)} ${P(363)}`);
  } finally {
    listener.stop(true);
    rmSync(wt, { recursive: true, force: true });
  }
});

test("overlapping odd and even preferred pairs cannot be reserved concurrently", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wm-351-overlap-"));
  const wtOdd = path.join(root, "odd");
  const wtEven = path.join(root, "even");
  const oddReady = path.join(root, "odd.ready");
  const evenReady = path.join(root, "even.ready");
  mkdirSync(wtOdd);
  mkdirSync(wtEven);

  const contend = (wt, preferred, ownReady, otherReady) =>
    shAsync(
      [
        `resolve_worktree_ports "${wt}" ${preferred} "${wt}/.factory/event-runtime"`,
        `touch "${ownReady}"`,
        `for _ in {1..200}; do [[ -e "${otherReady}" ]] && break; sleep 0.01; done`,
        `test -e "${otherReady}"`,
        'printf "api=%s web=%s\\n" "$API_PORT" "$WEB_PORT"',
      ].join("\n"),
    );

  try {
    const [odd, even] = await Promise.all([
      contend(wtOdd, P(359), oddReady, evenReady),
      contend(wtEven, P(360), evenReady, oddReady),
    ]);
    expect(odd.status).toBe(0);
    expect(even.status).toBe(0);
    const oddPorts = [...odd.stdout.matchAll(/(?:api|web)=(\d+)/g)].map(
      (match) => Number(match[1]),
    );
    const evenPorts = [...even.stdout.matchAll(/(?:api|web)=(\d+)/g)].map(
      (match) => Number(match[1]),
    );
    expect(oddPorts).toHaveLength(2);
    expect(evenPorts).toHaveLength(2);
    expect(oddPorts.some((port) => evenPorts.includes(port))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolve_worktree_ports replaces recorded ports when the web port is occupied", async () => {
  const wt = mkdtempSync(path.join(tmpdir(), "wm-176-recorded-web-collision-"));
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: P(365),
    socket: { data() {} },
  });
  try {
    const r = await shAsync(
      [
        `write_ports "${wt}" ${P(364)} ${P(365)}`,
        `resolve_worktree_ports "${wt}" ${P(372)} "${wt}/.factory/event-runtime"`,
        'printf "resolved=%s %s\\n" "$API_PORT" "$WEB_PORT"',
        `printf "recorded=%s\\n" "$(read_ports "${wt}")"`,
      ].join("\n"),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`resolved=${P(372)} ${P(373)}`);
    expect(r.stdout).toContain(`recorded=${P(372)} ${P(373)}`);
  } finally {
    listener.stop(true);
    rmSync(wt, { recursive: true, force: true });
  }
});

test("resolve_worktree_ports reuses recorded ports owned by this checkout", async () => {
  const wt = mkdtempSync(path.join(tmpdir(), "wm-176-owned-"));
  const home = `${wt}/.factory/event-runtime`;
  const api = P(374);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: api,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") {
        return Response.json({ ok: true, env: { home } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const r = await shAsync(
      [
        `write_ports "${wt}" ${api} ${P(375)}`,
        `resolve_worktree_ports "${wt}" ${P(360)} "${home}"`,
        'printf "resolved=%s %s\\n" "$API_PORT" "$WEB_PORT"',
      ].join("\n"),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`resolved=${api} ${P(375)}`);
  } finally {
    server.stop(true);
    rmSync(wt, { recursive: true, force: true });
  }
});

test("colliding WM-294 and WM-345 startups reserve distinct pairs and stop independently", async () => {
  const wt1 = mkdtempSync(path.join(tmpdir(), "wm-351-runtime-a-"));
  const wt2 = mkdtempSync(path.join(tmpdir(), "wm-351-runtime-b-"));
  const preferred1 = sh("ticket_api_port WM-294");
  const preferred2 = sh("ticket_api_port WM-345");
  expect(preferred1.status).toBe(0);
  expect(preferred2.status).toBe(0);
  expect(preferred1.stdout).toBe(preferred2.stdout);
  const preferred = Number(preferred1.stdout);

  const launch = (wt) =>
    shAsync(
      [
        `home="${wt}/.factory/event-runtime"`,
        `resolve_worktree_ports "${wt}" ${preferred} "$home"`,
        `spawn_daemon "$(run_dir "${wt}")/serve.pid" "$(run_dir "${wt}")/serve.log" "${wt}" env MOCK_HOME="$home" MOCK_PORT="$API_PORT" bun --eval 'Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.MOCK_PORT), fetch() { return Response.json({ env: { home: process.env.MOCK_HOME } }); } });'`,
        `spawn_daemon "$(run_dir "${wt}")/web.pid" "$(run_dir "${wt}")/web.log" "${wt}" env MOCK_PORT="$WEB_PORT" bun --eval 'Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.MOCK_PORT), fetch() { return new Response("web"); } });'`,
        'for _ in {1..100}; do port_listening "$API_PORT" && port_listening "$WEB_PORT" && break; sleep 0.01; done',
        'port_listening "$API_PORT" && port_listening "$WEB_PORT"',
        'printf "api=%s web=%s\\n" "$API_PORT" "$WEB_PORT"',
      ].join("\n"),
    );

  const stop = (wt) =>
    sh(
      [
        `rdir="$(run_dir "${wt}")"`,
        'term_daemon "$rdir/web.pid" "web"',
        'term_daemon "$rdir/serve.pid" "serve"',
        'await_daemon "$rdir/web.pid" "web"',
        'await_daemon "$rdir/serve.pid" "serve"',
        `release_port_reservation "${wt}"`,
      ].join("\n"),
    );

  try {
    const [a, b] = await Promise.all([launch(wt1), launch(wt2)]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const api1 = Number(a.stdout.match(/api=(\d+)/)?.[1]);
    const api2 = Number(b.stdout.match(/api=(\d+)/)?.[1]);
    expect(api1).not.toBe(api2);
    expect(Math.abs(api1 - api2)).toBe(2);

    const rerun = sh(
      [
        `resolve_worktree_ports "${wt1}" ${preferred} "${wt1}/.factory/event-runtime"`,
        'printf "%s %s\\n" "$API_PORT" "$WEB_PORT"',
      ].join("\n"),
    );
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain(`${api1} ${api1 + 1}`);

    expect(stop(wt1).status).toBe(0);
    await waitForPort(api2);
    expect(stop(wt2).status).toBe(0);
    expect(sh(`port_listening ${api2}`).status).not.toBe(0);
  } finally {
    stop(wt1);
    stop(wt2);
    rmSync(wt1, { recursive: true, force: true });
    rmSync(wt2, { recursive: true, force: true });
  }
});

test("failed startup cleanup removes partial pid and port reservation state", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "wm-351-failed-startup-"));
  try {
    const r = sh(
      [
        `resolve_worktree_ports "${wt}" ${P(360)} "${wt}/.factory/event-runtime"`,
        `rdir="$(run_dir "${wt}")"`,
        'printf "2147483647\\n" >"$rdir/serve.pid"',
        `reservation="$(port_reservation_dir "$API_PORT")"`,
        'rm -f "$rdir/ports"',
        `release_worktree_ports_if_idle "${wt}"`,
        'test ! -e "$rdir/serve.pid"',
        'test ! -e "$rdir/ports"',
        'test ! -e "$reservation"',
      ].join("\n"),
    );
    expect(r.status).toBe(0);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("assert_event_home dies when /health belongs to another checkout", () => {
  const json = JSON.stringify({
    env: { home: "/other/.factory/event-runtime" },
  });
  const r = sh(
    `assert_event_home '${json}' '/this/.factory/event-runtime' ${P(352)}`,
  );
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("refusing to seed");
  expect(r.stderr).toContain("/other/.factory/event-runtime");
});

test("assert_event_home accepts a matching env.home", () => {
  const home = "/this/.factory/event-runtime";
  const json = JSON.stringify({ env: { home } });
  const r = sh(`assert_event_home '${json}' '${home}' ${P(352)}`);
  expect(r.status).toBe(0);
});

test("assert_event_adapter requires fake unless --live", () => {
  const fake = JSON.stringify({ env: { adapter: "fake" } });
  const live = JSON.stringify({ env: {} });
  expect(sh(`assert_event_adapter '${fake}' 0 ${P(352)}`).status).toBe(0);
  expect(sh(`assert_event_adapter '${live}' 1 ${P(352)}`).status).toBe(0);
  const mismatch = sh(`assert_event_adapter '${fake}' 1 ${P(352)}`);
  expect(mismatch.status).not.toBe(0);
  expect(mismatch.stderr).toContain("--live");
});

test("adapter_banner reports the /health adapter, not the local flag", () => {
  expect(sh("adapter_banner fake").stdout).toBe(
    "(fake adapter — approvals are harmless)",
  );
  expect(sh('adapter_banner ""').stdout).toBe("(live adapters)");
  expect(sh("adapter_banner claude").stdout).toBe("(adapter claude)");
});

test("allocate_api_port returns the preferred slot when nothing answers /health", () => {
  const preferred = firstPortNotListening(P(352));
  const r = sh(`allocate_api_port ${preferred} /tmp/expected-home`);
  expect(r.status).toBe(0);
  expect(r.stdout).toBe(String(preferred));
});

test("allocate_api_port skips port occupied by another runtime", async () => {
  const heldPort = firstPortNotListening(P(360));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: heldPort,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") {
        return new Response(
          JSON.stringify({
            ok: true,
            env: { home: "/other/worktree/.factory/event-runtime" },
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const expectedPort = firstPortNotListening(heldPort + 2);
    const r = await shAsync(
      `allocate_api_port ${heldPort} /this/worktree/.factory/event-runtime`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(String(expectedPort));
  } finally {
    server.stop(true);
  }
});

test("allocate_api_port skips port squatted by an alien process that does not answer /health", async () => {
  const heldPort = firstPortNotListening(P(364));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: heldPort,
    fetch() {
      return new Response("I am an alien process", { status: 500 });
    },
  });
  try {
    const expectedPort = firstPortNotListening(heldPort + 2);
    const r = await shAsync(
      `allocate_api_port ${heldPort} /this/worktree/.factory/event-runtime`,
    );
    expect(r.status).toBe(0);
    const allocatedPort = Number(r.stdout.trim());
    expect(allocatedPort).toBeGreaterThan(heldPort);
    expect(allocatedPort).toBe(expectedPort);
    expectPortBindable(allocatedPort);
  } finally {
    server.stop(true);
  }
});

test("allocate_api_port skips port held by raw TCP listener", async () => {
  const heldPort = firstPortNotListening(P(372));
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: heldPort,
    socket: {
      data() {},
      open() {},
      close() {},
    },
  });
  try {
    const expectedPort = firstPortNotListening(heldPort + 2);
    const r = await shAsync(
      `allocate_api_port ${heldPort} /this/worktree/.factory/event-runtime`,
    );
    expect(r.status).toBe(0);
    // The skip property: allocation succeeds and lands off the held slot.
    expect(r.stdout.trim()).not.toBe(String(heldPort));
    expect(r.stdout.trim()).toBe(String(expectedPort));
  } finally {
    listener.stop(true);
  }
});

test("allocate_api_port reuses port when /health reports matching expected home", async () => {
  const home = "/this/worktree/.factory/event-runtime";
  const heldPort = firstPortNotListening(P(374));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: heldPort,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, env: { home } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const r = await shAsync(`allocate_api_port ${heldPort} '${home}'`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(String(heldPort));
  } finally {
    server.stop(true);
  }
});

test("daemon health reads the recorded API/web pair", async () => {
  const wt = mkdtempSync(path.join(tmpdir(), "wm-176-daemon-ports-"));
  const home = `${wt}/.factory/event-runtime`;
  const runDir = path.join(wt, ".factory", "run");
  mkdirSync(runDir, { recursive: true });
  for (const daemon of ["serve", "worker", "web"]) {
    writeFileSync(path.join(runDir, `${daemon}.pid`), String(process.pid));
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: P(396),
    fetch(req) {
      if (new URL(req.url).pathname === "/health") {
        return Response.json({ ok: true, env: { home } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const r = await shAsync(
      [
        `write_ports "${wt}" ${P(396)} ${P(397)}`,
        `check_daemon_health "${wt}"`,
      ].join("\n"),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `serve:   running (pid ${process.pid}, port ${P(396)})`,
    );
    expect(r.stdout).toContain(
      `web:     running (pid ${process.pid}, port ${P(397)})`,
    );
    expect(r.stdout).toContain("anomalies: none");
  } finally {
    server.stop(true);
    rmSync(wt, { recursive: true, force: true });
  }
});

test("port_listening detects active and closed ports", async () => {
  expect(sh(`port_listening ${P(396)}`).status).not.toBe(0);
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: P(396),
    socket: {
      data() {},
      open() {},
      close() {},
    },
  });
  try {
    expect(sh(`port_listening ${P(396)}`).status).toBe(0);
  } finally {
    listener.stop(true);
  }
  expect(sh(`port_listening ${P(396)}`).status).not.toBe(0);
});

test("worktree-up pushes a matching local-only ticket branch and resumes it", () => {
  const fixture = worktreeUpFixture();
  const ticket = "WM-934";
  const branch = `feat/${ticket}`;
  try {
    git(fixture.root, "switch", "-qc", branch);
    writeFileSync(path.join(fixture.root, "local-only.txt"), "local work\n");
    git(fixture.root, "add", "local-only.txt");
    git(fixture.root, "commit", "-qm", "local-only work");
    const tip = git(fixture.root, "rev-parse", branch);
    git(fixture.root, "switch", "-q", "develop");

    const result = runWorktreeUp(fixture, ticket);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `auto-pushed matching ticket branch ${branch} at ${tip}`,
    );
    expect(git(fixture.remote, "rev-parse", `refs/heads/${branch}`)).toBe(tip);
    expect(
      git(path.join(fixture.worktrees, ticket), "branch", "--show-current"),
    ).toBe(branch);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.worktrees, { recursive: true, force: true });
    rmSync(fixture.mockBin, { recursive: true, force: true });
  }
});

test("worktree-up fails closed when a matching remote branch diverged after a stale fetch", () => {
  const fixture = worktreeUpFixture();
  const ticket = "WM-935";
  const branch = `feat/${ticket}`;
  const remoteClone = mkdtempSync(path.join(tmpdir(), "wm-935-origin-work-"));
  try {
    git(fixture.root, "switch", "-qc", branch);
    writeFileSync(path.join(fixture.root, "local.txt"), "local work\n");
    git(fixture.root, "add", "local.txt");
    git(fixture.root, "commit", "-qm", "local work");
    const localTip = git(fixture.root, "rev-parse", branch);
    git(fixture.root, "update-ref", `refs/remotes/origin/${branch}`, localTip);

    git(remoteClone, "clone", "-q", fixture.remote, ".");
    git(remoteClone, "config", "user.name", "Remote test");
    git(remoteClone, "config", "user.email", "remote-test@example.test");
    git(remoteClone, "switch", "-qc", branch, "origin/develop");
    writeFileSync(path.join(remoteClone, "remote.txt"), "remote work\n");
    git(remoteClone, "add", "remote.txt");
    git(remoteClone, "commit", "-qm", "remote work");
    git(remoteClone, "push", "-q", "origin", branch);
    const remoteTip = git(remoteClone, "rev-parse", branch);

    const result = runWorktreeUp(fixture, ticket);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("worktree_branch_has_commits");
    expect(result.stderr).toContain(localTip);
    expect(result.stderr).toContain(remoteTip);
    expect(git(fixture.remote, "rev-parse", `refs/heads/${branch}`)).toBe(
      remoteTip,
    );
    expect(existsSync(path.join(fixture.worktrees, ticket))).toBe(false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.worktrees, { recursive: true, force: true });
    rmSync(fixture.mockBin, { recursive: true, force: true });
    rmSync(remoteClone, { recursive: true, force: true });
  }
});

test("ticket_number extracts numeric ID from valid ticket strings", () => {
  expect(sh("ticket_number OPS-123").stdout.trim()).toBe("123");
  expect(sh("ticket_number CLNT-456").stdout.trim()).toBe("456");
  expect(sh("ticket_number WM-1").stdout.trim()).toBe("1");
  expect(sh("ticket_number OPS-999-scratch").stdout.trim()).toBe("999");
});

test("ticket_number dies on malformed ticket inputs", () => {
  const invalidCases = ["", "123", "ops-123", "OPS_123", "NO-DASH", "OPS-"];
  for (const input of invalidCases) {
    const r = sh(`ticket_number "${input}"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ticket must look like OPS-123");
  }
});

test("ticket_normalize qualifies a bare number with the run's repo", () => {
  // The dispatch schema accepts a bare GitHub issue number (#908); qualify it
  // to owner/repo#N so ticket_is_valid, ticket_slug, and ticket_number all
  // treat it exactly like the canonical GitHub contract form.
  expect(sh("ticket_normalize 822 watt-mind/factory").stdout.trim()).toBe(
    "watt-mind/factory#822",
  );
  const id = sh("ticket_normalize 822 watt-mind/factory").stdout.trim();
  expect(sh(`ticket_is_valid "${id}"`).status).toBe(0);
  expect(sh(`ticket_slug "${id}"`).stdout.trim()).toBe("gh-822");
  expect(sh(`ticket_number "${id}"`).stdout.trim()).toBe("822");
});

test("ticket_normalize leaves non-bare and unqualifiable ids untouched", () => {
  // Linear keys and already-qualified GitHub forms pass through verbatim, so
  // normalization never disturbs the existing id space.
  expect(sh("ticket_normalize OPS-123 watt-mind/factory").stdout.trim()).toBe(
    "OPS-123",
  );
  expect(
    sh("ticket_normalize watt-mind/factory#7 watt-mind/factory").stdout.trim(),
  ).toBe("watt-mind/factory#7");
  expect(sh("ticket_normalize '#7' watt-mind/factory").stdout.trim()).toBe(
    "#7",
  );
  // A bare number with no repo to qualify against is left as-is, so it still
  // fails validation rather than being silently invented into a ticket.
  const bare = sh('ticket_normalize 822 ""').stdout.trim();
  expect(bare).toBe("822");
  expect(sh(`ticket_is_valid "${bare}"`).status).not.toBe(0);
});

test("github_repo_slug prefers FACTORY_GITHUB_REPO and parses github remotes", () => {
  expect(
    sh("github_repo_slug", {
      FACTORY_GITHUB_REPO: "acme/widgets",
    }).stdout.trim(),
  ).toBe("acme/widgets");

  const withRemote = (url) => {
    const repo = mkdtempSync(path.join(tmpdir(), "wm-908-remote-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["remote", "add", "origin", url], { cwd: repo });
      // Empty FACTORY_GITHUB_REPO so the override does not shadow the remote.
      return sh(`github_repo_slug "${repo}"`, {
        FACTORY_GITHUB_REPO: "",
      }).stdout.trim();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  };
  expect(withRemote("https://github.com/watt-mind/factory.git")).toBe(
    "watt-mind/factory",
  );
  expect(withRemote("git@github.com:watt-mind/factory.git")).toBe(
    "watt-mind/factory",
  );
  // A non-GitHub remote yields nothing — there is no repo to qualify against.
  expect(withRemote("https://gitlab.com/watt-mind/factory.git")).toBe("");
});

test("web_build_hash computes deterministic sha1 and changes on file rename or content edit", () => {
  const mockWebDir = mkdtempSync(path.join(tmpdir(), "mock-web-build-"));
  try {
    const srcDir = path.join(mockWebDir, "src");
    const componentsDir = path.join(srcDir, "components");
    const publicDir = path.join(mockWebDir, "public");
    mkdirSync(componentsDir, { recursive: true });
    mkdirSync(publicDir, { recursive: true });

    writeFileSync(
      path.join(mockWebDir, "package.json"),
      JSON.stringify({ name: "mock-web" }),
    );
    writeFileSync(path.join(mockWebDir, "bun.lock"), "lockfile-v1");
    writeFileSync(
      path.join(mockWebDir, "vite.config.ts"),
      "export default {};",
    );
    writeFileSync(path.join(mockWebDir, "tsconfig.json"), "{}");
    writeFileSync(
      path.join(mockWebDir, "index.html"),
      "<!DOCTYPE html><html></html>",
    );
    writeFileSync(path.join(srcDir, "main.ts"), "console.log('init');");
    writeFileSync(
      path.join(componentsDir, "Button.vue"),
      "<template><button>OK</button></template>",
    );
    writeFileSync(path.join(publicDir, "favicon.ico"), "binary-icon-content");

    const initial = sh(`web_build_hash "${mockWebDir}"`);
    expect(initial.status).toBe(0);
    const initialHash = initial.stdout.trim();
    expect(initialHash).toMatch(/^[0-9a-f]{40}$/);

    // Identical hash on untouched directory
    const repeat = sh(`web_build_hash "${mockWebDir}"`);
    expect(repeat.stdout.trim()).toBe(initialHash);

    // 1. Content edit in src/
    writeFileSync(path.join(srcDir, "main.ts"), "console.log('updated');");
    const edited = sh(`web_build_hash "${mockWebDir}"`);
    expect(edited.stdout.trim()).not.toBe(initialHash);

    // Revert content edit -> restores initial hash
    writeFileSync(path.join(srcDir, "main.ts"), "console.log('init');");
    expect(sh(`web_build_hash "${mockWebDir}"`).stdout.trim()).toBe(
      initialHash,
    );

    // 2. File rename in src/components/
    const oldBtn = path.join(componentsDir, "Button.vue");
    const newBtn = path.join(componentsDir, "Btn.vue");
    renameSync(oldBtn, newBtn);
    const renamed = sh(`web_build_hash "${mockWebDir}"`);
    expect(renamed.stdout.trim()).not.toBe(initialHash);

    // Revert rename -> restores initial hash
    renameSync(newBtn, oldBtn);
    expect(sh(`web_build_hash "${mockWebDir}"`).stdout.trim()).toBe(
      initialHash,
    );

    // 3. Edit root config files
    writeFileSync(
      path.join(mockWebDir, "package.json"),
      JSON.stringify({ name: "mock-web-2" }),
    );
    expect(sh(`web_build_hash "${mockWebDir}"`).stdout.trim()).not.toBe(
      initialHash,
    );
  } finally {
    rmSync(mockWebDir, { recursive: true, force: true });
  }
});
