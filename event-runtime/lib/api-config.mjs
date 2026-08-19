/** Read-only, allow-listed configuration inventory (WM-704). */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ROOT } from "./config.mjs";
import { loadedExtensions, maskExtensionSecrets } from "./extensions.mjs";
import { reposView } from "./repos.mjs";
import { loadNodesConfig, nodesConfigPath } from "./workers-remote.mjs";

const POLICY_KEYS = [
  "packs",
  "chain_auto_approval",
  "merge",
  "dispatch",
  "concurrency",
  "workers",
  "actions_cache",
  "budget",
  "models",
  "limits",
  "circuit_breaker",
  "escalation",
  "notify",
];

const SCHEDULE_DEFAULT_KEYS = [
  "repo",
  "harness",
  "label_prefix",
  "log_dir",
  "run_at_load",
];

function readYaml(file, fallback = {}) {
  if (!existsSync(file)) return fallback;
  return Bun.YAML.parse(readFileSync(file, "utf8")) ?? fallback;
}

function source(file, kind) {
  return { file, kind };
}

function displayedSource(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith("..") ? relative : file;
}

function entriesForRepos(repos) {
  return reposView(repos).flatMap(({ name, ...fields }) =>
    Object.entries(fields).map(([field, value]) => ({
      key: `${name}.${field}`,
      value,
      note: `Repository ${name}`,
    })),
  );
}

function entriesForPolicy(policy) {
  return POLICY_KEYS.filter((key) => Object.hasOwn(policy, key)).map((key) => ({
    key,
    value: redactSecrets(policy[key]),
    reload: key === "models" ? "restart" : "hot",
  }));
}

function entriesForNodes(nodes) {
  return [...nodes.values()].flatMap((node) => [
    { key: `${node.name}.host`, value: node.host },
    { key: `${node.name}.user`, value: node.user },
    { key: `${node.name}.port`, value: node.port },
    { key: `${node.name}.factory_root`, value: node.factoryRoot },
    { key: `${node.name}.branch`, value: node.branch },
    { key: `${node.name}.labels`, value: node.labels },
    { key: `${node.name}.adapters`, value: node.adapters },
    {
      key: `${node.name}.env.keys`,
      value: Object.keys(node.env).sort(),
      note: "Environment variable names only; values are never exposed.",
    },
  ]);
}

function entriesForSchedule(schedule) {
  const defaults = schedule?.defaults ?? {};
  const defaultEntries = SCHEDULE_DEFAULT_KEYS.filter((key) =>
    Object.hasOwn(defaults, key),
  ).map((key) => ({ key: `defaults.${key}`, value: defaults[key] }));
  const jobs = Array.isArray(schedule?.jobs) ? schedule.jobs : [];
  return [
    ...defaultEntries,
    ...jobs
      .filter((job) => job && typeof job.name === "string")
      .map((job) => ({
        key: `jobs.${job.name}`,
        value: {
          cadence: job.every ?? null,
          harness: job.harness ?? defaults.harness ?? null,
        },
        note: "Job name, cadence, and selected harness only.",
      })),
  ];
}

/** Keys whose values are never published, wherever they sit in a config object. */
const SECRET_KEY = /token|secret|key|password/i;
const REDACTED = "[redacted]";

/**
 * Mask secret-looking keys at any depth. Empty and null values stay as they
 * are (there is nothing to hide and "unset" is what the operator needs to see).
 */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      SECRET_KEY.test(key) &&
      inner !== null &&
      inner !== "" &&
      inner !== undefined
        ? REDACTED
        : redactSecrets(inner),
    ]),
  );
}

/**
 * Extension config (WM-841): one row per extension the loader saw — accepted
 * ones with their namespace, schema and effective (defaulted, validated,
 * redacted) values; disabled ones with the anomaly that disabled them.
 */
function extensionsSection({ extensions = [], disabled = [] } = {}) {
  const items = [
    ...extensions.map((ext) => ({
      name: ext.name,
      version: ext.version,
      path: ext.path,
      namespace: ext.config?.namespace ?? null,
      reload: "restart",
      schema: ext.config?.schemaJson ?? null,
      values: ext.config
        ? maskExtensionSecrets(
            redactSecrets(ext.config.values),
            ext.config.schemaJson,
            ext.config.secretMeta,
          )
        : null,
      anomaly: null,
    })),
    ...disabled.map((ext) => ({
      name: ext.name,
      version: ext.version,
      path: ext.path,
      namespace: ext.namespace ?? null,
      reload: "restart",
      schema: null,
      values: null,
      anomaly: ext.reason,
    })),
  ];
  return {
    id: "extensions",
    title: "Extensions",
    source: source("config/policy.yaml", "yaml"),
    reload: "restart",
    entries: items.map((item) => ({
      key: item.namespace ?? item.name ?? item.path,
      value: item.values,
      reload: "restart",
      note: item.anomaly
        ? `${item.name ?? item.path}: disabled — ${item.anomaly}`
        : item.namespace
          ? `${item.name}@${item.version}`
          : `${item.name}@${item.version} declares no config`,
    })),
    extensions: items,
  };
}

function edgeSummary(edges) {
  const rules = Object.values(edges ?? {});
  return {
    sources: rules.length,
    routes: rules.reduce(
      (total, rule) => total + Object.keys(rule?.edges ?? {}).length,
      0,
    ),
  };
}

function entriesForRegistry(registry) {
  const eventTypes = Object.entries(registry.eventTypes ?? {}).map(
    ([type, mapping]) => ({
      key: `eventTypes.${type}.adapter`,
      value: mapping?.adapter ?? null,
      note: "Open Agents for the complete event route and definition.",
    }),
  );
  return [
    {
      key: "agents",
      value: registry.agents?.size ?? 0,
      note: "Open Agents for definition details.",
    },
    ...eventTypes,
    {
      key: "edges",
      value: edgeSummary(registry.edges),
      note: "Registry edge summary.",
    },
    {
      key: "schedules",
      value: Object.keys(registry.schedules ?? {}).length,
      note: "Open Schedules for loop details and runtime state.",
    },
  ];
}

/** Build the wire view independently so allow-lists and redaction are unit-testable. */
export function configView({
  registry,
  repos,
  policyVersion,
  root = FACTORY_ROOT,
  now = Date.now(),
  registryLoadedAt,
  // What loadExtensions() accepted/disabled in this process (tests pass their own).
  extensions = loadedExtensions(),
} = {}) {
  const policy = readYaml(path.join(root, "config", "policy.yaml"));
  const schedule = readYaml(path.join(root, "config", "schedule.yaml"));
  const nodesFile = nodesConfigPath(root);
  const loadedAt = registryLoadedAt ?? new Date(now).toISOString();
  const registryCounts = {
    loadedAt,
    agentCount: registry.agents?.size ?? 0,
    eventTypeCount: Object.keys(registry.eventTypes ?? {}).length,
    edgeCount: edgeSummary(registry.edges).routes,
    scheduleCount: Object.keys(registry.schedules ?? {}).length,
  };

  return {
    generatedAt: new Date(now).toISOString(),
    policyVersion,
    registry: registryCounts,
    sections: [
      {
        id: "repos",
        title: "Repositories",
        source: source("config/repos.yaml", "yaml"),
        reload: "hot",
        entries: entriesForRepos(repos()),
      },
      {
        id: "policy",
        title: "Policy",
        source: source("config/policy.yaml", "yaml"),
        reload: "hot",
        entries: entriesForPolicy(policy),
      },
      {
        id: "nodes",
        title: "Nodes",
        source: source(displayedSource(root, nodesFile), "yaml"),
        reload: "cli-only",
        entries: entriesForNodes(loadNodesConfig({ configPath: nodesFile })),
      },
      {
        id: "schedule",
        title: "Schedule",
        source: source("config/schedule.yaml", "yaml"),
        reload: "cli-only",
        entries: entriesForSchedule(schedule),
      },
      {
        id: "registry",
        title: "Registry",
        source: source("event-runtime/*.json", "registry"),
        reload: "restart",
        entries: entriesForRegistry(registry),
      },
      extensionsSection(extensions),
    ],
  };
}

export function handleConfigApiRoute({ route, send, ...options }) {
  if (route !== "GET /config") return false;
  return send(200, configView(options));
}
