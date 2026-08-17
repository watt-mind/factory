/** Agent and repository registry endpoints. */
import { readFileSync } from "node:fs";
import { resolveModel } from "./registry.mjs";
import { RepoError, reposView } from "./repos.mjs";

export function agentsView(registry) {
  return {
    agents: [...registry.agents.values()].map((def) => ({
      ref: def.ref,
      id: def.id,
      version: def.version,
      outputContract: def.output_contract,
      workspace: def.workspace,
      capabilities: def.capabilities,
      limits: def.limits,
      mutating: def.mutating,
      promptFile: def.prompt,
      prompt: readFileSync(def.promptPath, "utf8"),
      inputSchemaFile: def.input_schema,
      inputSchema: def.inputSchema,
      outputSchemaFile: def.output_schema,
      outputSchema: def.outputSchema,
      pins: def.pins,
      command: def.command ?? null,
      actionRegistry: def.actionRegistry ?? null,
      hosts: def.hosts ? Object.keys(def.hosts) : null,
      repos: def.repos ?? null,
      modelTier: def.model_tier ?? null,
      model: def.model ?? null,
      eventTypes: Object.entries(registry.eventTypes)
        .filter(([, mapping]) => mapping.agent === def.ref)
        .map(([type, mapping]) => ({
          type,
          adapter: mapping.adapter,
          idempotencyScope: mapping.idempotencyScope,
          proposalTtlSeconds: mapping.proposalTtlSeconds ?? null,
          resolvedModel: resolveModel(
            def,
            mapping.adapter,
            registry.modelTiers,
          ),
        })),
    })),
    edges: registry.edges ?? {},
    eventTypes: Object.entries(registry.eventTypes).map(([type, mapping]) => ({
      type,
      agent: mapping.agent,
      adapter: mapping.adapter,
      idempotencyScope: mapping.idempotencyScope,
      proposalTtlSeconds: mapping.proposalTtlSeconds ?? null,
    })),
    contracts: {
      "factory.event/v1": registry.schemas.envelope,
      "factory.agent-result/v1": registry.schemas.agentResult,
    },
  };
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
}) {
  if (route === "GET /agents") return send(200, agentsView(registry));

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
