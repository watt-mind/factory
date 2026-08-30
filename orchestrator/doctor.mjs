#!/usr/bin/env bun
/**
 * Is this machine ready to run the loop for a repo?
 *
 *   bun orchestrator/doctor.mjs              # every configured repo
 *   bun orchestrator/doctor.mjs --repo bj29
 *
 * The factory does NOT clone target repos. The main checkout is yours — you
 * work in it, it holds your uncommitted changes, and cloning a private repo
 * needs your credentials. Factory owns the control plane; you own the
 * checkouts. What it owes you is a clear answer to "why isn't this repo
 * working", which is this.
 *
 * Read-only. Every failure names the fix.
 */
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  lstatSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { factoryRoot } from "../lib/factory-root.mjs";
import {
  controlPlaneKindFromPolicy,
  loadControlPlane,
} from "../lib/control-plane/index.mjs";
import { harnessGitignoreIsCurrent } from "../lib/factory-gitignore.mjs";
import {
  normalizeToolchain,
  preflightToolchain,
  reposRoot,
} from "../event-runtime/lib/repos.mjs";
import {
  CHAIN_AUTO_APPROVAL_EVENT_TYPES,
  loadChainAutoApprovalPolicy,
} from "../event-runtime/lib/auto-approval.mjs";
import {
  browserLaunchCheck,
  piChromeDevtoolsCheck,
} from "./doctor-browser.mjs";
import {
  formatLinearBudgetLine,
  installLinearBudgetCapture,
  linearBudgetStatus,
  loadLinearBudget,
} from "../tools/linear.mjs";

export const MIN_BUN_VERSION = "1.1.0";
export const MIN_GIT_VERSION = "2.40.0";

/** Extract the numeric component from ordinary CLI version output. */
export function parseCliVersion(output) {
  const match = String(output ?? "").match(/\b(\d+)\.(\d+)(?:\.(\d+))?/);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
    : null;
}

/** Returns -1, 0, or 1, and null when either version is not parseable. */
export function compareCliVersions(actual, minimum) {
  const a = Array.isArray(actual) ? actual : parseCliVersion(actual);
  const b = Array.isArray(minimum) ? minimum : parseCliVersion(minimum);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

const commandResult = (result) => ({
  status: result?.status ?? 1,
  stdout: String(result?.stdout ?? "").trim(),
  stderr: String(result?.stderr ?? "").trim(),
});

/**
 * OSS prerequisites are kept pure so the doctor can be tested without querying
 * Linear, fetching a checkout, or depending on the machine running the tests.
 * `run` accepts a shell command and returns spawnSync-shaped output.
 */
export function ossOnboardingDiagnostics({
  run,
  env = process.env,
  controlPlaneKind = "linear",
  linearConfigured = Boolean(env.LINEAR_API_KEY),
} = {}) {
  if (typeof run !== "function") throw new TypeError("run must be a function");
  const execute = (command) => commandResult(run(command));
  const diagnostics = [];
  const version = (label, command, minimum, fix) => {
    const result = execute(command);
    const actual = parseCliVersion(result.stdout);
    const comparison = compareCliVersions(actual, minimum);
    diagnostics.push({
      ok: result.status === 0 && comparison !== null && comparison >= 0,
      label,
      detail:
        result.status !== 0
          ? result.stderr || "not installed"
          : comparison === null
            ? `unrecognised version: ${result.stdout || "no output"}`
            : `${result.stdout || actual.join(".")} (requires >= ${minimum})`,
      fix:
        result.status !== 0
          ? fix
          : comparison === null || comparison < 0
            ? `upgrade to ${label} >= ${minimum}; ${fix}`
            : null,
    });
  };

  version(
    "bun",
    "bun --version",
    MIN_BUN_VERSION,
    "https://bun.sh/docs/installation",
  );
  version(
    "git",
    "git --version",
    MIN_GIT_VERSION,
    "https://git-scm.com/downloads",
  );

  const ghVersion = execute("gh --version");
  const ghInstalled = ghVersion.status === 0;
  diagnostics.push({
    ok: ghInstalled,
    label: "gh CLI",
    detail: ghInstalled
      ? ghVersion.stdout.split("\n")[0]
      : ghVersion.stderr || "not installed",
    fix: ghInstalled ? null : "install gh: https://cli.github.com/",
  });

  const ghAuth = ghInstalled ? execute("gh auth status") : null;
  diagnostics.push({
    ok: Boolean(ghAuth && ghAuth.status === 0),
    label: "GitHub authentication",
    detail: !ghInstalled
      ? "gh is not installed"
      : ghAuth.status === 0
        ? (ghAuth.stdout || ghAuth.stderr).split("\n")[0]
        : ghAuth.stderr || ghAuth.stdout || "not authenticated",
    fix: ghAuth?.status === 0 ? null : "run `gh auth login -h github.com`",
  });

  if (controlPlaneKind === "linear") {
    diagnostics.push({
      ok: Boolean(linearConfigured),
      label: "Linear control plane",
      detail: linearConfigured
        ? "LINEAR_API_KEY configured; team/project connectivity is checked below"
        : "LINEAR_API_KEY is not configured",
      fix: linearConfigured
        ? null
        : "set LINEAR_API_KEY in the environment or your factory .env file",
    });
  } else {
    diagnostics.push({
      ok: Boolean(ghAuth && ghAuth.status === 0),
      label: "GitHub control plane",
      detail:
        ghAuth?.status === 0
          ? "gh authenticated; repository access is checked while fetching each checkout"
          : "GitHub token unavailable",
      fix:
        ghAuth?.status === 0
          ? null
          : "run `gh auth login -h github.com` and grant repository access",
    });
  }

  const harnesses = ["claude", "codex", "gemini", "cursor", "pi"];
  for (const harness of harnesses) {
    const result = execute(`${harness} --version`);
    diagnostics.push({
      ok: result.status === 0 ? true : "warn",
      label: `harness: ${harness}`,
      detail:
        result.status === 0 ? result.stdout.split("\n")[0] : "not installed",
      fix:
        result.status === 0
          ? null
          : `install ${harness} to dispatch with that harness`,
    });
  }

  const docker = execute("docker info --format '{{.ServerVersion}}'");
  const colima = execute("colima status");
  const microvm = execute(
    "command -v tart || command -v vfkit || command -v limactl",
  );
  const isolation =
    docker.status === 0
      ? `Docker engine ${docker.stdout}`
      : colima.status === 0
        ? `Colima ${colima.stdout}`
        : microvm.status === 0
          ? `MicroVM runtime ${microvm.stdout}`
          : null;
  diagnostics.push({
    ok: isolation ? true : "warn",
    label: "worktree isolation",
    detail: isolation ?? "Docker, Colima, and MicroVM runtimes are unavailable",
    fix: isolation
      ? null
      : "install and start Docker Desktop, Colima, or a supported MicroVM runtime before using isolated worktrees",
  });

  return diagnostics;
}

/**
 * Per-repo toolchain status for `factory doctor` (WM-316 / #1097).
 *
 * Pure except for the injectable `which`/`spawn` probes — the same
 * injection `preflightToolchain` uses — so doctor.test.mjs can cover
 * pass, mismatch, and the undeclared no-block case without touching the
 * host. Repos may be raw YAML entries (map-form `toolchain:`) or
 * `loadRepos()` records; the helper always normalizes first so iterating a
 * map cannot throw, and a malformed block becomes a red `toolchain` check
 * instead of an exception.
 */
export async function repoToolchainDiagnostics({
  repos = [],
  file = "config/repos.yaml",
  node = "local",
  which,
  spawn,
} = {}) {
  const diagnostics = [];
  const preflightOpts = { node };
  if (typeof which === "function") preflightOpts.which = which;
  if (typeof spawn === "function") preflightOpts.spawn = spawn;

  for (const repo of repos) {
    // A malformed `toolchain:` block is itself the diagnosis — surface it as
    // a red check and keep going rather than letting the RepoError kill
    // doctor with a stack trace before the remaining repos are examined.
    let toolchain;
    try {
      toolchain = normalizeToolchain(repo?.toolchain, repo?.name, file);
    } catch (err) {
      diagnostics.push({
        ok: false,
        label: "toolchain",
        detail: err?.message ?? String(err),
        fix: `fix the toolchain: block for ${repo?.name ?? "this repo"} in ${file}`,
      });
      continue;
    }
    if (!toolchain?.length) continue;
    const attestation = await preflightToolchain(
      { ...repo, toolchain },
      preflightOpts,
    );
    for (const tool of attestation.tools) {
      const reason = attestation.reasons.find(
        (r) => r.executable === tool.executable,
      );
      const observed = tool.observed ?? tool.observedRaw ?? null;
      diagnostics.push({
        ok: tool.satisfied,
        label: `toolchain ${tool.executable}`,
        detail: observed
          ? `${tool.constraint}  observed ${observed}`
          : `${tool.constraint}  missing`,
        fix: reason?.action ?? null,
      });
    }
  }
  return diagnostics;
}

const CHAIN_POLICY_FIX =
  "compare config/policy.yaml chain_auto_approval.allowed_event_types with CHAIN_AUTO_APPROVAL_EVENT_TYPES";

function chainPolicySource(root) {
  const local = path.join(root, "config", "policy.yaml");
  if (existsSync(local)) return local;
  const example = path.join(root, "config", "policy.example.yaml");
  return existsSync(example) ? example : local;
}

function invalidAllowedEventTypesDetail(root) {
  try {
    const allowed = Bun.YAML.parse(
      readFileSync(chainPolicySource(root), "utf8"),
    )?.chain_auto_approval?.allowed_event_types;
    if (!Array.isArray(allowed)) {
      return "chain_auto_approval.allowed_event_types must be an array of strings";
    }
    if (!allowed.every((eventType) => typeof eventType === "string")) {
      return "chain_auto_approval.allowed_event_types contains non-string entries";
    }
  } catch {
    return "config/policy.yaml is not valid YAML";
  }
  return "chain_auto_approval.allowed_event_types is invalid";
}

function forbiddenAllowedEventTypes(root) {
  try {
    const allowed = Bun.YAML.parse(
      readFileSync(chainPolicySource(root), "utf8"),
    )?.chain_auto_approval?.allowed_event_types;
    return Array.isArray(allowed)
      ? allowed.filter(
          (eventType) =>
            typeof eventType === "string" &&
            !CHAIN_AUTO_APPROVAL_EVENT_TYPES.has(eventType),
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Diagnose the instance policy through the runtime's authoritative loader.
 * Defaults to `reposRoot()` (FACTORY_REPOS_ROOT || FACTORY_ROOT) — the same
 * resolution `loadChainAutoApprovalPolicy()` uses in serve — so the doctor
 * validates the config/policy.yaml the runtime actually reads.
 */
export function chainAutoApprovalPolicyDiagnostic({ root = reposRoot() } = {}) {
  const policy = loadChainAutoApprovalPolicy({ root });
  const label = "chain auto-approval policy";
  if (policy.reason === null) {
    const allowed = [...policy.allowed].sort();
    return {
      ok: true,
      label,
      detail:
        `ok (${allowed.length} allowed event type${allowed.length === 1 ? "" : "s"}: ${allowed.join(", ")}; ` +
        `merge max_fix_rounds=${policy.maxFixRounds}, batch_size=${policy.mergeBatchSize}; ` +
        `escalation auto_merge_base=${[...policy.autoMergeBase].join(",") || "none"}, ` +
        `auto_merge_owners=${[...policy.autoMergeOwners].join(",") || "none"})`,
      fix: null,
    };
  }
  if (policy.reason === "policy_missing") {
    return {
      ok: "warn",
      label,
      detail: "policy_missing — every chain proposal is watched",
      fix: "add config/policy.yaml chain_auto_approval.allowed_event_types to opt into safe chain approvals",
    };
  }
  if (String(policy.reason ?? "").startsWith("policy_invalid")) {
    // The loader appends a clipped parse-error message to the reason
    // (`policy_invalid:<message>`, GH-1901); match the prefix so a YAML
    // syntax error still reports as the policy failure it is.
    const [, loaderDetail] = String(policy.reason).split(/:(.*)/s);
    return {
      ok: false,
      label,
      detail: `policy_invalid — ${loaderDetail?.trim() || invalidAllowedEventTypesDetail(root)}`,
      fix: CHAIN_POLICY_FIX,
    };
  }
  if (policy.reason === "policy_contains_forbidden_event") {
    const offending = forbiddenAllowedEventTypes(root);
    return {
      ok: false,
      label,
      detail: `policy_contains_forbidden_event — offending entries: ${offending.join(", ") || "unreadable"}`,
      fix: CHAIN_POLICY_FIX,
    };
  }
  return {
    ok: false,
    label,
    detail:
      "merge_policy_invalid — merge.max_fix_rounds and escalation.auto_merge_base/auto_merge_owners must be valid when merge events are allowed",
    fix: "repair merge.max_fix_rounds and escalation.auto_merge_base/auto_merge_owners in config/policy.yaml",
  };
}

const GH_APP_DAEMON =
  /(?:^|[\s/])gh-app-auth\.mjs(?=\s|$).*?(?:^|\s)--daemon(?:\s|$)/;
const SERVE_ENTRYPOINT =
  /event-runtime\/cli\.mjs(?=\s|$).*?(?:^|\s)serve(?:\s|$)/;

function defaultProcessTable() {
  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return {
      ok: false,
      detail: String(result.stderr ?? "unable to inspect process table").trim(),
      processes: [],
    };
  }
  return {
    ok: true,
    processes: String(result.stdout ?? "")
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
      .filter(Boolean)
      .map(([, pid, command]) => ({ pid: Number(pid), command })),
  };
}

function defaultProcessProbe(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return { alive: false };
    if (error?.code !== "EPERM") {
      return { alive: false, detail: error?.message ?? String(error) };
    }
  }

  try {
    return {
      alive: true,
      command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll(
        "\0",
        " ",
      ),
    };
  } catch {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    return {
      alive: true,
      command: String(result.stdout ?? "").trim(),
    };
  }
}

/**
 * Reports the two daemons that make a local factory stack usable. Process and
 * pidfile probes are injectable so a test never has to manufacture a real
 * daemon or rely on the host's /proc implementation.
 */
export function stackDaemonDiagnostics({
  env = process.env,
  runDir = env.FACTORY_RUN_DIR || path.join(homedir(), ".factory", "run"),
  root = factoryRoot(),
  listProcesses = defaultProcessTable,
  readPidFile = (file) => readFileSync(file, "utf8"),
  probeProcess = defaultProcessProbe,
} = {}) {
  const appConfigured = Boolean(
    env.FACTORY_GH_APP_ID &&
    env.FACTORY_GH_APP_INSTALLATION_ID &&
    env.FACTORY_GH_APP_PRIVATE_KEY_PATH,
  );
  const diagnostics = [];

  let table;
  try {
    table = listProcesses();
  } catch (error) {
    table = {
      ok: false,
      detail: error?.message ?? String(error),
      processes: [],
    };
  }
  const processes = Array.isArray(table) ? table : (table?.processes ?? []);
  const processTableOk = Array.isArray(table) || table?.ok !== false;
  const ghAppEntrypoint = path.join(
    path.resolve(root),
    "lib",
    "control-plane",
    "gh-app-auth.mjs",
  );
  const isThisStackGhAppDaemon = (command) => {
    const value = String(command ?? "");
    return GH_APP_DAEMON.test(value) && value.includes(ghAppEntrypoint);
  };
  const ghAppDaemons = processes.filter(({ command }) =>
    isThisStackGhAppDaemon(command),
  );
  if (!processTableOk) {
    diagnostics.push({
      ok: appConfigured ? false : "warn",
      label: "gh-app-auth daemon",
      detail: `cannot inspect process table${table?.detail ? ` — ${table.detail}` : ""}`,
      fix: "restore process-table access, then run `factory doctor` again",
    });
  } else if (ghAppDaemons.length > 1) {
    diagnostics.push({
      ok: false,
      label: "gh-app-auth daemon",
      detail: `duplicate daemons — found ${ghAppDaemons.length} (${ghAppDaemons.map(({ pid }) => pid).join(", ")})`,
      fix: "stop duplicate gh-app-auth.mjs --daemon processes, leaving exactly one",
    });
  } else {
    const ghAppPidFile = path.join(runDir, "gh-app-auth.pid");
    let pidText = null;
    try {
      pidText = readPidFile(ghAppPidFile);
    } catch (error) {
      if (error?.code === "ENOENT") {
        diagnostics.push({
          ok: appConfigured ? false : "warn",
          label: "gh-app-auth daemon",
          detail: appConfigured
            ? "GitHub App auth is configured but no daemon is running"
            : "not applicable — GitHub App auth is not configured",
          fix: appConfigured
            ? "run `factory up` to start gh-app-auth.mjs --daemon"
            : null,
        });
      } else {
        diagnostics.push({
          ok: false,
          label: "gh-app-auth daemon",
          detail: `cannot read ${ghAppPidFile} — ${error?.message ?? String(error)}`,
          fix: "repair or remove the unreadable gh-app-auth.pid, then run `factory up`",
        });
      }
    }

    if (pidText !== null) {
      const pid = Number(String(pidText).trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        diagnostics.push({
          ok: false,
          label: "gh-app-auth daemon",
          detail: `stale gh-app-auth.pid — invalid PID ${JSON.stringify(String(pidText).trim())}`,
          fix: "remove the stale gh-app-auth.pid and run `factory up`",
        });
      } else {
        let probe;
        try {
          probe = probeProcess(pid);
        } catch (error) {
          probe = { alive: false, detail: error?.message ?? String(error) };
        }
        if (!probe?.alive) {
          diagnostics.push({
            ok: false,
            label: "gh-app-auth daemon",
            detail: `stale gh-app-auth.pid — PID ${pid} is not running${probe?.detail ? ` (${probe.detail})` : ""}`,
            fix: "remove the stale gh-app-auth.pid and run `factory up`",
          });
        } else if (!isThisStackGhAppDaemon(probe.command)) {
          diagnostics.push({
            ok: false,
            label: "gh-app-auth daemon",
            detail: `recycled gh-app-auth.pid — PID ${pid} belongs to ${probe.command || "an unidentifiable process"}`,
            fix: "remove the recycled gh-app-auth.pid and run `factory up`",
          });
        } else {
          diagnostics.push({
            ok: true,
            label: "gh-app-auth daemon",
            detail: `one daemon running (pid ${pid})`,
            fix: null,
          });
        }
      }
    }
  }

  const servePidFile = path.join(runDir, "serve.pid");
  let pidText;
  try {
    pidText = readPidFile(servePidFile);
  } catch (error) {
    if (error?.code === "ENOENT") {
      diagnostics.push({
        ok: "warn",
        label: "serve.pid identity",
        detail:
          "not applicable — no serve.pid; stack is not running on this machine",
        fix: null,
      });
      return diagnostics;
    }
    diagnostics.push({
      ok: false,
      label: "serve.pid identity",
      detail: `cannot read ${servePidFile} — ${error?.message ?? String(error)}`,
      fix: "repair or remove the unreadable serve.pid, then run `factory up`",
    });
    return diagnostics;
  }

  const pid = Number(String(pidText).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    diagnostics.push({
      ok: false,
      label: "serve.pid identity",
      detail: `stale serve.pid — invalid PID ${JSON.stringify(String(pidText).trim())}`,
      fix: "remove the stale serve.pid and run `factory up`",
    });
    return diagnostics;
  }

  let probe;
  try {
    probe = probeProcess(pid);
  } catch (error) {
    probe = { alive: false, detail: error?.message ?? String(error) };
  }
  if (!probe?.alive) {
    diagnostics.push({
      ok: false,
      label: "serve.pid identity",
      detail: `stale serve.pid — PID ${pid} is not running${probe?.detail ? ` (${probe.detail})` : ""}`,
      fix: "remove the stale serve.pid and run `factory up`",
    });
  } else if (!SERVE_ENTRYPOINT.test(String(probe.command ?? ""))) {
    diagnostics.push({
      ok: false,
      label: "serve.pid identity",
      detail: `recycled serve.pid — PID ${pid} belongs to ${probe.command || "an unidentifiable process"}`,
      fix: "remove the recycled serve.pid and run `factory up`",
    });
  } else {
    diagnostics.push({
      ok: true,
      label: "serve.pid identity",
      detail: `PID ${pid} is event-runtime/cli.mjs serve`,
      fix: null,
    });
  }
  return diagnostics;
}

const ROOT = factoryRoot();
installLinearBudgetCapture();
const argv = process.argv.slice(2);
const val = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};
const only = (val("--repo") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const expand = (p) => String(p ?? "").replace(/^~/, homedir());
const cfg = Bun.YAML.parse(
  readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"),
);
const repos = (cfg.repos ?? []).filter(
  (r) => !only.length || only.includes(r.name),
);

// Commits behind origin/<base> before the main checkout is worth flagging.
const BEHIND_WARN = 10;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

let failures = 0;
const check = (ok, label, detail, fix) => {
  if (ok === "warn") {
    console.log(
      `  ${c.yellow("!")} ${label}${detail ? c.dim("  " + detail) : ""}`,
    );
    if (fix) console.log(`      ${c.dim(fix)}`);
    return;
  }
  console.log(
    `  ${ok ? c.green("✓") : c.red("✗")} ${label}${detail ? c.dim("  " + detail) : ""}`,
  );
  if (!ok) {
    failures++;
    if (fix) console.log(`      ${c.bold("fix:")} ${fix}`);
  }
};

const sh = (cmd, cwd) =>
  spawnSync("/bin/bash", ["-lc", cmd], { cwd, encoding: "utf8" });

if (import.meta.main) {
  // ------------------------------------------------------------------ machine ---
  console.log(c.bold("\nmachine"));
  const controlPlaneKind = controlPlaneKindFromPolicy(ROOT);
  const key =
    process.env.LINEAR_API_KEY ||
    (existsSync(expand("~/Develop/hdkiller/.env")) &&
      /LINEAR_API_KEY/.test(
        readFileSync(expand("~/Develop/hdkiller/.env"), "utf8"),
      ));
  for (const diagnostic of ossOnboardingDiagnostics({
    run: sh,
    controlPlaneKind,
    linearConfigured: Boolean(key),
  })) {
    check(diagnostic.ok, diagnostic.label, diagnostic.detail, diagnostic.fix);
  }

  for (const diagnostic of stackDaemonDiagnostics()) {
    check(diagnostic.ok, diagnostic.label, diagnostic.detail, diagnostic.fix);
  }

  const factoryBin = sh("command -v factory");
  const factoryScript = path.join(ROOT, "bin/factory");
  check(
    factoryBin.status === 0,
    "factory CLI on PATH",
    factoryBin.stdout.trim(),
    "bun build/emit.mjs --link-bin && ensure ~/.local/bin is on PATH",
  );
  check(
    existsSync(factoryScript),
    "bin/factory in checkout",
    factoryScript,
    "git pull the factory repo — bin/factory is part of the control plane",
  );

  // The UX critic's browser (WM-670). It was silently dead for a day: pi's
  // chrome-devtools extension launched Chrome headed on this display-less box,
  // Chrome died on "Missing X server or $DISPLAY", every web PR shipped
  // NOT-ASSESSED. Two checks: the headless wrapper really binds a DevTools port,
  // and the extension is pointed at it. Details in doctor-browser.mjs.
  {
    const b = await browserLaunchCheck();
    check(
      b.status === "pass" ? true : b.status === "skip" ? "warn" : false,
      "browser launches headless",
      b.status === "pass"
        ? `${path.relative(ROOT, b.executable)} → DevTools on :${b.port} in ${b.ms}ms`
        : b.detail,
      b.status === "pass"
        ? null
        : `missing: ${b.missing ?? "unknown — run bin/chrome-headless.sh --remote-debugging-port=0 --user-data-dir=$(mktemp -d) about:blank by hand"}`,
    );
    const pcd = piChromeDevtoolsCheck();
    check(
      pcd.status === "pass" ? true : pcd.status === "skip" ? "warn" : false,
      "pi chrome-devtools → headless wrapper",
      pcd.detail,
      pcd.status === "pass" ? null : pcd.fix,
    );
  }

  {
    const diagnostic = chainAutoApprovalPolicyDiagnostic();
    check(diagnostic.ok, diagnostic.label, diagnostic.detail, diagnostic.fix);
  }

  // Disk: worktrees are the bulk of what this machine holds, and a bootstrap that
  // fails halfway leaves a half-provisioned database behind.
  const df = sh('df -h ~ | tail -1 | awk \'{print $5" used, "$4" free"}\'');
  const pct = Number((df.stdout.match(/(\d+)%/) || [])[1] || 0);
  check(
    pct < 90 ? true : "warn",
    "disk",
    df.stdout.trim(),
    pct >= 90
      ? "run `factory janitor --repo <name> --apply` to reclaim finished worktrees"
      : null,
  );

  if (!repos.length) {
    console.error(c.red(`\nno matching repo in config/repos.yaml`));
    process.exit(2);
  }

  // run-agent.sh literally sends "/${COMMAND} $ARGS" as the prompt to `claude -p`
  // — there is no fallback if the repo's .claude/commands/<name>.md symlink is
  // missing, it's not "the command doesn't work", it's "the agent receives a
  // bare string with zero instructions and does whatever it improvises". The
  // directory is untracked by design (link-repos writes it, nothing commits
  // it), which means a `git clean -fdx` or a fresh worktree silently drops it.
  const expectedCommands = readdirSync(path.join(ROOT, "shared/commands"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.basename(f, ".md"));

  // -------------------------------------------------------------------- repos ---
  for (const repo of repos) {
    console.log(
      c.bold(`\n${repo.name}`) + c.dim(`  ${repo.team} / ${repo.project}`),
    );

    // Node-local: independent of whether the checkout exists. A mismatch is
    // diagnosable here instead of only as a dispatch refusal.
    for (const row of await repoToolchainDiagnostics({ repos: [repo] })) {
      check(row.ok, row.label, row.detail, row.fix);
    }

    const p = expand(repo.path);

    const cloned = existsSync(p) && existsSync(path.join(p, ".git"));
    check(
      cloned,
      "checkout exists",
      p,
      `git clone git@github.com:${repo.github}.git ${repo.path}   ${c.dim("(you clone it, not the factory)")}`,
    );
    if (!cloned) continue;

    const remote = sh("git remote get-url origin", p).stdout.trim();
    check(
      remote.includes(repo.github),
      "remote matches repos.yaml",
      remote,
      `expected ${repo.github} — fix repos.yaml or the remote`,
    );

    // `git fetch` updates remote-tracking refs only — it never touches the
    // working tree or your branches, so it stays within this script's read-only
    // contract. Its exit status matters, not just its side effect: a failed
    // fetch (offline, auth expired) that gets ignored leaves the check below
    // comparing against whatever origin/* happened to be cached, which is the
    // exact staleness this exists to catch — failing open on the question it
    // exists to answer.
    const fetched = sh("git fetch --quiet", p).status === 0;
    check(
      fetched,
      "fetch origin",
      fetched ? "" : "offline or auth expired",
      fetched
        ? null
        : "check network/`gh auth status` — freshness below is unverified until this succeeds",
    );
    const hasBase =
      fetched &&
      sh(`git rev-parse --verify origin/${repo.base}`, p).status === 0;
    check(hasBase, `base branch origin/${repo.base}`, "", "git fetch origin");

    // The read-only stages (sweep, triage, audit) read THIS checkout and judge
    // what the code already does. Behind trunk, a shipped feature reads as
    // unshipped: sweep leaves an overtaken ticket in the queue and triage writes
    // specs against code that moved (OPS-190). Warn rather than fail — a checkout
    // a few commits back is normal, and run-agent.sh fast-forwards a clean tree
    // before each run anyway. What needs surfacing is a checkout that is rotting.
    //
    // Fail closed on the count itself too: `sh(...).stdout` is "" on a failed
    // rev-list, and `"" || 0` reads that as "0 commits behind" — the same
    // failing-open bug as ignoring fetch's exit status, just one line later.
    if (hasBase) {
      const behindResult = sh(
        `git rev-list --count HEAD..origin/${repo.base}`,
        p,
      );
      const behindOk = behindResult.status === 0;
      const behind = behindOk ? Number(behindResult.stdout.trim() || 0) : null;
      const dirty = sh("git status --porcelain", p)
        .stdout.trim()
        .split("\n")
        .filter(Boolean).length;
      if (!behindOk) {
        check(
          "warn",
          "checkout current",
          "rev-list failed — behind-count unknown",
          `git -C ${repo.path} rev-list --count HEAD..origin/${repo.base}   (run by hand to see the error)`,
        );
      } else {
        check(
          behind < BEHIND_WARN ? true : "warn",
          "checkout current",
          `${behind} commit(s) behind origin/${repo.base}${dirty ? `, ${dirty} uncommitted` : ""}`,
          behind >= BEHIND_WARN
            ? dirty
              ? `commit or stash first, then \`git -C ${repo.path} merge --ff-only origin/${repo.base}\` — stages must read origin/${repo.base}, not this tree`
              : `git -C ${repo.path} merge --ff-only origin/${repo.base}`
            : null,
        );
      }
    }

    const commandsDir = path.join(p, ".claude", "commands");
    const missing = [];
    const broken = [];
    for (const name of expectedCommands) {
      const target = path.join(commandsDir, `${name}.md`);
      let st = null;
      try {
        st = lstatSync(target);
      } catch {
        /* intentionally ignored */
      }
      if (!st) {
        missing.push(name);
        continue;
      }
      if (st.isSymbolicLink() && !existsSync(target)) broken.push(name); // dangling symlink
    }
    const problems = [...missing, ...broken];
    check(
      problems.length === 0,
      "/factory-* commands linked",
      problems.length
        ? `${problems.length}/${expectedCommands.length} missing or broken: ${problems.join(", ")}`
        : `${expectedCommands.length} commands`,
      problems.length ? "factory emit" : null,
    );

    const gitignorePath = path.join(p, ".gitignore");
    const gitignoreBody = existsSync(gitignorePath)
      ? readFileSync(gitignorePath, "utf8")
      : "";
    check(
      harnessGitignoreIsCurrent(gitignoreBody),
      "factory harness gitignored",
      existsSync(gitignorePath) ? ".gitignore" : "no .gitignore",
      "factory emit  (adds FACTORY:HARNES block — symlinks must not be committed)",
    );

    const tracked = sh(
      "git ls-files -- '.claude/commands/factory-*.md' '.cursor/commands/factory-*.md' 2>/dev/null",
      p,
    )
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    check(
      tracked.length === 0,
      "no tracked factory command files",
      tracked.length ? tracked.join(", ") : "",
      tracked.length
        ? "git rm --cached the listed paths; they are local symlinks from factory emit"
        : null,
    );

    // Worktree tooling is PC-15 — the precondition for dispatching concurrent
    // agents. Without it a repo's safe concurrency is one agent, whatever the
    // dispatcher thinks. `report_only: true` repos have already acknowledged
    // this in repos.yaml (dispatch itself refuses to run for them — see
    // tick.mjs), so a missing script here is expected, not a doctor failure.
    for (const [k, label] of [
      ["worktree_up", "worktree-up script"],
      ["worktree_down", "worktree-down script"],
    ]) {
      const s = repo[k];
      const full = s ? path.join(p, s) : null;
      const ok = Boolean(full && existsSync(full));
      const exec = ok && (statSync(full).mode & 0o111) !== 0;
      if (repo.report_only && !ok) {
        check(
          "warn",
          `${label}`,
          "not configured",
          "report_only repo — dispatch is disabled here by design (PC-15)",
        );
        continue;
      }
      check(
        ok && exec,
        `${label}`,
        s ?? "not configured",
        !ok
          ? `this repo has no ${k} — dispatch is unsafe here (PC-15); see CW-363 / CLNT-609 for the pattern`
          : `chmod +x ${s}`,
      );
    }

    const wtRoot = expand(repo.worktree_root ?? "");
    check(
      Boolean(wtRoot) && existsSync(wtRoot) ? true : "warn",
      "worktree root",
      repo.worktree_root ?? "not set",
      "created on first worktree-up; nothing to do if the repo is new",
    );

    const dirty = sh("git status --porcelain | wc -l", p).stdout.trim();
    check(
      dirty === "0" ? true : "warn",
      "main checkout clean",
      `${dirty} uncommitted file(s)`,
      dirty === "0"
        ? null
        : "fine for triage (read-only), but specs are written against what's on disk",
    );

    // Does this repo's tracker actually resolve? A typo here fails at dispatch
    // time, after a worktree and a database already exist. The query has to be
    // per-adapter: asking GitHub a Linear question fails as a `gh` error that
    // reads like broken auth rather than like a misconfigured board.
    const repoKind = repo.control_plane ?? controlPlaneKind;
    const trackerLabel =
      repoKind === "github"
        ? "GitHub team/project resolves"
        : repoKind === "memory"
          ? "memory tracker"
          : "Linear team/project resolves";
    try {
      if (repoKind === "memory") {
        check("warn", trackerLabel, "in-process tracker — demo/tests only");
      } else if (repoKind === "github") {
        // Repository-scoped, so the same query works whether the board's owner
        // is a user or an organization — asking `organization(login:)` about a
        // user login is a hard NOT_FOUND, not an empty result. The board must
        // be linked to the repo anyway for the adapter to reach it.
        const [owner, name] = String(repo.github ?? "").split("/");
        const q = `query($owner:String!,$name:String!){
          repository(owner:$owner,name:$name){
            projectsV2(first:20){ nodes{ title number } }
          }
        }`;
        const d = await loadControlPlane({ repoName: repo.name }).raw(q, {
          owner,
          name,
        });
        const nodes = d?.repository?.projectsV2?.nodes ?? [];
        const hit = nodes.find((n) => n?.title === repo.project);
        check(
          Boolean(hit),
          trackerLabel,
          hit
            ? `${repo.github} / ${repo.project} (project #${hit.number})`
            : `no Projects v2 board titled ${JSON.stringify(repo.project)} linked to ${repo.github}`,
          hit
            ? null
            : `create and link the board, then re-run: factory init --control-plane github --repo ${repo.github}`,
        );
      } else {
        const q = `query($t:String!,$p:String!){ issues(first:1, filter:{ team:{key:{eq:$t}}, project:{name:{eq:$p}} }){ nodes{ identifier } } }`;
        const nodes =
          (
            await loadControlPlane({ repoName: repo.name }).raw(q, {
              t: repo.team,
              p: repo.project,
            })
          )?.issues?.nodes ?? [];
        check(
          true,
          trackerLabel,
          `${repo.team} / ${repo.project}${nodes[0] ? ` (e.g. ${nodes[0].identifier})` : " (no open issues)"}`,
        );
      }
    } catch (e) {
      check(
        false,
        trackerLabel,
        String(e.message).slice(0, 60),
        repoKind === "github"
          ? `check controlPlane.github in config/policy.yaml and the board's Status field: factory init --control-plane github --repo ${repo.github}`
          : "check team key and project name against linear.md §1–2 (CW projects carry a 'Coach Watts - ' prefix)",
      );
    }

    check(
      repo.verify ? true : repo.report_only ? "warn" : false,
      "verification command",
      repo.verify ?? "",
      repo.verify
        ? null
        : repo.report_only
          ? "report_only repo — set `verify:` before flipping dispatch on"
          : "set `verify:` in repos.yaml — agents must never open a PR without clean output",
    );
    check(
      repo.smoke_workflow ? true : "warn",
      "post-deploy smoke check",
      repo.smoke_workflow ?? "none",
      repo.smoke_workflow
        ? null
        : "without one, Done means merged rather than running",
    );
  }

  {
    const budget = loadLinearBudget();
    const status = linearBudgetStatus(budget);
    check(
      status === "pass" ? true : "warn",
      formatLinearBudgetLine(budget),
      "",
      status === "warn" && budget?.remaining != null
        ? "Linear is near its 2500 req/h cap — dispatch retries later instead of escalating"
        : null,
    );
  }

  console.log();
  if (failures) {
    console.log(
      c.red(
        `${failures} problem(s) — the loop will fail on these before it does anything useful.\n`,
      ),
    );
    process.exit(1);
  }
  console.log(c.green("ready.\n"));
}
