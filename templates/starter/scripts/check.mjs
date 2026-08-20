import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = [
  "AGENTS.md",
  "README.md",
  "config/repos.yaml",
  "config/policy.yaml",
  "config/schedule.yaml",
  "packs/README.md",
  ".github/workflows/ci.yml",
];

const missing = REQUIRED.filter((file) => !existsSync(path.join(ROOT, file)));
if (missing.length) {
  throw new Error(`factory-starter is missing: ${missing.join(", ")}`);
}

const manifest = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
const kernel = manifest.dependencies?.["@watt-mind/factory"];
if (
  typeof kernel !== "string" ||
  !/^github:watt-mind\/factory#[0-9a-f]{40}$/.test(kernel)
) {
  throw new Error("@watt-mind/factory must be pinned to an exact Git commit");
}

console.log(`factory-starter: valid (${REQUIRED.length} required files)`);
