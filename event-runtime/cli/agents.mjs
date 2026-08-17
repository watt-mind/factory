import { pad, withClient } from "./shared.mjs";

export async function agents(client) {
  const { agents: defs } = await client.agents();
  for (const d of defs) {
    console.log(
      `${d.ref}   contract ${d.outputContract}   mutating ${d.mutating}   timeout ${d.limits.timeout_seconds}s   attempts ${d.limits.attempts}`,
    );
    console.log(
      `  capabilities  ${d.capabilities.filesystem}; ${(d.capabilities.services ?? []).join(", ") || "-"}`,
    );
    if (d.modelTier || d.model) {
      // Declared intent (WM-135); the per-route resolved value rides on each
      // event type line below, since resolution is per adapter.
      const parts = [];
      if (d.modelTier) parts.push(`tier ${d.modelTier}`);
      if (d.model) parts.push(`override ${d.model}`);
      console.log(`  model         ${parts.join("   ")}`);
    }
    console.log(
      `  files         ${d.promptFile}, ${d.inputSchemaFile}, ${d.outputSchemaFile}`,
    );
    for (const t of d.eventTypes) {
      const model =
        t.resolvedModel != null ? `   model ${t.resolvedModel}` : "";
      console.log(
        `  event type    ${t.type}   adapter ${t.adapter}   scope ${t.idempotencyScope.join("+")}   ttl ${t.proposalTtlSeconds ?? "-"}s${model}`,
      );
    }
  }
}

export default function agentsCommand(args) {
  return withClient((client) => agents(client));
}
