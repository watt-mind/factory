import { readFileSync } from "node:fs";
import { fail, withClient } from "./shared.mjs";

export async function inject(client, file) {
  const raw = readFileSync(file === "-" ? 0 : file, "utf8");
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (err) {
    fail(`inject: ${file} is not valid JSON: ${err.message}`);
  }
  const outcome = await client.replay(envelope);
  console.log(
    outcome.duplicate
      ? `duplicate — event ${outcome.eventId} was already admitted`
      : `admitted event ${outcome.eventId}`,
  );
}

export default function injectCommand(args) {
  if (!args[0]) fail("usage: inject <envelope.json|->");
  return withClient((client) => inject(client, args[0]));
}
