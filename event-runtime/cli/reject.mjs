import { fail, withClient } from "./shared.mjs";

export default function reject(args) {
  if (!args[0] || !args[1]) fail('usage: reject <proposal-id> "<reason>"');
  return withClient(async (client) => {
    await client.reject(args[0], args[1]);
    console.log(`rejected ${args[0]}`);
  });
}
