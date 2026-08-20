#!/usr/bin/env bun
/**
 * Report GitHub Actions cache storage before it reaches the billing limit.
 *
 *   factory actions-cache
 *   factory actions-cache --json
 *   factory actions-cache --included-gb 73 --warning-percent 60
 *
 * Reads the organization-level Actions cache API; it does not mutate caches.
 * The command exits 1 at the configured warning threshold so it can be used as
 * a watched/manual gate or a future alert integration.
 */
import { loadConfigYaml, ROOT } from "../lib/schedule.mjs";
import { loadForge } from "../lib/forge/index.mjs";
import {
  renderActionsCacheUsage,
  summarizeActionsCacheUsage,
} from "../lib/actions-cache.mjs";

const argv = process.argv.slice(2);
const value = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
};
const number = (flag, fallback) => {
  const raw = value(flag);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`${flag} must be a positive number`);
    process.exit(2);
  }
  return parsed;
};

const policy = loadConfigYaml("policy", { root: ROOT });
const configured = policy.actions_cache ?? {};
const organization = value("--org") ?? configured.organization;
const includedGb = number("--included-gb", configured.included_gb);
const warningPercent = number("--warning-percent", configured.warning_percent);
const json = argv.includes("--json");

if (!organization || !includedGb || !warningPercent) {
  console.error(
    "Actions-cache policy is incomplete; set organization, included_gb, and warning_percent in config/policy.yaml.",
  );
  process.exit(2);
}

let raw;
if (process.env.FACTORY_ACTIONS_CACHE_USAGE_JSON) {
  // Test-only fixture seam: production always reads the GitHub API.
  raw = process.env.FACTORY_ACTIONS_CACHE_USAGE_JSON;
} else {
  try {
    raw = loadForge().apiRaw(
      `orgs/${organization}/actions/cache/usage-by-repository?per_page=100`,
    );
  } catch (err) {
    process.stderr.write(err.stderr ?? String(err.message ?? err));
    process.exit(err.status || 1);
  }
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  console.error("GitHub returned invalid Actions cache usage JSON.");
  process.exit(1);
}

const summary = summarizeActionsCacheUsage(payload, {
  includedGb,
  warningPercent,
});
if (json) console.log(JSON.stringify(summary, null, 2));
else console.log(renderActionsCacheUsage(summary));
process.exit(summary.warning ? 1 : 0);
