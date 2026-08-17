import { fail, pad, withClient } from "./shared.mjs";

function traceSummary(e) {
  const clip = (value, n = 120) => {
    const text = String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > n ? `${text.slice(0, n)}…` : text;
  };
  const p = e.payload ?? {};
  switch (e.kind) {
    case "assistant_text":
      return clip(p.text);
    case "tool_use":
      return `${p.name ?? "?"} ${clip(JSON.stringify(p.input ?? {}), 100)}`;
    case "tool_result":
      return `${p.isError ? "ERROR " : ""}${clip(p.content)}`;
    case "usage":
      return `${p.durationMs ?? "-"}ms   turns ${p.numTurns ?? "-"}   $${p.costUSD ?? "-"}`;
    default:
      return clip(JSON.stringify(p));
  }
}

/** Live agent trace (factory.trace/v1): what the agent said and ran. */
export async function trace(client, runId) {
  const view = await client.trace(runId, { limit: 500 });
  if (view.entries.length === 0) {
    console.log(`no trace recorded for run ${runId}`);
    return;
  }
  for (const e of view.entries) {
    console.log(`[${e.ts}] ${pad(e.kind, 16)}${traceSummary(e)}`);
  }
}

export default function traceCommand(args) {
  if (!args[0]) fail("usage: trace <run-id>");
  return withClient((client) => trace(client, args[0]));
}
