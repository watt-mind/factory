import { fail, withClient } from "./shared.mjs";

export default function approve(args) {
  if (!args[0]) fail("usage: approve <proposal-id>");
  return withClient(async (client) => {
    const outcome = await client.approve(args[0]);
    if (outcome.approved) console.log(`approved — run ${outcome.runId} queued`);
    else
      console.log(
        `proposal expired and re-planned — review and approve the new proposal ${outcome.proposal.id}`,
      );
  });
}
