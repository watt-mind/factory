import { pad, withClient } from "./shared.mjs";

export async function proposals(client) {
  const { proposals: open } = await client.proposals();
  if (open.length === 0) {
    console.log("no open proposals");
    return;
  }
  console.log(
    `${pad("ID", 42)}${pad("DECISION", 14)}${pad("AGENT", 26)}${pad("TTL", 8)}${pad("EXPIRED", 9)}REASON`,
  );
  for (const p of open) {
    console.log(
      `${pad(p.id, 42)}${pad(p.decision, 14)}${pad(p.agent, 26)}${pad(`${p.ttl_seconds}s`, 8)}${pad(p.expired ? "yes" : "no", 9)}${p.reason ?? "-"}`,
    );
  }
  console.log(`\napprove with: bun event-runtime/cli.mjs approve <id>`);
}

export default function proposalsCommand(args) {
  return withClient((client) => proposals(client));
}
