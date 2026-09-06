/** Agent and repository registry endpoints. */
import {
  RegistryError,
  getArtifactView,
  loadModelTierMap,
  resolveModel,
} from "./registry.mjs";
import {
  RepoError,
  reposRoot,
  resolvePromotionTarget,
  reposView,
} from "./repos.mjs";
import {
  KIND_AGENT,
  KIND_EVENT_TYPE,
  KIND_MODEL_TIER_CELL,
  OverlayError,
  applyPromotion,
  buildPromotionPreview,
  deleteOverride,
  emptyOverrides,
  knownAdapters,
  listOverrideJournal,
  listOverrides,
  mergeAgentPatch,
  modelTierCellKey,
  modelTierCellResult,
  modelTierConfigView,
  overlayForAgent,
  overlayForEventType,
  plannedDef,
  putOverride,
  validateAgentPatch,
  validateEventTypePatch,
  validateModelTierCellPatch,
} from "./runtime-overrides.mjs";

export function agentsView(registry, { overrides = emptyOverrides() } = {}) {
  const adapters = [...knownAdapters(registry)].sort();
  return {
    adapters,
    agents: [...registry.agents.values()].map((def) => {
      const agentPatch = overlayForAgent(overrides, def.ref) ?? {};
      const modelTierOverride = Object.hasOwn(agentPatch, "modelTier")
        ? agentPatch.modelTier
        : undefined;
      const modelOverride = Object.hasOwn(agentPatch, "model")
        ? agentPatch.model
        : undefined;
      const planned = plannedDef(def, { modelTierOverride, modelOverride });
      return {
        ref: def.ref,
        id: def.id,
        pack: def.pack && def.pack !== "default" ? def.pack : null,
        version: def.version,
        outputContract: def.output_contract,
        workspace: def.workspace,
        capabilities: def.capabilities,
        limits: def.limits,
        mutating: def.mutating,
        promptFile: def.prompt,
        prompt: def.promptText,
        inputSchemaFile: def.input_schema,
        inputSchema: def.inputSchema,
        outputSchemaFile: def.output_schema,
        outputSchema: def.outputSchema,
        // Artifact-view sidecar (WM-454 / WM-897): null when the agent has
        // none or its view failed the drift check (then /status names the
        // anomaly). `view.source` says whether the agent file or the
        // contract-keyed fallback applied.
        outputViewFile: getArtifactView(registry, def.ref).file,
        outputView: getArtifactView(registry, def.ref).view,
        view: (() => {
          const source = getArtifactView(registry, def.ref).source;
          return source ? { source } : null;
        })(),
        pins: def.pins,
        command: def.command ?? null,
        actionRegistry: def.actionRegistry ?? null,
        hosts: def.hosts ? Object.keys(def.hosts) : null,
        repos: def.repos ?? null,
        declaredModelTier: def.model_tier ?? null,
        modelTier: planned.model_tier ?? null,
        declaredModel: def.model ?? null,
        model: planned.model ?? null,
        eventTypes: Object.entries(registry.eventTypes)
          .filter(([, mapping]) => mapping.agent === def.ref)
          .map(([type, mapping]) => {
            const adapter =
              overlayForEventType(overrides, type)?.adapter ?? mapping.adapter;
            return {
              type,
              declaredAdapter: mapping.adapter,
              adapter,
              idempotencyScope: mapping.idempotencyScope,
              proposalTtlSeconds: mapping.proposalTtlSeconds ?? null,
              resolvedModel: resolveModel(
                planned,
                adapter,
                registry.modelTiers,
              ),
            };
          }),
      };
    }),
    edges: registry.edges ?? {},
    eventTypes: Object.entries(registry.eventTypes).map(([type, mapping]) => ({
      type,
      agent: mapping.agent,
      declaredAdapter: mapping.adapter,
      adapter: overlayForEventType(overrides, type)?.adapter ?? mapping.adapter,
      idempotencyScope: mapping.idempotencyScope,
      proposalTtlSeconds: mapping.proposalTtlSeconds ?? null,
    })),
    contracts: {
      "factory.event/v1": registry.schemas.envelope,
      "factory.agent-result/v1": registry.schemas.agentResult,
    },
    overrides,
  };
}

function sendOverlayError(send, err) {
  if (err instanceof OverlayError)
    return send(err.status, { error: err.message });
  // The tracked model map is reread from disk per request; a corrupt
  // policy.yaml is an operator-fixable 500, not an uncaught handler throw.
  if (err instanceof RegistryError)
    return send(500, {
      error: `tracked policy.yaml is unreadable: ${err.message}`,
    });
  throw err;
}

export async function handleRegistryApiRoute({
  route,
  req,
  url,
  send,
  readBody,
  parseJson,
  registry,
  repos,
  janitor,
  actor,
  db,
  nowMs,
  promotionSeams,
}) {
  if (route === "GET /agents") {
    const overrides = db ? listOverrides(db) : emptyOverrides();
    return send(200, agentsView(registry, { overrides }));
  }

  if (route === "GET /overrides/config") {
    try {
      // The tracked map is hot-reloadable policy input. The registry keeps its
      // startup snapshot for execution, while both configuration endpoints
      // read this disk source so their operator-facing views cannot drift.
      const trackedModelTiers = loadModelTierMap({ root: reposRoot() });
      return send(200, modelTierConfigView(db, trackedModelTiers));
    } catch (err) {
      return sendOverlayError(send, err);
    }
  }

  const modelCellPath = url.pathname.match(
    /^\/overrides\/config\/models\/([^/]+)\/([^/]+)$/,
  );
  if (modelCellPath && (req.method === "PUT" || req.method === "DELETE")) {
    try {
      const trackedModelTiers = loadModelTierMap({ root: reposRoot() });
      let adapter;
      let tier;
      try {
        adapter = decodeURIComponent(modelCellPath[1]);
        tier = decodeURIComponent(modelCellPath[2]);
      } catch {
        throw new OverlayError(
          422,
          "model adapter and tier must use valid URL encoding",
        );
      }
      // Validate URL vocabulary on DELETE too; an unknown cell is not an
      // idempotent absence because it can never be a valid stored key.
      validateModelTierCellPatch(adapter, tier, { model: "validation" });
      const key = modelTierCellKey(adapter, tier);
      if (req.method === "DELETE") {
        const result = deleteOverride(db, {
          kind: KIND_MODEL_TIER_CELL,
          key,
          actor,
          now: nowMs,
        });
        return send(
          200,
          modelTierCellResult(db, trackedModelTiers, adapter, tier, result),
        );
      }
      const parsed = parseJson(await readBody(req));
      if (parsed.error) return send(422, { error: parsed.error });
      const patch = validateModelTierCellPatch(adapter, tier, parsed.value);
      putOverride(db, {
        kind: KIND_MODEL_TIER_CELL,
        key,
        patch,
        actor,
        now: nowMs,
      });
      return send(
        200,
        modelTierCellResult(db, trackedModelTiers, adapter, tier),
      );
    } catch (err) {
      return sendOverlayError(send, err);
    }
  }

  // Overlay promotion preview (gh-860): read-only snapshot of the promotable
  // override rows against tracked definitions, with the digest an apply must
  // echo back. Never touches the checkout.
  if (route === "GET /promotion/preview") {
    try {
      return send(200, buildPromotionPreview({ db, registry }));
    } catch (err) {
      return sendOverlayError(send, err);
    }
  }

  // Overlay promotion apply (gh-860): requires the confirmed digest and a
  // non-empty selected-key subset, and drives the injected isolated-checkout
  // seams. An empty selection is a typed no-op; unconfigured seams fail closed.
  if (route === "POST /promotion/apply") {
    const parsed = parseJson(await readBody(req));
    if (parsed.error) return send(422, { error: parsed.error });
    const body = parsed.value ?? {};
    if (typeof body.repo !== "string" || body.repo.trim() === "") {
      return send(422, { error: "repo is required" });
    }
    if (!Array.isArray(body.keys)) {
      return send(422, { error: "keys must be an array" });
    }
    let target;
    try {
      target = resolvePromotionTarget(repos(), body.repo);
    } catch (err) {
      if (err instanceof RepoError) return send(422, { error: err.message });
      throw err;
    }
    try {
      const result = await applyPromotion({
        db,
        registry,
        target,
        digest: body.digest,
        keys: body.keys,
        seams: promotionSeams ?? {},
        actor,
      });
      return send(200, { actor, repo: target.name, ...result });
    } catch (err) {
      if (err instanceof OverlayError) {
        const payload = { error: err.message };
        if (err.evidence) payload.evidence = err.evidence;
        return send(err.status, payload);
      }
      throw err;
    }
  }

  if (route === "GET /overrides") {
    return send(200, {
      ...listOverrides(db),
      journal: listOverrideJournal(db),
    });
  }

  const eventTypePath = url.pathname.match(/^\/overrides\/event-types\/(.+)$/);
  if (eventTypePath && (req.method === "PUT" || req.method === "DELETE")) {
    const type = decodeURIComponent(eventTypePath[1]);
    try {
      if (req.method === "DELETE") {
        return send(
          200,
          deleteOverride(db, {
            kind: KIND_EVENT_TYPE,
            key: type,
            actor,
            now: nowMs,
          }),
        );
      }
      const parsed = parseJson(await readBody(req));
      if (parsed.error) return send(422, { error: parsed.error });
      const patch = validateEventTypePatch(registry, type, parsed.value);
      return send(
        200,
        putOverride(db, {
          kind: KIND_EVENT_TYPE,
          key: type,
          patch,
          actor,
          now: nowMs,
        }),
      );
    } catch (err) {
      return sendOverlayError(send, err);
    }
  }

  const agentPath = url.pathname.match(/^\/overrides\/agents\/(.+)$/);
  if (agentPath && (req.method === "PUT" || req.method === "DELETE")) {
    const ref = decodeURIComponent(agentPath[1]);
    try {
      if (req.method === "DELETE") {
        return send(
          200,
          deleteOverride(db, { kind: KIND_AGENT, key: ref, actor, now: nowMs }),
        );
      }
      const parsed = parseJson(await readBody(req));
      if (parsed.error) return send(422, { error: parsed.error });
      const incoming = validateAgentPatch(registry, ref, parsed.value);
      const existing = overlayForAgent(listOverrides(db), ref);
      const patch = mergeAgentPatch(existing, incoming);
      if (!patch) {
        return send(
          200,
          deleteOverride(db, { kind: KIND_AGENT, key: ref, actor, now: nowMs }),
        );
      }
      return send(
        200,
        putOverride(db, {
          kind: KIND_AGENT,
          key: ref,
          patch,
          actor,
          now: nowMs,
        }),
      );
    } catch (err) {
      return sendOverlayError(send, err);
    }
  }

  if (route === "GET /repos") {
    try {
      return send(200, { repos: reposView(repos()) });
    } catch (err) {
      if (err instanceof RepoError) return send(500, { error: err.message });
      throw err;
    }
  }

  const janitorPost = url.pathname.match(/^\/repos\/([^/]+)\/janitor$/);
  if (req.method === "POST" && janitorPost) {
    const name = decodeURIComponent(janitorPost[1]);
    let repoRegistry;
    try {
      repoRegistry = repos();
    } catch (err) {
      if (err instanceof RepoError) return send(500, { error: err.message });
      throw err;
    }
    const repo = repoRegistry.get(name);
    if (!repo) return send(404, { error: `unknown repo ${name}` });
    const body = parseJson(await readBody(req)).value ?? {};
    if (body.apply !== undefined && typeof body.apply !== "boolean") {
      return send(422, { error: "apply must be a boolean" });
    }
    const apply = body.apply === true;
    if (apply && repo.reportOnly && !repo.worktreeDown) {
      return send(409, {
        error: `report-only repo "${name}" has no worktree_down script; refusing apply`,
      });
    }
    try {
      const result = await janitor(name, { apply, repo, actor });
      return send(200, { actor, apply, ...result });
    } catch (err) {
      const status = Number.isInteger(err.status) ? err.status : 500;
      if (status === 500) return send(500, { error: "internal_error" });
      return send(status, { error: err.message });
    }
  }

  return false;
}
