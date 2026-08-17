import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

const COMMON = path.resolve(import.meta.dir, "worktree-common.sh");

// Private port band for this test run (WM-113). Fixed in-band ports (7752,
// 7772, …) collide with real runtimes, leftover servers, and concurrent CI
// jobs — EADDRINUSE before the assertion even runs. Instead, probe random
// even bases in the ephemeral-ish 20000–60000 range until every offset the
// fixtures bind is free, and pass the band to the scripts via
// FACTORY_PORT_BASE / FACTORY_PORT_SPAN. No absolute ports below.
const PORT_SPAN = 200;
const FIXTURE_OFFSETS = [352, 353, 360, 361, 362, 363, 364, 365, 366, 367, 372, 373, 374, 375, 396, 397];

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
const P = (offset) => PORT_BASE + offset;
const BAND_ENV = {
  FACTORY_PORT_BASE: String(PORT_BASE),
  FACTORY_PORT_SPAN: String(PORT_SPAN),
};

function sh(body, extraEnv = {}) {
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", `source "${COMMON}"\n${body}`],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...BAND_ENV, ...extraEnv },
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function shAsync(body, extraEnv = {}) {
  const proc = Bun.spawn(["bash", "-c", `source "${COMMON}"\n${body}`], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...BAND_ENV, ...extraEnv },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const status = await proc.exited;
  return { status, stdout, stderr };
}

function mockLsofDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "wm-473-lsof-"));
  const executable = path.join(dir, "lsof");
  writeFileSync(executable, `#!/usr/bin/env bash
pid=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-p" ]]; then pid="$2"; shift 2; else shift; fi
done
pid="\${MOCK_LSOF_PID:-$pid}"
printf '%s\\n' 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME'
printf 'mock %s user 1u IPv4 0 0t0 TCP 127.0.0.1:%s (LISTEN)\\n' "$pid" "$MOCK_LSOF_PORT"
`);
  chmodSync(executable, 0o755);
  return dir;
}


test("ticket_api_port hashes the full id so N and N+200 do not share a slot", () => {
  const a = sh('ticket_api_port OPS-201');
  const b = sh('ticket_api_port OPS-401');
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
  const a = sh('ticket_api_port OPS-123');
  const b = sh('ticket_api_port OPS-123-scratch');
  expect(a.status).toBe(0);
  expect(b.status).toBe(0);
  expect(a.stdout).not.toBe(b.stdout);
});

test("write_ports / read_ports round-trip", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "ops-460-ports-"));
  try {
    const written = sh(`write_ports "${wt}" ${P(352)} ${P(353)}\nread_ports "${wt}"`);
    expect(written.status).toBe(0);
    expect(written.stdout.trim()).toBe(`${P(352)} ${P(353)}`);
  } finally {
    rmSync(wt, { recursive: true, force: true });
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
      PATH: `${dir}:${process.env.PATH}`,
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
    const r = sh(`printf '%s\\n' $$ > "${pidfile}"\nlisten_tcp_port "${pidfile}"`, {
      PATH: `${dir}:${process.env.PATH}`,
      MOCK_LSOF_PORT: String(PORT_BASE + 2 * PORT_SPAN),
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve_worktree_ports reuses free recorded ports for --here", () => {
  const wt = mkdtempSync(path.join(tmpdir(), "wm-176-recorded-"));
  try {
    const r = sh([
      `write_ports "${wt}" ${P(352)} ${P(353)}`,
      `resolve_worktree_ports "${wt}" ${P(360)} "${wt}/.factory/event-runtime"`,
      'printf "resolved=%s %s\\n" "$API_PORT" "$WEB_PORT"',
      `printf "recorded=%s\\n" "$(read_ports "${wt}")"`,
    ].join("\n"));
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
        return Response.json({ ok: true, env: { home: "/other/checkout/.factory/event-runtime" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const r = await shAsync([
      `resolve_worktree_ports "${wt}" ${preferred} "${wt}/.factory/event-runtime"`,
      'printf "resolved=%s %s\\n" "$API_PORT" "$WEB_PORT"',
      `printf "recorded=%s\\n" "$(read_ports "${wt}")"`,
    ].join("\n"));
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
    const r = await shAsync([
      `resolve_worktree_ports "${wt}" ${preferred} "${wt}/.factory/event-runtime"`,
      'printf "resolved=%s %s\\n" "$API_PORT" "$WEB_PORT"',
    ].join("\n"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`resolved=${P(362)} ${P(363)}`);
  } finally {
    listener.stop(true);
    rmSync(wt, { recursive: true, force: true });
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
    const r = await shAsync([
      `write_ports "${wt}" ${P(364)} ${P(365)}`,
      `resolve_worktree_ports "${wt}" ${P(372)} "${wt}/.factory/event-runtime"`,
      'printf "resolved=%s %s\\n" "$API_PORT" "$WEB_PORT"',
      `printf "recorded=%s\\n" "$(read_ports "${wt}")"`,
    ].join("\n"));
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
    const r = await shAsync([
      `write_ports "${wt}" ${api} ${P(375)}`,
      `resolve_worktree_ports "${wt}" ${P(360)} "${home}"`,
      'printf "resolved=%s %s\\n" "$API_PORT" "$WEB_PORT"',
    ].join("\n"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`resolved=${api} ${P(375)}`);
  } finally {
    server.stop(true);
    rmSync(wt, { recursive: true, force: true });
  }
});

test("assert_event_home dies when /health belongs to another checkout", () => {
  const json = JSON.stringify({ env: { home: "/other/.factory/event-runtime" } });
  const r = sh(`assert_event_home '${json}' '/this/.factory/event-runtime' ${P(352)}`);
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
  expect(sh('adapter_banner fake').stdout).toBe("(fake adapter — approvals are harmless)");
  expect(sh('adapter_banner ""').stdout).toBe("(live adapters)");
  expect(sh('adapter_banner claude').stdout).toBe("(adapter claude)");
});

test("allocate_api_port returns the preferred slot when nothing answers /health", () => {
  const r = sh(`allocate_api_port ${P(352)} /tmp/expected-home`);
  expect(r.status).toBe(0);
  expect(r.stdout).toBe(String(P(352)));
});

test("allocate_api_port skips port occupied by another runtime", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: P(360),
    fetch(req) {
      if (new URL(req.url).pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, env: { home: "/other/worktree/.factory/event-runtime" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const r = await shAsync(`allocate_api_port ${P(360)} /this/worktree/.factory/event-runtime`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(String(P(362)));
  } finally {
    server.stop(true);
  }
});

test("allocate_api_port skips port squatted by an alien process that does not answer /health", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: P(364),
    fetch() {
      return new Response("I am an alien process", { status: 500 });
    },
  });
  try {
    const r = await shAsync(`allocate_api_port ${P(364)} /this/worktree/.factory/event-runtime`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(String(P(366)));
  } finally {
    server.stop(true);
  }
});

test("allocate_api_port skips port held by raw TCP listener", async () => {
  const heldPort = P(372);
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
    const r = await shAsync(`allocate_api_port ${heldPort} /this/worktree/.factory/event-runtime`);
    expect(r.status).toBe(0);
    // The skip property: allocation succeeds and lands off the held slot.
    expect(r.stdout.trim()).not.toBe(String(heldPort));
    expect(r.stdout.trim()).toBe(String(P(374)));
  } finally {
    listener.stop(true);
  }
});

test("allocate_api_port reuses port when /health reports matching expected home", async () => {
  const home = "/this/worktree/.factory/event-runtime";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: P(374),
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
    const r = await shAsync(`allocate_api_port ${P(374)} '${home}'`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(String(P(374)));
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
    const r = await shAsync([
      `write_ports "${wt}" ${P(396)} ${P(397)}`,
      `check_daemon_health "${wt}"`,
    ].join("\n"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`serve:   running (pid ${process.pid}, port ${P(396)})`);
    expect(r.stdout).toContain(`web:     running (pid ${process.pid}, port ${P(397)})`);
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

test("ticket_number extracts numeric ID from valid ticket strings", () => {
  expect(sh('ticket_number OPS-123').stdout.trim()).toBe("123");
  expect(sh('ticket_number CLNT-456').stdout.trim()).toBe("456");
  expect(sh('ticket_number WM-1').stdout.trim()).toBe("1");
  expect(sh('ticket_number OPS-999-scratch').stdout.trim()).toBe("999");
});

test("ticket_number dies on malformed ticket inputs", () => {
  const invalidCases = ["", "123", "ops-123", "OPS_123", "NO-DASH", "OPS-"];
  for (const input of invalidCases) {
    const r = sh(`ticket_number "${input}"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ticket must look like OPS-123");
  }
});

test("web_build_hash computes deterministic sha1 and changes on file rename or content edit", () => {
  const mockWebDir = mkdtempSync(path.join(tmpdir(), "mock-web-build-"));
  try {
    const srcDir = path.join(mockWebDir, "src");
    const componentsDir = path.join(srcDir, "components");
    const publicDir = path.join(mockWebDir, "public");
    mkdirSync(componentsDir, { recursive: true });
    mkdirSync(publicDir, { recursive: true });

    writeFileSync(path.join(mockWebDir, "package.json"), JSON.stringify({ name: "mock-web" }));
    writeFileSync(path.join(mockWebDir, "bun.lock"), "lockfile-v1");
    writeFileSync(path.join(mockWebDir, "vite.config.ts"), "export default {};");
    writeFileSync(path.join(mockWebDir, "tsconfig.json"), "{}");
    writeFileSync(path.join(mockWebDir, "index.html"), "<!DOCTYPE html><html></html>");
    writeFileSync(path.join(srcDir, "main.ts"), "console.log('init');");
    writeFileSync(path.join(componentsDir, "Button.vue"), "<template><button>OK</button></template>");
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
    expect(sh(`web_build_hash "${mockWebDir}"`).stdout.trim()).toBe(initialHash);

    // 2. File rename in src/components/
    const oldBtn = path.join(componentsDir, "Button.vue");
    const newBtn = path.join(componentsDir, "Btn.vue");
    renameSync(oldBtn, newBtn);
    const renamed = sh(`web_build_hash "${mockWebDir}"`);
    expect(renamed.stdout.trim()).not.toBe(initialHash);

    // Revert rename -> restores initial hash
    renameSync(newBtn, oldBtn);
    expect(sh(`web_build_hash "${mockWebDir}"`).stdout.trim()).toBe(initialHash);

    // 3. Edit root config files
    writeFileSync(path.join(mockWebDir, "package.json"), JSON.stringify({ name: "mock-web-2" }));
    expect(sh(`web_build_hash "${mockWebDir}"`).stdout.trim()).not.toBe(initialHash);
  } finally {
    rmSync(mockWebDir, { recursive: true, force: true });
  }
});


