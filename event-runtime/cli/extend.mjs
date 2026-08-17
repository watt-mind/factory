import { fail, withClient } from "./shared.mjs";

export default function extend(args) {
  const runId = args[0];
  const secondsAt = args.indexOf("--seconds");
  const seconds = Number(secondsAt >= 0 ? args[secondsAt + 1] : NaN);
  if (!runId || !Number.isInteger(seconds) || seconds <= 0 || seconds > 3600) {
    fail("usage: extend <run-id> --seconds N [--override] (N must be 1..3600)");
  }
  return withClient(async (client) => {
    const outcome = await client.extend(runId, seconds, {
      override: args.includes("--override"),
    });
    console.log(`extended ${runId} by ${seconds}s; deadline ${outcome.deadlineAt}`);
  });
}
