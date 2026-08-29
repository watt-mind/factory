import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-registry-test-mjs";
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { format as prettierFormat, resolveConfig } from "prettier";
import { canonicalJson, hashBytes } from "./canonical.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import {
  DEFAULT_MODEL,
  RegistryError,
  agentDefinitionFile,
  createFsPackLoader,
  getAgent,
  getArtifactView,
  getEventType,
  loadModelTierMap,
  loadPackRoots,
  loadRegistry,
  resolveModel,
  updatePins,
} from "./registry.mjs";
import { computeDefHash } from "./receipts.mjs";
import { updateHarnessPins } from "./pins.mjs";

/** Copy the real registry into a temp root so tests can corrupt it safely. */
function tempRegistry() {
  const root = tmpDir("event-registry-");
  for (const dir of ["agents", "schemas"]) {
    cpSync(path.join(RUNTIME_ROOT, dir), path.join(root, dir), {
      recursive: true,
    });
  }
  cpSync(
    path.join(RUNTIME_ROOT, "event-types.json"),
    path.join(root, "event-types.json"),
  );
  return root;
}

/**
 * A tier map that satisfies the committed registry: since WM-215 every LLM
 * route is the pi adapter, so the pi map must cover every tier a routed
 * definition declares. The claude map stays as the per-route exception's
 * mapping — no committed route consumes it today.
 */
const SAMPLE_PACK_ROOT = path.join(
  RUNTIME_ROOT,
  "test-support",
  "packs",
  "sample",
);

function samplePack(
  root = SAMPLE_PACK_ROOT,
  name = "sample",
  namespace = "sample",
) {
  return { kind: "fs", name, path: root, namespace };
}

function tempPack({ name = "sample", namespace = "sample" } = {}) {
  const root = tmpDir("event-pack-");
  cpSync(SAMPLE_PACK_ROOT, root, { recursive: true });
  writeFileSync(
    path.join(root, "pack.json"),
    `${JSON.stringify({ name, version: "1.0.0", namespace }, null, 2)}\n`,
  );
  return samplePack(root, name, namespace);
}

function registryDigest(registry) {
  const agents = Object.fromEntries(
    [...registry.agents].map(([ref, def]) => {
      const { pack: _pack, promptPath, ...stable } = def;
      return [
        ref,
        { ...stable, promptPath: path.relative(registry.root, promptPath) },
      ];
    }),
  );
  return hashBytes(
    canonicalJson({
      agents,
      eventTypes: registry.eventTypes,
      edges: registry.edges,
      // Local config/schedule.yaml is instance state, not a registry input:
      // its overlay must never change the digest of pinned kernel defaults.
      schedules: registry.kernelSchedules ?? registry.schedules,
      modelTiers: registry.modelTiers,
    }),
  );
}

const PI_TIERS = {
  claude: { strong: "default", standard: "sonnet", light: "haiku" },
  pi: {
    strong: "openai-codex/gpt-5.6-sol",
    standard: "openai-codex/gpt-5.6-terra",
    light: "openai-codex/gpt-5.6-luna",
  },
  agy: {
    strong: "gemini-3.7-flash",
    standard: "gemini-3.7-flash",
    light: "gemini-3.7-flash",
  },
  cursor: {
    strong: "composer-2.5",
    standard: "composer-2.5",
    light: "composer-2.5-fast",
  },
};

describe("registry", () => {
  test("loads the committed registry (pins verified)", () => {
    const registry = loadRegistry();
    const def = getAgent(registry, "factory-status-report@1");
    expect(def.outputSchema.required).toContain("recommendedAction");
    expect(def.pack).toBe("event-runtime");
    expect(registry.packs).toEqual([
      { name: "event-runtime", root: RUNTIME_ROOT, namespace: "" },
    ]);
    expect(
      getEventType(registry, "factory.status-report.requested").agent,
    ).toBe("factory-status-report@1");
    expect(getEventType(registry, "unknown.event")).toBeNull();
  });

  test("agentDefinitionFile resolves the owning JSON relative to a chosen root (gh-860)", () => {
    const registry = loadRegistry();
    const packRelative = agentDefinitionFile(
      registry,
      "factory-status-report@1",
    );
    expect(packRelative.file).toBe("agents/factory-status-report.json");
    expect(packRelative.absSource).toBe(
      path.join(RUNTIME_ROOT, "agents", "factory-status-report.json"),
    );
    // Given the repo root, the path is what a full checkout carries.
    const repoRelative = agentDefinitionFile(
      registry,
      "factory-status-report@1",
      {
        root: path.dirname(RUNTIME_ROOT),
      },
    );
    expect(repoRelative.file).toBe(
      "event-runtime/agents/factory-status-report.json",
    );
    expect(() => agentDefinitionFile(registry, "no-such@9")).toThrow(
      RegistryError,
    );
  });

  test("work-scan scopes every queue and inflight ticket read to its input repo", () => {
    const prompt = readFileSync(
      path.join(RUNTIME_ROOT, "agents", "work-scan.md"),
      "utf8",
    );
    const ticketReads = [
      ...prompt.matchAll(/ticket\.mjs"?\s+(?:queue|inflight)\b([^\n]*)/g),
    ];
    expect(ticketReads).toHaveLength(2);
    for (const [, args] of ticketReads)
      expect(args).toContain('--repo "$REPO"');
  });

  test("zero-pack merged-view digest matches the develop baseline", () => {
    // Regenerate with registryDigest(loadRegistry({ packRoots: [] })) on develop.
    // The serializer omits only WM-470's new pack provenance and normalizes
    // the absolute prompt path. Changing this digest requires an explicit
    // reason in the PR body: it is the mechanical zero-pack compatibility gate.
    // Regenerated 2026-08-18: #559 (WM-662, merge agents cursor→pi/terra) landed
    // between #479's review and its merge, changing event-types.json and two
    // agent defs — registry inputs. Reason in PR body per the rule above.
    // WM-469 intentionally adds the three declarative kernel-control fields
    // to the affected definitions while preserving their refs and pins
    // (digest regenerated on top of the #559 baseline).
    // Regenerated (WM-694): dispatch input admits a pinned per-ticket modelTier override.
    // Regenerated (WM-718): mechanical handoff verification in dispatch prompt (re-pinned dispatch.json).
    // Regenerated 2026-08-18 (ops/triage-8h-clock): dropped work-scan@1 LOW_SUPPLY
    // and triage-apply@1 DETAIL_CHANGED chain edges to factory.triage.requested,
    // added the triage-factory 8h schedule. Operator decision 2026-08-18: stop
    // burning the pi/codex adapter's quota on ~30-minute chain-triggered triage
    // scans; triage now runs on a fixed 8h clock plus manual operator injection.
    // Regenerated (WM-769): merge-scan/merge-fix format_and_lint routing changed agent defs (registry inputs).
    // Regenerated (merge-scan output-shape fix): agent def is a registry input.
    // Regenerated (merge on agy): merge-scan/merge-fix adapter claude→agy; event-types.json is a registry input.
    // Regenerated (triage on agy): triage-scan adapter pi→agy; event-types.json is a registry input.
    // Regenerated (work-scan advisory overlap, WM-677): agent def is a registry input.
    // Regenerated (merge-scan fix.ownedPaths rule): agent def is a registry input.
    // Regenerated (dispatch on cursor): dispatch@1 adapter pi→cursor; event-types.json is a registry input.
    // Regenerated (WM-811): dispatch declares ticket postmortem memos; run-postmortem
    // emits them; dispatch.input admits memoPin; both defs re-pinned.
    // Regenerated (WM-812): dispatch/merge-scan declare decision memos and re-pin briefs.
    // Regenerated (WM-907): merge-scan@2 is the command enumerator; merge-review@1 is the per-PR agy reviewer;
    // factory.merge-review.requested + REVIEW fan-out + merge_reviews ledger.
    // Regenerated (WM-907, cold-review fixup): merge-review@1 declares the same
    // decision-memo block WM-812 gave merge-scan, so the per-PR reviewer sees
    // prior repo decisions too; agent def is a registry input.
    // Regenerated (WM-907 follow-up): merge-review.input.json admits the
    // planner-folded memoPin (the memos block made every review
    // input_schema_invalid without it); re-pinned merge-review.json.
    // Regenerated (WM-907 follow-up): merge-review.md defines
    // fix.withinOwnedPaths (operational fixes are always true); re-pinned.
    // Regenerated (WM-908 rebase onto WM-936): merge-plan@1 + batched apply/verify;
    // merge-scan enumerator keys on head SHA and re-pins merge-scan.md;
    // registry inputs (agents, edges, event-types).
    // Regenerated (merge-factory clock scan 15m -> 4h in schedules.json).
    // Regenerated (WM-938): dispatch pins explicit PR bases and merge-scan
    // surfaces wrong-base PRs; both agent definitions are registry inputs.
    // Regenerated (WM-1039): dispatch runs only ticket + configured repo
    // verification in worktrees; full suites remain CI-only.
    // Regenerated (WM-1039 rebase over tracker-neutral sweep)
    // Regenerated (WM-1006 cutover: ticket patterns accept GitHub owner/repo#N ids; schemas re-pinned)
    // Regenerated (#969): work-scan excludes tickets the dispatch gate must
    // noop, so a security-heavy queue cannot exhaust the dispatch batch.
    // Regenerated (#846/WM-696): triage-scan/triage-apply admit tier/tierReason
    // for model-tier sizing on promotion; both agent definitions are registry inputs.
    // Regenerated (#846 fix round): label-agent-ready removes all three
    // tier:* values before adding the proposed one (triage-apply.json is a
    // registry input); the schema's tier/tierReason requirement was
    // reverted (the runtime's closed validator has no allOf/if/then).
    // Regenerated (#941): disk-diagnose/disk-remediate host allowlists moved
    // to instance-local config; tracked definitions ship empty (both are
    // registry inputs).
    // Regenerated (#924): triage-scan selects its configured control plane and
    // fails closed when a GitHub Project title does not match.
    // Regenerated (#985): list-reading scan prompts pass their input repo to
    // ticket.mjs, so ephemeral workspaces do not fall back to another plane.
    // Regenerated (#996): added the work-factory clock (30m,
    // factory.work.requested, auto) so agent-ready supply self-dispatches
    // without a manual work.requested seed.
    // Regenerated (triage-apply repo plane): the label/detail/comment action
    // argv templates now pass `--repo {repo}` to ticket.mjs, so triage-apply
    // resolves the issue's own control plane instead of defaulting to the
    // cwd (github) plane — the apply-side sibling of #985's scan-side fix.
    // Without it, applying a triage plan to any Linear repo fails closed with
    // "not a GitHub issue identifier". triage-apply.json is a registry input.
    // Regenerated (triage-apply repo-flag position): --repo {repo} moved from
    // before the verb to the END of each argv. ticket.mjs takes the verb from
    // argv[0] (tools/ticket.mjs:526), so a leading --repo was parsed as the
    // verb and every action exited non-zero; --repo is in VALUE_FLAGS so it
    // parses correctly anywhere after the verb (matches `queue --repo bj29`).
    // Regenerated (#910): label-agent-ready also passes its schema-constrained
    // tierReason as a separate state --comment argv element (before --repo).
    // Regenerated (command-result captured property): the command adapter
    // emits artifact.captured for any def with captureStdout, but the schema
    // rejected it (additionalProperties:false) — failing reaper/label-guard/
    // reconcile/warm/unblock-digest every run. Added captured to the schema;
    // 11 command defs re-pinned. Registry inputs changed.
    // Regenerated (security-ticket dispatch, WM-1060): work-scan.md now admits
    // `type:security` candidates when input.dispatchSecurity == "auto" instead
    // of always pre-filtering them. work-scan.md re-pinned.
    // Regenerated (#1077): dispatch.md specifies the PR body's `## Validation`
    // table and merge-review.md is told to treat it as claimed, not verified,
    // evidence. Both prompts are registry inputs; dispatch.json and
    // merge-review.json are re-pinned. Prompt text only — no schema, contract,
    // route, or capability changed.
    // Regenerated (#1028): private client-repo loops (bj29/cashsaas/legalease/
    // wm-home work-/merge-/ship-/reconcile-/label-guard-/warm-/unblock-digest-)
    // moved out of the public kernel schedules.json into the instance overlay,
    // so the tracked kernel now ships only reaper/work-factory/merge-factory/
    // triage-factory. schedules.json is a registry input (kernelSchedules).
    const expected =
      "sha256:9c8b4dc211772cfbe7645fd99dcac98a644ce5aa3170c8f91f12815309f4d7bd";
    expect(registryDigest(loadRegistry({ packRoots: [] }))).toBe(expected);
  });

  test("local schedule overlay changes enabled, cadence, payload, and source without changing the kernel digest", () => {
    const config = path.join(
      tmpDir("event-schedule-overlay-"),
      "schedule.yaml",
    );
    writeFileSync(
      config,
      `schedules:\n  work-factory:\n    every: 9h\n    enabled: true\n    payload:\n      instance: local\n  merge-factory:\n    enabled: false\n`,
    );
    const overlaid = loadRegistry({
      packRoots: [],
      scheduleConfigPath: config,
    });
    const withoutOverlay = loadRegistry({
      packRoots: [],
      scheduleConfigPath: path.join(
        tmpDir("event-schedule-overlay-auto-absent-"),
        "schedule.yaml",
      ),
    });

    expect(overlaid.schedules["work-factory"]).toMatchObject({
      every: "9h",
      enabled: true,
      payload: { repo: "factory", instance: "local" },
    });
    expect(overlaid.schedules["merge-factory"].enabled).toBe(false);
    expect(overlaid.scheduleSources["work-factory"]).toBe("overlay");
    expect(overlaid.scheduleSources.reaper).toBe("kernel");
    expect(registryDigest(overlaid)).toBe(registryDigest(withoutOverlay));
  });

  test("an explicitly allowlisted overlay loop may use auto approval and reports its authorization", () => {
    const config = path.join(
      tmpDir("event-schedule-overlay-auto-"),
      "schedule.yaml",
    );
    writeFileSync(
      config,
      `overlay_auto_approve:\n  - reaper\nschedules:\n  reaper:\n    enabled: true\n    approval: auto\n`,
    );
    const authorized = loadRegistry({
      packRoots: [],
      scheduleConfigPath: config,
    });
    const withoutOverlay = loadRegistry({
      packRoots: [],
      scheduleConfigPath: path.join(
        tmpDir("event-schedule-overlay-auto-absent-"),
        "schedule.yaml",
      ),
    });

    expect(authorized.schedules["reaper"]).toMatchObject({
      enabled: true,
      approval: "auto",
    });
    expect(authorized.scheduleSources["reaper"]).toBe(
      "operator-authorized-auto",
    );
    expect(withoutOverlay.schedules["reaper"].approval).toBe("watched");
    expect(withoutOverlay.scheduleSources["reaper"]).toBe("kernel");
    expect(registryDigest(authorized)).toBe(registryDigest(withoutOverlay));
  });

  test("an unallowlisted overlay auto request is forced to watched and explains why", () => {
    const config = path.join(
      tmpDir("event-schedule-overlay-unlisted-auto-"),
      "schedule.yaml",
    );
    writeFileSync(
      config,
      `schedules:\n  reaper:\n    enabled: true\n    approval: auto\n`,
    );
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    let registry;
    try {
      registry = loadRegistry({ packRoots: [], scheduleConfigPath: config });
    } finally {
      console.warn = originalWarn;
    }

    expect(registry.schedules["reaper"].approval).toBe("watched");
    expect(registry.scheduleSources["reaper"]).toBe("overlay");
    expect(warnings).toEqual([
      expect.stringContaining("not named in overlay_auto_approve"),
    ]);
  });

  test("local schedule overlay permits new complete entries and rejects kernel routing changes", () => {
    const config = path.join(tmpDir("event-schedule-new-"), "schedule.yaml");
    writeFileSync(
      config,
      `schedules:\n  instance-reconcile:\n    every: 10m\n    eventType: factory.reconcile.requested\n    payload:\n      repo: instance\n    enabled: false\n`,
    );
    const registry = loadRegistry({
      packRoots: [],
      scheduleConfigPath: config,
    });
    expect(registry.schedules["instance-reconcile"]).toMatchObject({
      every: "10m",
      eventType: "factory.reconcile.requested",
      payload: { repo: "instance" },
    });
    expect(registry.scheduleSources["instance-reconcile"]).toBe("overlay");

    writeFileSync(
      config,
      `schedules:\n  reaper:\n    eventType: factory.reconcile.requested\n`,
    );
    expect(() =>
      loadRegistry({ packRoots: [], scheduleConfigPath: config }),
    ).toThrow(/cannot override a kernel schedule/);
  });

  test("a new overlay loop declaring approval:auto is coerced to watched (WM-998)", () => {
    const config = path.join(
      tmpDir("event-schedule-new-auto-"),
      "schedule.yaml",
    );
    writeFileSync(
      config,
      `schedules:\n  instance-auto:\n    every: 10m\n    eventType: factory.reconcile.requested\n    approval: auto\n    enabled: true\n`,
    );
    const registry = loadRegistry({
      packRoots: [],
      scheduleConfigPath: config,
    });
    // An overlay cannot grant a brand-new loop unattended approval: nobody
    // upstream ever reviewed it, so it always queues for a human — the
    // overlay's own "auto" is silently overridden, not honored.
    expect(registry.schedules["instance-auto"].approval).toBe("watched");
    expect(registry.scheduleSources["instance-auto"]).toBe("overlay");
  });

  test("a payload-only overlay override does not disarm the auto/enabled guard (WM-998)", () => {
    // Fixture pack ships a loop that is already invalid on its own terms:
    // approval "auto" on a loop that is not enabled. Loading it with no
    // overlay involved must fail closed.
    const pack = tempPack();
    writeFileSync(
      path.join(pack.path, "schedules.json"),
      JSON.stringify({
        "temp-auto-guard": {
          every: "60m",
          eventType: "sample.echo.requested",
          catchUp: "none",
          approval: "auto",
          enabled: false,
        },
      }),
    );
    expect(() => loadRegistry({ packRoots: [pack] })).toThrow(
      /declares approval "auto" but is not enabled/,
    );

    // An overlay that touches this loop but never sets `enabled` (a
    // payload- or cadence-only override) must not relax the guard just
    // because the loop's source flips to "overlay" — only an overlay that
    // itself sets enabled:false is the deliberate emergency-stop case.
    const config = path.join(
      tmpDir("event-schedule-auto-guard-"),
      "schedule.yaml",
    );
    writeFileSync(config, `schedules:\n  temp-auto-guard:\n    every: 90m\n`);
    expect(() =>
      loadRegistry({ packRoots: [pack], scheduleConfigPath: config }),
    ).toThrow(/declares approval "auto" but is not enabled/);

    // The overlay explicitly setting enabled:false, by contrast, is the
    // deliberate emergency-stop case and stays exempt.
    writeFileSync(
      config,
      `schedules:\n  temp-auto-guard:\n    enabled: false\n`,
    );
    const registry = loadRegistry({
      packRoots: [pack],
      scheduleConfigPath: config,
    });
    expect(registry.schedules["temp-auto-guard"].enabled).toBe(false);
    expect(registry.scheduleSources["temp-auto-guard"]).toBe("overlay");
  });

  test("an absent schedules section leaves the effective schedules byte-identical", () => {
    const config = path.join(
      tmpDir("event-schedule-identity-"),
      "schedule.yaml",
    );
    writeFileSync(config, "defaults:\n  repo: instance\njobs: []\n");
    const withEmptyOverlay = loadRegistry({
      packRoots: [],
      scheduleConfigPath: config,
    });
    // The baseline must be pinned to an explicit, provably overlay-free
    // config path rather than the default resolution (which would pick up
    // an ambient repo-root schedule.yaml, if one happens to exist locally)
    // — this test asserts identity against "no overlay", not against
    // whatever the developer's working tree currently contains.
    const absentConfig = path.join(
      tmpDir("event-schedule-identity-absent-"),
      "schedule.yaml",
    );
    const defaults = loadRegistry({
      packRoots: [],
      scheduleConfigPath: absentConfig,
    });
    expect(JSON.stringify(withEmptyOverlay.schedules)).toBe(
      JSON.stringify(defaults.schedules),
    );
    expect(withEmptyOverlay.scheduleSources).toEqual(defaults.scheduleSources);
  });

  test("pack provenance never enters the receipt defHash (WM-470)", () => {
    // The absolute constant is the whole point: it is develop's defHash for
    // this definition, whose content WM-470 did not touch. computeDefHash
    // strips the known runtime-injected fields and hashes the enumerable rest,
    // so any new enumerable key silently re-hashes every built-in agent and
    // makes verifyDefHash refuse them with `agent_definition_mismatch`. `pack`
    // is therefore defined non-enumerably: readable by callers, invisible to
    // the hash. Do not "update" this constant — a change here means a
    // provenance break, not a stale expectation.
    const registry = loadRegistry();
    const def = registry.agents.get("dispatch@1");
    expect(def.pack).toBe("event-runtime");
    expect(Object.keys(def)).not.toContain("pack");
    // WM-718 and WM-391 changed dispatch@1's prompt and input schema, so its
    // pin — and therefore this defHash — legitimately moved, exactly as it did
    // for WM-610. Still not a provenance break: `pack` stays non-enumerable.
    // WM-812 adds decision-memo declarations and re-pins the dispatch brief.
    // WM-938 adds the explicit-base PR command and re-pins dispatch.
    // WM-1039 keeps dispatched worktree verification to the ticket and repo
    // commands, leaving full suites to CI, and re-pins dispatch.
    // Regenerated (WM-1039 rebase over tracker-neutral sweep)
    // Regenerated (WM-1006 cutover: ticket patterns accept GitHub owner/repo#N ids; schemas re-pinned)
    // Regenerated (#1077): dispatch.md specifies the PR body's `## Validation`
    // table (observed results, no PR on a fail, bounded rows, must agree with
    // the Handoff), so the prompt pin moved. Prompt text only — `pack` stays
    // non-enumerable and no enumerable key was added.
    expect(computeDefHash(def)).toBe(
      "sha256:9b9f59322454c0935cef3a83c85adf2dee84e6b1e6d5301d1b1de46267b05ea4",
    );
  });

  test("loads a namespaced filesystem pack and validates the merged maps", () => {
    const registry = loadRegistry({ packRoots: [samplePack()] });
    const def = getAgent(registry, "sample/echo@1");
    expect(def.pack).toBe("sample");
    expect(def.promptPath).toBe(
      path.join(SAMPLE_PACK_ROOT, "agents", "echo.md"),
    );
    expect(def.pins).toEqual(
      JSON.parse(
        readFileSync(path.join(SAMPLE_PACK_ROOT, "pins.json"), "utf8"),
      ),
    );
    expect(Object.entries(def.pins)).toHaveLength(3);
    expect(getEventType(registry, "sample.echo.requested").agent).toBe(
      "sample/echo@1",
    );
    expect(getEventType(registry, "sample.core-status.requested").agent).toBe(
      "factory-status-report@1",
    );
    expect(registry.edges["sample/echo@1"].recommendationField).toBe("message");
    expect(registry.schedules["sample-echo"].eventType).toBe(
      "sample.echo.requested",
    );
    expect(registry.packs.map((pack) => pack.name)).toEqual([
      "event-runtime",
      "sample",
    ]);
  });

  test("merged validation accepts a loader with no filesystem access", () => {
    const resources = {
      "agents/echo.md": "Return the input unchanged.\n",
      "schemas/echo.input.json": JSON.stringify({ type: "object" }),
      "schemas/echo.output.json": JSON.stringify({ type: "object" }),
    };
    const definition = {
      id: "echo",
      version: 1,
      prompt: "agents/echo.md",
      input_schema: "schemas/echo.input.json",
      output_schema: "schemas/echo.output.json",
      workspace: { type: "ephemeral", retainOnFailure: false },
      capabilities: { filesystem: "read-only", services: [] },
      limits: { timeout_seconds: 30, attempts: 1 },
      mutating: false,
    };
    const pins = Object.fromEntries(
      Object.entries(resources).map(([name, bytes]) => [
        name,
        hashBytes(bytes),
      ]),
    );
    const loader = {
      listAgentDefs: () => [{ source: "memory:agents/echo.json", definition }],
      readPinned: (relative) => ({
        expected: pins[relative],
        bytes: resources[relative],
        source: `memory:${relative}`,
        path: `memory:${relative}`,
      }),
      readMap: (name) =>
        name === "event-types"
          ? {
              "memory.echo.requested": {
                agent: "memory/echo@1",
                adapter: "fake",
                idempotencyScope: ["correlationId"],
              },
            }
          : Object.create(null),
    };
    const registry = loadRegistry({
      packRoots: [
        {
          kind: "memory",
          name: "memory",
          namespace: "memory",
          root: "memory:pack",
        },
      ],
      loaderFor: (pack, options) =>
        pack.kind === "memory" ? loader : createFsPackLoader(pack, options),
    });
    const def = getAgent(registry, "memory/echo@1");
    expect(def.promptPath).toBe("memory:agents/echo.md");
    expect(def.pins).toEqual(pins);
    expect(getEventType(registry, "memory.echo.requested").agent).toBe(
      "memory/echo@1",
    );
  });

  test("duplicate agent refs identify both source packs", () => {
    const other = tempPack({ name: "other", namespace: "sample" });
    expect(() => loadRegistry({ packRoots: [samplePack(), other] })).toThrow(
      /duplicate agent ref.*sample.*other/,
    );
  });

  test("map collisions identify both source packs", () => {
    for (const [file, key, label] of [
      ["event-types.json", "factory.status-report.requested", "event type"],
      ["edges.json", "disk-diagnose@1", "edge source"],
      ["schedules.json", "reaper", "schedule loop"],
    ]) {
      const pack = tempPack();
      writeFileSync(path.join(pack.path, file), JSON.stringify({ [key]: {} }));
      expect(() => loadRegistry({ packRoots: [pack] })).toThrow(
        new RegExp(`duplicate ${label}.*event-runtime.*sample`),
      );
    }
  });

  test("prototype-like map keys collide normally without polluting merged maps", () => {
    const first = tempPack();
    const second = tempPack({ name: "other", namespace: "other" });
    const protoEvent = '{"__proto__":{"observe":true}}';
    writeFileSync(path.join(first.path, "event-types.json"), protoEvent);
    writeFileSync(path.join(second.path, "event-types.json"), protoEvent);
    expect(() => loadRegistry({ packRoots: [first, second] })).toThrow(
      /duplicate event type "__proto__".*sample.*other/,
    );

    const registry = loadRegistry({ packRoots: [] });
    expect(Object.getPrototypeOf(registry.eventTypes)).toBeNull();
    expect(Object.getPrototypeOf(registry.edges)).toBeNull();
    expect(Object.getPrototypeOf(registry.schedules)).toBeNull();
    expect(getEventType(registry, "toString")).toBeNull();
  });

  test("inherited object names cannot satisfy event references", () => {
    const edgePack = tempPack();
    writeFileSync(
      path.join(edgePack.path, "edges.json"),
      JSON.stringify({
        "sample/echo@1": {
          recommendationField: "message",
          edges: { BAD: { eventType: "toString" } },
        },
      }),
    );
    expect(() => loadRegistry({ packRoots: [edgePack] })).toThrow(
      /targets unregistered event type toString/,
    );

    const schedulePack = tempPack();
    writeFileSync(
      path.join(schedulePack.path, "schedules.json"),
      JSON.stringify({
        "inherited-event": {
          every: "60m",
          eventType: "constructor",
          approval: "watched",
          enabled: false,
        },
      }),
    );
    expect(() => loadRegistry({ packRoots: [schedulePack] })).toThrow(
      /fires unregistered event type constructor/,
    );
  });

  test("exactly one pack owns the bare namespace", () => {
    const bare = tempPack({ name: "bare-extra", namespace: "" });
    expect(() => loadRegistry({ packRoots: [bare] })).toThrow(
      /exactly one pack must own the bare namespace.*event-runtime.*bare-extra/,
    );
  });

  test("config-listed packs cannot admit mutating agents", () => {
    const pack = tempPack();
    const defFile = path.join(pack.path, "agents", "echo.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...def, mutating: true }));
    expect(() => loadRegistry({ packRoots: [pack] })).toThrow(
      /config-listed pack.*may not declare mutating: true.*WM-468/,
    );
  });

  test("a pack agent that merely omits mutating is not refused by the pack rule (WM-470)", () => {
    // The pack restriction is on the declaration, not on its absence: only an
    // explicit `mutating: true` is refused (docs/kernel-and-packs.md). The
    // kernel's §14 admission rule is separate and still applies to every root,
    // so an omitting def must additionally be enforceable by construction.
    const pack = tempPack();
    const defFile = path.join(pack.path, "agents", "echo.json");
    const { mutating: _mutating, ...def } = JSON.parse(
      readFileSync(defFile, "utf8"),
    );
    writeFileSync(defFile, JSON.stringify(def));
    expect(() => loadRegistry({ packRoots: [pack] })).not.toThrow(
      /may not declare mutating: true/,
    );
    writeFileSync(defFile, JSON.stringify({ ...def, command: ["true"] }));
    const registry = loadRegistry({ packRoots: [pack] });
    expect(getAgent(registry, "sample/echo@1").mutating).toBeUndefined();
  });

  test("pack manifest and pins fail closed, and explicit pack pinning repairs drift", async () => {
    const pack = tempPack();
    const prompt = path.join(pack.path, "agents", "echo.md");
    writeFileSync(prompt, `${readFileSync(prompt, "utf8")}drift\n`);
    expect(() => loadRegistry({ packRoots: [pack] })).toThrow(
      /does not match pin/,
    );
    expect(await updatePins({ pack })).toEqual(["sample"]);
    expect(() => loadRegistry({ packRoots: [pack] })).not.toThrow();
    writeFileSync(path.join(pack.path, "pins.json"), "not-json\n");
    expect(await updatePins({ pack })).toEqual(["sample"]);
    expect(() => loadRegistry({ packRoots: [pack] })).not.toThrow();

    const mismatched = tempPack({ name: "policy-name" });
    writeFileSync(
      path.join(mismatched.path, "pack.json"),
      JSON.stringify({
        name: "manifest-name",
        version: "1.0.0",
        namespace: "sample",
      }),
    );
    expect(() => loadRegistry({ packRoots: [mismatched] })).toThrow(
      /does not match policy name/,
    );
  });

  test("loadPackRoots reads only policy-listed roots and validates fail-closed", () => {
    const root = tmpDir("event-policy-packs-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    const policy = path.join(root, "config", "policy.yaml");
    const packRoot = path.join(root, "vendor", "sample");
    expect(loadPackRoots({ root })).toEqual([]);

    writeFileSync(
      policy,
      "packs:\n  - name: sample\n    path: vendor/sample\n    namespace: sample\n",
    );
    expect(() => loadPackRoots({ root })).toThrow(
      /packs\[0\]\.path must be an absolute path/,
    );

    writeFileSync(
      policy,
      `packs:\n  - name: sample\n    path: ${JSON.stringify(packRoot)}\n    namespace: sample\n`,
    );
    expect(loadPackRoots({ root })).toEqual([
      {
        kind: "fs",
        name: "sample",
        path: packRoot,
        namespace: "sample",
      },
    ]);
    writeFileSync(policy, "packs:\n  sample: vendor/sample\n");
    expect(() => loadPackRoots({ root })).toThrow(/packs.*array/);
    writeFileSync(
      policy,
      `packs:\n  - name: sample\n    path: ${JSON.stringify(path.join(root, "one"))}\n  - name: sample\n    path: ${JSON.stringify(path.join(root, "two"))}\n`,
    );
    expect(() => loadPackRoots({ root })).toThrow(/duplicate pack name/);
  });

  test("update-pins --pack rejects missing and unknown pack names", () => {
    const run = (...args) =>
      Bun.spawnSync({
        cmd: [
          process.execPath,
          "event-runtime/cli.mjs",
          "update-pins",
          ...args,
        ],
        cwd: path.dirname(RUNTIME_ROOT),
        stdout: "pipe",
        stderr: "pipe",
      });
    const missing = run("--pack");
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain(
      "usage: update-pins [--pack NAME] [--check]",
    );

    const unknown = run("--pack", "not-configured");
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr.toString()).toContain(
      'unknown configured pack "not-configured"',
    );
  });

  test("editing a pinned file without re-pinning fails closed", async () => {
    const root = tempRegistry();
    const promptFile = path.join(root, "agents", "factory-status-report.md");
    writeFileSync(
      promptFile,
      `${readFileSync(promptFile, "utf8")}\n<!-- drift -->\n`,
    );
    expect(() => loadRegistry({ root })).toThrow(RegistryError);
    expect(await updatePins({ root, check: true })).toContain(
      "factory-status-report.json",
    );
    expect(() => loadRegistry({ root })).toThrow(RegistryError);
    await updatePins({ root });
    expect(() => loadRegistry({ root })).not.toThrow();
    expect(await updatePins({ root, check: true })).toEqual([]);
  });

  test("re-pinning a changed built-in definition leaves it Prettier-canonical (WM-1119)", async () => {
    const root = tempRegistry();
    // dispatch.json carries short arrays (capabilities.services/tools, memo
    // kinds) that Prettier keeps on one line but raw JSON.stringify(…, 2)
    // expands — the exact churn the issue reproduced.
    const defFile = path.join(root, "agents", "dispatch.json");
    const before = JSON.parse(readFileSync(defFile, "utf8"));
    // Resolve the repository's Prettier options (canonical for .json) so the
    // assertion mirrors what `prettier --check` would decide.
    const prettierOptions = {
      ...(await resolveConfig(
        path.join(RUNTIME_ROOT, "agents", "dispatch.json"),
      )),
      filepath: defFile,
    };
    const canonical = (content) => prettierFormat(content, prettierOptions);
    // Guard: the committed definition must start canonical, or the test is void.
    const original = readFileSync(defFile, "utf8");
    expect(await canonical(original)).toBe(original);

    // Force a real pin change by editing the pinned prompt.
    const promptFile = path.join(root, before.prompt);
    writeFileSync(
      promptFile,
      `${readFileSync(promptFile, "utf8")}\n<!-- WM-1119 -->\n`,
    );

    expect(await updatePins({ root })).toContain("dispatch.json");

    const written = readFileSync(defFile, "utf8");
    // Fails against origin/develop: JSON.stringify(…, 2) expands the short
    // arrays, so `prettier --check` would redden here.
    expect(await canonical(written)).toBe(written);

    // Only the pins moved; every other parsed field is byte-identical content.
    const after = JSON.parse(written);
    expect({ ...after, pins: undefined }).toEqual({
      ...before,
      pins: undefined,
    });
    expect(after.pins).not.toEqual(before.pins);

    // A second update is idempotent: no changed names, no byte changes.
    const bytes = readFileSync(defFile);
    expect(await updatePins({ root })).toEqual([]);
    expect(readFileSync(defFile)).toEqual(bytes);
  });

  test("mutating agents are refused in the MVP", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...def, mutating: true }));
    expect(() => loadRegistry({ root })).toThrow(/mutating/);
  });

  test("a mutating LLM agent over a tier-2 worktree workspace is admitted (dispatch design §6, WM-108)", () => {
    const registry = loadRegistry();
    const def = getAgent(registry, "dispatch@1");
    expect(def.mutating).toBe(true);
    expect(def.workspace.type).toBe("worktree");
    expect(getEventType(registry, "factory.dispatch.requested").agent).toBe(
      "dispatch@1",
    );
    // The carve-out is the workspace type, nothing wider: the same def on an
    // ephemeral workspace must still fail closed.
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "dispatch.json");
    const raw = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(
      defFile,
      JSON.stringify({ ...raw, workspace: { type: "ephemeral" } }),
    );
    expect(() => loadRegistry({ root })).toThrow(/mutating/);
  });

  test("dispatch declares ticket postmortem/decision and repo decision memos (WM-811, WM-812)", () => {
    const registry = loadRegistry();
    const dispatch = getAgent(registry, "dispatch@1");
    expect(dispatch.memos).toEqual([
      {
        subject: { type: "ticket", id: "$.input.ticket" },
        kinds: ["postmortem", "decision"],
        max: 10,
      },
      {
        subject: { type: "repo", id: "$.input.repo" },
        kinds: ["decision"],
        max: 10,
      },
    ]);
    expect(dispatch.inputSchema.properties.memoPin.required).toEqual([
      "foldedAt",
      "entries",
    ]);
    const postmortem = getAgent(registry, "run-postmortem@1");
    expect(postmortem.emits.memos).toEqual(["postmortem"]);
    expect(
      postmortem.outputSchema.properties.memos.items.properties.kind,
    ).toEqual({ const: "postmortem" });
    const mergeScan = getAgent(registry, "merge-scan@2");
    expect(mergeScan.memos).toEqual([
      {
        subject: { type: "repo", id: "$.input.repo" },
        kinds: ["decision"],
        max: 10,
      },
    ]);
  });

  test("dispatch input exposes the closed per-ticket modelTier vocabulary (WM-694)", () => {
    const schema = getAgent(loadRegistry(), "dispatch@1").inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.modelTier).toEqual({
      type: "string",
      enum: ["strong", "standard", "light"],
      description:
        "Optional per-dispatch model tier override; takes precedence over the ticket tier:* label and agent definition",
    });
  });

  test("agent-declared kernel control fields validate fail-closed (WM-469)", () => {
    const badEdgeRoot = tempRegistry();
    const applyFile = path.join(badEdgeRoot, "agents", "merge-apply.json");
    const apply = JSON.parse(readFileSync(applyFile, "utf8"));
    writeFileSync(
      applyFile,
      JSON.stringify({
        ...apply,
        chainCommandEdges: ["factory.not-registered"],
      }),
    );
    expect(() => loadRegistry({ root: badEdgeRoot })).toThrow(
      /chainCommandEdges targets unregistered event type factory\.not-registered/,
    );

    const badRepoMatchRoot = tempRegistry();
    const verifyFile = path.join(
      badRepoMatchRoot,
      "agents",
      "merge-verify.json",
    );
    const verify = JSON.parse(readFileSync(verifyFile, "utf8"));
    writeFileSync(
      verifyFile,
      JSON.stringify({ ...verify, chainRepoMustMatchInput: false }),
    );
    expect(() => loadRegistry({ root: badRepoMatchRoot })).toThrow(
      /"chainRepoMustMatchInput" must be true when present/,
    );

    const badExemptionRoot = tempRegistry();
    const exemptFile = path.join(
      badExemptionRoot,
      "agents",
      "merge-verify.json",
    );
    const exempt = JSON.parse(readFileSync(exemptFile, "utf8"));
    writeFileSync(
      exemptFile,
      JSON.stringify({ ...exempt, dispatchGateExempt: true }),
    );
    expect(() => loadRegistry({ root: badExemptionRoot })).toThrow(
      /"dispatchGateExempt" is admissible only for workspace\.type "worktree"/,
    );
  });

  test("every declared chainCommandEdges entry names a merged registered event type", () => {
    const loaded = loadRegistry();
    const declared = [...loaded.agents.values()].flatMap((def) =>
      (def.chainCommandEdges ?? []).map((eventType) => [def.ref, eventType]),
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const [agentRef, eventType] of declared) {
      expect(
        loaded.eventTypes[eventType],
        `${agentRef} -> ${eventType}`,
      ).toBeDefined();
    }
  });

  test("schedule payload must be a plain object without reserved tick fields (WM-72)", () => {
    const root = tempRegistry();
    const withPayload = (payload) =>
      writeFileSync(
        path.join(root, "schedules.json"),
        JSON.stringify({
          "reconcile-x": {
            every: "10m",
            eventType: "factory.reconcile.requested",
            payload,
            enabled: false,
          },
        }),
      );
    withPayload(["bj29"]);
    expect(() => loadRegistry({ root })).toThrow(/plain object/);
    withPayload({ slot: "2026-01-01T00:00:00.000Z" });
    expect(() => loadRegistry({ root })).toThrow(/reserved tick field/);
    withPayload({ repo: "bj29" });
    expect(() => loadRegistry({ root })).not.toThrow();
  });

  test("repos scope: malformed values fail closed at load, well-formed ones load (WM-64)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    const withRepos = (repos) =>
      writeFileSync(defFile, JSON.stringify({ ...def, repos }));

    withRepos("bj29"); // not an array
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);
    withRepos([]); // half-finished edit, not a deny-all
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);
    withRepos(["bj29", ""]); // empty string member
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);
    withRepos(["bj29", 7]); // non-string member
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);

    // Well-formed loads, and membership is deliberately NOT checked against
    // config/repos.yaml here — the planner owns that at plan time.
    withRepos(["bj29", "not-in-repos-yaml"]);
    const registry = loadRegistry({ root });
    expect(getAgent(registry, "factory-status-report@1").repos).toEqual([
      "bj29",
      "not-in-repos-yaml",
    ]);
  });

  test("model_tier: valid tiers load and are readable; absent field stays absent (WM-135)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...def, model_tier: "standard" }));
    // Every LLM route is "pi" since WM-215, so the pi map must cover every
    // tier any routed definition declares — event types outside this test's
    // own agent are validated too.
    const registry = loadRegistry({ root, modelTiers: PI_TIERS });
    expect(getAgent(registry, "factory-status-report@1").model_tier).toBe(
      "standard",
    );
    // A definition that declares nothing is untouched — adapter default.
    expect(getAgent(registry, "reconcile@1").model_tier).toBeUndefined();
    expect(getAgent(registry, "reconcile@1").model).toBeUndefined();
  });

  test("model_tier outside the closed enum fails at load (WM-135)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    for (const bad of ["medium", "opus-4", 3, null]) {
      writeFileSync(defFile, JSON.stringify({ ...def, model_tier: bad }));
      expect(() =>
        loadRegistry({
          root,
          modelTiers: { claude: { strong: "default", standard: "sonnet" } },
        }),
      ).toThrow(/"model_tier"/);
    }
  });

  test("declared tier with no mapping for the routed adapter fails closed at load (WM-135)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...def, model_tier: "light" }));
    // No pi tier map at all, and a map missing this one tier: both refuse.
    // (factory-status-report is the first routed event type in the file, so
    // its unmapped "light" is what the load trips on in both cases.)
    expect(() => loadRegistry({ root, modelTiers: {} })).toThrow(
      /no mapping for adapter "pi"/,
    );
    expect(() =>
      loadRegistry({
        root,
        modelTiers: {
          pi: {
            strong: "openai-codex/gpt-5.6-sol",
            standard: "openai-codex/gpt-5.6-terra",
          },
        },
      }),
    ).toThrow(/model_tier "light" has no mapping/);
  });

  test("a tier on a command/actions-routed agent is not applicable, never an error (WM-135)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "reconcile.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...def, model_tier: "light" }));
    // reconcile routes via the command adapter — "light" is resolved for no
    // adapter there, so the command route stays applicable either way.
    const registry = loadRegistry({ root, modelTiers: PI_TIERS });
    expect(
      resolveModel(
        getAgent(registry, "reconcile@1"),
        "command",
        registry.modelTiers,
      ),
    ).toBeNull();
  });

  test("model override: malformed rejected, well-formed wins over the tier (WM-135)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    const tiers = PI_TIERS;
    writeFileSync(defFile, JSON.stringify({ ...def, model: "" }));
    expect(() => loadRegistry({ root, modelTiers: tiers })).toThrow(/"model"/);
    writeFileSync(defFile, JSON.stringify({ ...def, model: 42 }));
    expect(() => loadRegistry({ root, modelTiers: tiers })).toThrow(/"model"/);

    // Both fields allowed; the override wins, and it also satisfies load even
    // though "light" has no mapping — the tier is never consulted.
    writeFileSync(
      defFile,
      JSON.stringify({ ...def, model: "claude-opus-4-1", model_tier: "light" }),
    );
    const registry = loadRegistry({ root, modelTiers: tiers });
    const loaded = getAgent(registry, "factory-status-report@1");
    expect(resolveModel(loaded, "claude", registry.modelTiers)).toBe(
      "claude-opus-4-1",
    );
  });

  test("resolveModel: override > tier map > adapter default; sentinel passes through (WM-135)", () => {
    const tiers = {
      claude: { strong: "default", standard: "sonnet", light: "haiku" },
    };
    expect(
      resolveModel({ ref: "x@1", model_tier: "standard" }, "claude", tiers),
    ).toBe("sonnet");
    expect(
      resolveModel({ ref: "x@1", model_tier: "strong" }, "claude", tiers),
    ).toBe(DEFAULT_MODEL);
    expect(
      resolveModel(
        { ref: "x@1", model: "haiku", model_tier: "strong" },
        "claude",
        tiers,
      ),
    ).toBe("haiku");
    expect(resolveModel({ ref: "x@1" }, "claude", tiers)).toBeNull(); // nothing declared → adapter default
    expect(
      resolveModel({ ref: "x@1", model_tier: "light" }, "command", tiers),
    ).toBeNull(); // not applicable
    expect(() =>
      resolveModel({ ref: "x@1", model_tier: "light" }, "claude", {}),
    ).toThrow(RegistryError);
  });

  test("loadModelTierMap: reads policy.yaml, validates shape fail-closed, tolerates absence (WM-135)", () => {
    const root = tmpDir("event-policy-");
    expect(loadModelTierMap({ root })).toEqual({}); // no policy.yaml at all
    mkdirSync(path.join(root, "config"), { recursive: true });
    const write = (yaml) =>
      writeFileSync(path.join(root, "config", "policy.yaml"), yaml);

    write("concurrency:\n  max_in_flight_per_repo: 3\n"); // no models block
    expect(loadModelTierMap({ root })).toEqual({});

    write(
      "models:\n  claude:\n    strong: default\n    standard: sonnet\n    light: haiku\n",
    );
    expect(loadModelTierMap({ root })).toEqual({
      claude: { strong: "default", standard: "sonnet", light: "haiku" },
    });

    write("models:\n  claude:\n    strnog: sonnet\n"); // typo'd tier key
    expect(() => loadModelTierMap({ root })).toThrow(/not a tier/);
    write("models:\n  claude:\n    standard: 7\n"); // non-string value
    expect(() => loadModelTierMap({ root })).toThrow(/non-empty model value/);
    write("models:\n  claude: sonnet\n"); // adapter entry not a map
    expect(() => loadModelTierMap({ root })).toThrow(/must map tiers/);
  });

  test("event type mapped to an unregistered agent fails closed", () => {
    const root = tempRegistry();
    writeFileSync(
      path.join(root, "event-types.json"),
      JSON.stringify({
        "x.y": { agent: "ghost@9", idempotencyScope: ["correlationId"] },
      }),
    );
    expect(() => loadRegistry({ root })).toThrow(/unregistered agent/);
  });

  test("artifact-view sidecars load beside their definition and are served off the pinned identity (WM-454)", async () => {
    const registry = loadRegistry();
    // The committed views: present, validated, keyed by ref, not on the def.
    const merge = getArtifactView(registry, "merge-scan@2");
    expect(merge.file).toBe("agents/merge-scan.view.json");
    expect(merge.source).toBe("agent");
    expect(merge.view.schemaVersion).toBe("factory.artifact-view/v1");
    expect(getArtifactView(registry, "triage-scan@1").view.status.path).toBe(
      "/recommendation",
    );
    const dispatch = getArtifactView(registry, "dispatch@1");
    expect(dispatch.source).toBe("agent");
    expect(dispatch.view.subject).toBe(
      "Dispatch {/ticket} · {/repo} · {model}",
    );
    expect(dispatch.view.summary).toBe("/summary");
    expect(dispatch.view.status.path).toBe("/outcome");
    expect(dispatch.view.status.tone.PR_OPEN).toBe("ok");
    expect(dispatch.view.sections.map((s) => s.path)).toEqual([
      "",
      "/verification",
      "/uxCritique",
    ]);
    const reconcile = getArtifactView(registry, "reconcile@1");
    expect(reconcile.source).toBe("contract");
    expect(reconcile.file).toBe(
      "agents/views/factory.command-result.v1.view.json",
    );
    expect(reconcile.view.title).toBe("Command");
    expect(getArtifactView(registry, "disk-diagnose@1")).toEqual({
      file: null,
      view: null,
      source: null,
    });
    expect(getArtifactView(registry, "ghost@9")).toEqual({
      file: null,
      view: null,
      source: null,
    });
    expect(registry.anomalies).toEqual([]);
    // Views are not part of the definition pin nor of the receipt defHash:
    // the def object never carries them, and the sidecar has no pin entry.
    const def = getAgent(registry, "merge-scan@2");
    expect(def.outputView).toBeUndefined();
    expect(Object.keys(def.pins)).not.toContain("agents/merge-scan.view.json");
    const { promptPath, inputSchema, outputSchema, ...pinnedIdentity } = def;
    expect(computeDefHash(def)).toBe(
      computeDefHash({
        ...pinnedIdentity,
        promptPath,
        inputSchema,
        outputSchema,
      }),
    );
    // A .view.json file is never mistaken for a definition, and re-pinning
    // leaves it alone.
    expect(
      [...registry.agents.keys()].some((ref) => ref.includes(".view")),
    ).toBe(false);
    const root = tempRegistry();
    expect(await updatePins({ root })).toEqual([]);
  });

  test("a view that drifts from its schema is a configuration anomaly, not a load error (WM-454)", () => {
    const root = tempRegistry();
    const viewFile = path.join(root, "agents", "merge-scan.view.json");
    const view = JSON.parse(readFileSync(viewFile, "utf8"));
    view.sections[0].columns.push("owner");
    view.status.path = "/verdict";
    writeFileSync(viewFile, JSON.stringify(view));
    const registry = loadRegistry({ root, modelTiers: PI_TIERS });
    // Served without a view; the anomaly names the agent, the file and the errors.
    expect(getArtifactView(registry, "merge-scan@2")).toEqual({
      file: "agents/merge-scan.view.json",
      view: null,
      source: null,
    });
    expect(registry.anomalies).toHaveLength(1);
    expect(registry.anomalies[0]).toContain("merge-scan@2");
    expect(registry.anomalies[0]).toContain("agents/merge-scan.view.json");
    expect(registry.anomalies[0]).toMatch(/"owner" does not resolve/);
    expect(registry.anomalies[0]).toMatch(/"\/verdict" does not resolve/);
    // Other agents' views are unaffected.
    expect(getArtifactView(registry, "triage-scan@1").view).not.toBeNull();
    // Unparseable JSON is the same class of anomaly.
    writeFileSync(viewFile, "{ not json");
    const again = loadRegistry({ root, modelTiers: PI_TIERS });
    expect(getArtifactView(again, "merge-scan@2").view).toBeNull();
    expect(again.anomalies[0]).toMatch(/unparseable/);
    // A schema-invalid document (bad `as`) is refused the same way.
    writeFileSync(
      viewFile,
      JSON.stringify({ ...view, sections: [{ path: "/plan", as: "chart" }] }),
    );
    expect(loadRegistry({ root, modelTiers: PI_TIERS }).anomalies[0]).toMatch(
      /not in enum/,
    );
  });

  test("contract-keyed fallback applies when the agent sidecar is absent; agent sidecar wins when both exist (WM-897)", () => {
    const root = tempRegistry();
    const registry = loadRegistry({ root, modelTiers: PI_TIERS });
    const shared = getArtifactView(registry, "reconcile@1");
    expect(shared.source).toBe("contract");
    expect(getArtifactView(registry, "warm@1").file).toBe(shared.file);
    expect(getArtifactView(registry, "ci-rerun@1").source).toBe("contract");
    // Agent sidecar wins even when a contract view exists.
    writeFileSync(
      path.join(root, "agents", "reconcile.view.json"),
      JSON.stringify({
        schemaVersion: "factory.artifact-view/v1",
        title: "Reconcile (agent)",
        sections: [{ path: "/command", as: "list", label: "Command" }],
      }),
    );
    const again = loadRegistry({ root, modelTiers: PI_TIERS });
    const won = getArtifactView(again, "reconcile@1");
    expect(won.source).toBe("agent");
    expect(won.file).toBe("agents/reconcile.view.json");
    expect(won.view.title).toBe("Reconcile (agent)");
    // A broken agent sidecar does not fall through to the contract view.
    writeFileSync(
      path.join(root, "agents", "reconcile.view.json"),
      JSON.stringify({
        schemaVersion: "factory.artifact-view/v1",
        sections: [{ path: "/nope", as: "prose" }],
      }),
    );
    const broken = loadRegistry({ root, modelTiers: PI_TIERS });
    expect(getArtifactView(broken, "reconcile@1")).toEqual({
      file: "agents/reconcile.view.json",
      view: null,
      source: null,
    });
    expect(broken.anomalies[0]).toMatch(/"\/nope" does not resolve/);
  });

  test("a sidecar with a bad input path / placeholder is a configuration anomaly (WM-897)", () => {
    const root = tempRegistry();
    writeFileSync(
      path.join(root, "agents", "dispatch.view.json"),
      JSON.stringify({
        schemaVersion: "factory.artifact-view/v1",
        subject: "Dispatch {/missing} · {model}",
        input: {
          sections: [{ path: "", as: "keyvalue", keys: ["nope"] }],
        },
      }),
    );
    const registry = loadRegistry({ root, modelTiers: PI_TIERS });
    expect(getArtifactView(registry, "dispatch@1").view).toBeNull();
    expect(registry.anomalies.join("\n")).toMatch(/dispatch@1/);
    expect(registry.anomalies.join("\n")).toMatch(/"nope" does not resolve/);
    expect(registry.anomalies.join("\n")).toMatch(
      /placeholder "\{\/missing\}"/,
    );
  });
});

describe("loadRegistry harnessRoots pin validation (WM-855)", () => {
  function harnessRoot(root) {
    const dir = path.join(root, "harness");
    mkdirSync(path.join(dir, "commands"), { recursive: true });
    writeFileSync(path.join(dir, "floor.md"), "floor v1\n");
    writeFileSync(path.join(dir, "commands", "hello.md"), "# hello\n");
    return {
      dir,
      name: "factory/core",
      version: "0.1.0",
      builtin: true,
      origin: "builtin",
      plugin: "core",
      prefix: null,
      floor: path.join(dir, "floor.md"),
      commands: path.join(dir, "commands"),
      skills: null,
      subagents: null,
    };
  }

  test("passes through unvalidated with no harnessRoots (default)", () => {
    expect(() => loadRegistry({ packRoots: [] })).not.toThrow();
  });

  test("loads when harness content matches its pin", () => {
    const root = tempRegistry();
    const harness = harnessRoot(root);
    updateHarnessPins({
      roots: [harness],
      file: path.join(root, "pins.json"),
    });
    expect(() =>
      loadRegistry({
        root,
        packRoots: [],
        modelTiers: PI_TIERS,
        harnessRoots: [harness],
      }),
    ).not.toThrow();
  });

  test("throws RegistryError when a harness root has no pin", () => {
    const root = tempRegistry();
    const harness = harnessRoot(root);
    const load = () =>
      loadRegistry({
        root,
        packRoots: [],
        modelTiers: PI_TIERS,
        harnessRoots: [harness],
      });
    expect(load).toThrow(RegistryError);
    expect(load).toThrow(
      /has no pin — run: bun event-runtime\/cli\.mjs update-pins/,
    );
  });

  test("throws RegistryError when harness content drifts from its pin", () => {
    const root = tempRegistry();
    const harness = harnessRoot(root);
    updateHarnessPins({
      roots: [harness],
      file: path.join(root, "pins.json"),
    });
    writeFileSync(path.join(harness.commands, "hello.md"), "# hello v2\n");
    expect(() =>
      loadRegistry({
        root,
        packRoots: [],
        modelTiers: PI_TIERS,
        harnessRoots: [harness],
      }),
    ).toThrow(/does not match pin/);
  });
});
