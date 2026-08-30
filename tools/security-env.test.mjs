import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

const ROOT = path.resolve(import.meta.dir, "..");

function run(args, { env = process.env } = {}) {
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      path.join(ROOT, "tools", "security-env.mjs"),
      ...args,
    ],
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("security-env emits the validated registry settings byte-for-byte", () => {
  const factoryRoot = mkdtempSync(path.join(tmpdir(), "security-env-"));
  try {
    mkdirSync(path.join(factoryRoot, "config"));
    writeFileSync(
      path.join(factoryRoot, "config", "repos.yaml"),
      `repos:
  - name: fixture
    path: ${ROOT}
    security:
      semgrep_args: --exclude-rule example.rule
      gitleaks_args: --no-git
      python_version: 3.12
`,
    );
    const proc = run([ROOT], {
      env: { ...process.env, FACTORY_REPOS_ROOT: factoryRoot },
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe(
      'export SEMGREP_ARGS="--exclude-rule example.rule"\nexport GITLEAKS_ARGS="--no-git"\nexport PYTHON_VERSION="3.12"\n',
    );
    expect(output(proc, "stderr")).toBe("");
  } finally {
    rmSync(factoryRoot, { recursive: true, force: true });
  }
});

function output(proc, stream) {
  return proc[stream]?.toString().trim() ?? "";
}

test("security-env help prints usage and invalid arguments exit 2 without stacks", () => {
  const help = run(["--help"]);
  expect(help.exitCode).toBe(0);
  expect(output(help, "stdout")).toStartWith("usage:");
  expect(output(help, "stderr")).toBe("");

  for (const args of [["--unknown"], ["/definitely/not/a/repository"]]) {
    const invalid = run(args);
    expect(invalid.exitCode).toBe(2);
    expect(output(invalid, "stderr").split("\n")).toHaveLength(1);
    expect(output(invalid, "stderr")).toStartWith("usage:");
    expect(output(invalid, "stderr")).not.toContain("ENOENT");
  }
});
