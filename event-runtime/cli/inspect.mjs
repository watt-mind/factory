import { inspectHeader } from "../lib/artifact-view.mjs";
import { fail, pad, withClient } from "./shared.mjs";
import { spendLine } from "./status.mjs";

/**
 * The view sidecar for this run's agent, from `GET /agents` (WM-454), or
 * null when the agent ships none — or when the registry cannot be read:
 * `inspect` is a read of one run and must not fail because the header
 * garnish did.
 */
async function viewFor(client, agentRef) {
  if (typeof client.agents !== "function") return null;
  try {
    const { agents = [] } = await client.agents();
    const def = agents.find((a) => a.ref === agentRef || a.id === agentRef);
    return def?.outputView ?? null;
  } catch {
    return null;
  }
}

export async function inspect(client, runId) {
  return renderInspect(await client.run(runId), client);
}

/** Render one already-fetched run detail for every inspect entry point. */
export async function renderInspect(view, client) {
  const { run } = view;
  console.log(`run        ${run.runId}`);
  console.log(
    `state      ${run.state}   attempts ${run.attempts}/${run.spec.maxAttempts}`,
  );
  console.log(
    `agent      ${run.spec.agent}   adapter ${run.spec.adapter}   contract ${run.spec.outputContract}`,
  );
  console.log(`created    ${run.created_at}   updated ${run.updated_at}`);
  console.log(`workspace  ${view.workspace ?? "-"}`);
  if (view.usage) {
    console.log("\nusage");
    console.log(`  ${spendLine("total", view.usage.totals).trimStart()}`);
    for (const row of view.usage.attempts ?? []) {
      console.log(
        `  ${spendLine(`attempt ${row.attempt}`, row).trimStart()}   model ${row.model ?? "-"}   adapter ${row.adapter}`,
      );
    }
  }
  console.log("\nlifecycle");
  for (const e of view.lifecycle) {
    console.log(
      `  ${pad(e.at, 26)}${pad(`${e.from_state ?? "·"} → ${e.to_state}`, 26)}${pad(e.actor, 24)}${e.reason ?? ""}`,
    );
  }
  if (view.result) {
    console.log("\nresult");
    // The view's summary and status first (WM-455): what the artifact says,
    // before the JSON that says it.
    if (view.result.artifact !== undefined) {
      const artifactView = await viewFor(client, run.spec.agent);
      for (const line of inspectHeader(artifactView, view.result.artifact))
        console.log(`  ${line}`);
    }
    console.log(
      `  terminalState ${view.result.terminalState}   reason ${view.result.reasonCode ?? "-"}`,
    );
    if (view.result.artifact !== undefined)
      console.log(`  artifact ${JSON.stringify(view.result.artifact)}`);
  }
  if (view.receipt) {
    console.log("\nreceipt");
    for (const [k, v] of Object.entries(view.receipt))
      console.log(`  ${pad(k, 20)}${v ?? "-"}`);
  }
  if (view.result?.artifacts?.length) {
    console.log("\nartifacts");
    for (const a of view.result.artifacts) {
      console.log(
        `  ${pad(a.kind, 14)}${pad(a.sizeBytes != null ? `${a.sizeBytes}B` : "-", 10)}${pad(a.sha256, 66)}${a.uri}`,
      );
    }
  }
}

export default function inspectCommand(args) {
  if (!args[0]) fail("usage: inspect <run-id>");
  return withClient((client) => inspect(client, args[0]));
}
