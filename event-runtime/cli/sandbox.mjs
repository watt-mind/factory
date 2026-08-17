import path from "node:path";
import {
  preflight as sandboxPreflight,
  runInSandbox,
} from "../lib/sandbox/gondolin.mjs";
import { fail, flagValue, pad } from "./shared.mjs";

// ---------------------------------------------------------------------------

/**
 * Hand-driven sandbox access (WM-185) — the way to try a Gondolin microVM
 * without wiring an event, an agent definition, or a worker:
 *
 *   sandbox doctor
 *   sandbox exec --dir . --allow api.github.com --secret GITHUB_TOKEN=GH_TOKEN --shell -- \
 *     'curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user'
 *
 * `--secret NAME=ENVVAR` reads ENVVAR from this shell and scopes it to every
 * --allow host; the guest only ever sees a placeholder. `--shell` runs the
 * command through the guest's /bin/sh, which is a convenience for interactive
 * use — the command adapter always uses argv form, with no shell at all.
 */
export default async function sandbox(args) {
  const sub = args[0];

  if (sub === "doctor") {
    const report = sandboxPreflight();
    console.log(`${pad("available", 14)}${report.available ? "yes" : "no"}`);
    if (report.cause) console.log(`${pad("cause", 14)}${report.cause}`);
    console.log(`${pad("qemu", 14)}${report.qemu ?? "-"}`);
    console.log(
      `${pad("node", 14)}${report.node ?? "-"}${report.nodeVersion ? `   (v${report.nodeVersion})` : ""}`,
    );
    console.log(
      `${pad("sdk", 14)}${report.sdk ? "@earendil-works/gondolin installed" : "-"}`,
    );
    if (!report.available) {
      console.log(`\n${report.reason}`);
      // The exit code carries the distinction, not just the text (WM-312): a
      // host that cannot virtualize is an ordinary fact about that machine; a
      // missing harness is a stale checkout someone must fix. CI asserts on
      // `install` and tolerates `host`, so runners without QEMU do not turn a
      // real regression into noise everyone learns to skip past.
      process.exit(report.cause === "install" ? 2 : 1);
    }
    return;
  }

  if (sub !== "exec") {
    fail(
      "usage: sandbox doctor | sandbox exec [--dir P] [--allow HOST]... [--secret NAME=ENVVAR]... [--shell] [--timeout S] -- <command>",
    );
  }

  const rest = args.slice(1);
  const separator = rest.indexOf("--");
  if (separator === -1 || separator === rest.length - 1) {
    fail(
      "sandbox exec: the command must follow `--` (e.g. sandbox exec --dir . -- /bin/ls -la /workspace)",
    );
  }
  const flags = rest.slice(0, separator);
  const commandArgv = rest.slice(separator + 1);

  const dir = path.resolve(flagValue(flags, "--dir") ?? process.cwd());
  const shell = flags.includes("--shell");
  const timeoutSeconds = Number(flagValue(flags, "--timeout") ?? 120);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
    fail("sandbox exec: --timeout must be a positive number of seconds");

  const allowedHosts = [];
  const secrets = {};
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === "--allow") {
      const host = flags[i + 1];
      if (!host) fail("sandbox exec: --allow expects a host");
      allowedHosts.push(host);
    }
    if (flags[i] === "--secret") {
      const [name, ...envRest] = String(flags[i + 1] ?? "").split("=");
      if (!name) fail("sandbox exec: --secret expects NAME or NAME=ENVVAR");
      secrets[name] = { env: envRest.length > 0 ? envRest.join("=") : name };
    }
  }
  // A secret is scoped to whatever egress was actually allowed; policy
  // normalization rejects any wider claim, so this can never over-grant.
  for (const secret of Object.values(secrets)) secret.hosts = allowedHosts;

  const report = sandboxPreflight();
  if (!report.available) fail(`sandbox exec: ${report.reason}`);

  try {
    const { exitCode, timedOut, bootMs } = await runInSandbox({
      policy: { provider: "gondolin", allowedHosts, secrets },
      command: shell ? commandArgv.join(" ") : commandArgv,
      workspaceDir: dir,
      timeoutMs: timeoutSeconds * 1000,
      shell,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    console.error(
      `\n[sandbox] ${dir} mounted at /workspace   egress: ${allowedHosts.length ? allowedHosts.join(", ") : "deny-all"}   boot ${bootMs ?? "?"}ms`,
    );
    if (timedOut) fail(`sandbox exec: timed out after ${timeoutSeconds}s`);
    process.exit(exitCode ?? 1);
  } catch (err) {
    fail(`sandbox exec: ${err.message}`);
  }
}
