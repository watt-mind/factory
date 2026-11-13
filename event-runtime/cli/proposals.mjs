import { pad, withClient } from "./shared.mjs";

function proposalRow(proposal) {
  const expired = proposal.expired === true;
  return {
    id: proposal.id,
    runId: proposal.runId,
    eventId: proposal.eventId,
    decision: proposal.decision,
    agent: proposal.agent,
    ttlSeconds: proposal.ttl_seconds,
    createdAt: proposal.created_at,
    expired,
    approvable: proposal.decision === "run" && !expired,
    reason: proposal.reason ?? null,
  };
}

export async function proposals(client, args = []) {
  const { proposals: open } = await client.proposals();
  const json = args.includes("--json");
  const rows = open.map(proposalRow);
  const displayed = args.includes("--approvable")
    ? rows.filter((row) => row.approvable)
    : rows;

  if (json) {
    console.log(JSON.stringify(displayed));
    return displayed;
  }
  if (displayed.length === 0) {
    console.log("no open proposals");
    return;
  }
  console.log(
    `${pad("ID", 42)}${pad("DECISION", 14)}${pad("AGENT", 26)}${pad("TTL", 8)}${pad("EXPIRED", 9)}REASON`,
  );
  for (const p of displayed) {
    console.log(
      `${pad(p.id, 42)}${pad(p.decision, 14)}${pad(p.agent, 26)}${pad(`${p.ttlSeconds}s`, 8)}${pad(p.expired ? "yes" : "no", 9)}${p.reason ?? "-"}`,
    );
  }
  console.log(`\napprove with: bun event-runtime/cli.mjs approve <id>`);
}

export default function proposalsCommand(args) {
  return withClient((client) => proposals(client, args));
}
