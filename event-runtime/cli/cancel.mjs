import { fail, withClient } from "./shared.mjs";

export default function cancel(args) {
  if (!args[0]) fail("usage: cancel <run-id> [reason]");
  return withClient(async (client) => {
    const res = await client.cancel(args[0], args[1]);
    if (res?.ambiguousOpenProposals?.length) {
      console.log(
        `cancelled ${args[0]} (warning: ${res.ambiguousOpenProposals[0].count} open proposals remain ambiguous)`,
      );
    } else {
      console.log(`cancelled ${args[0]}`);
    }
  });
}
