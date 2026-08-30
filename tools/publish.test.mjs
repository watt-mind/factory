import path from "node:path";
import { expect, test } from "bun:test";

const ROOT = path.resolve(import.meta.dir, "..");

function run(args) {
  return Bun.spawnSync({
    cmd: [process.execPath, path.join(ROOT, "tools", "publish.mjs"), ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(proc, stream) {
  return proc[stream]?.toString().trim() ?? "";
}

test("publish help prints usage and invalid arguments exit 2", () => {
  const help = run(["--help"]);
  expect(help.exitCode).toBe(0);
  expect(output(help, "stdout")).toStartWith("usage:");
  expect(output(help, "stderr")).toBe("");

  for (const args of [[], ["--unknown"]]) {
    const invalid = run(args);
    expect(invalid.exitCode).toBe(2);
    expect(output(invalid, "stderr").split("\n")).toHaveLength(1);
    expect(output(invalid, "stderr")).toStartWith("usage:");
  }
});
