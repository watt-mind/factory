import { fail, withClient } from "./shared.mjs";

export default function requeue(args) {
  if (!args[0] || !args[1]) fail("usage: requeue <source> <event-id>");
  return withClient(async (client) => {
    await client.requeue(args[0], args[1]);
    console.log(`requeued (${args[0]}, ${args[1]}) — will be re-planned`);
  });
}
