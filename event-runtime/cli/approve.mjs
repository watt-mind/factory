import { fail, withClient } from "./shared.mjs";

/**
 * The control API's refusal code for a proposal whose stored envelope or spec
 * JSON no longer parses (lib/proposals.mjs MalformedStoredRowError). Re-running
 * approve cannot clear it, so the CLI says so instead of reporting a re-plan.
 */
const MALFORMED_STORED_ROW = "malformed_stored_row";

export async function approveProposal(client, id) {
  let outcome;
  try {
    outcome = await client.approve(id);
  } catch (err) {
    if (err?.body?.reason !== MALFORMED_STORED_ROW) throw err;
    throw new Error(
      `proposal ${id} cannot be approved — its stored row is corrupt (${err.body.kind ?? MALFORMED_STORED_ROW}); repair or reject the proposal, approving again will not clear it`,
      { cause: err },
    );
  }
  if (outcome.approved) console.log(`approved — run ${outcome.runId} queued`);
  else
    console.log(
      `proposal expired and re-planned — review and approve the new proposal ${outcome.proposal.id}`,
    );
  return outcome;
}

export default function approve(args) {
  if (!args[0]) fail("usage: approve <proposal-id>");
  return withClient((client) => approveProposal(client, args[0]));
}
