import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function commandFixture(prefix = "event-runtime-command-") {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const bin = path.join(root, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  return { root, bin, log: path.join(root, "commands.log") };
}

export function writeExecutable(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

export function runCommand(argv, fixture, env = {}) {
  return spawnSync(argv[0], argv.slice(1), {
    cwd: fixture.root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      COMMAND_LOG: fixture.log,
      ...env,
    },
  });
}
