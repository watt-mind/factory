import { fail, withClient } from "./shared.mjs";

export default function retry(args) {
  if (!args[0]) fail("usage: retry <run-id> [--force]");
  return withClient(async (client) => {
    await client.retry(args[0], { force: args.includes("--force") });
    console.log(`re-queued ${args[0]}`);
  });
}
