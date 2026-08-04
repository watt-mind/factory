/**
 * One parser for every harness's transcript.
 *
 * run-agent.sh dispatches to claude, codex, pi and agy, and each streams a
 * DIFFERENT JSON schema for the same events. That is fine until something reads
 * the logs, at which point a Claude-only parser silently reports every other
 * harness as "0 turns, $0, no result" — indistinguishable from a harness that
 * genuinely did nothing. On 2026-08-04 that hid 109 codex runs and 50 agy runs
 * (35% of all runs) from `lib/spend.mjs`, so the per-day budget gate was
 * measuring roughly two thirds of the factory and calling it the whole.
 *
 * So the schemas are normalised in ONE place, and every consumer imports it.
 * Adding a harness means teaching this file, not each caller.
 *
 * Schemas, for the record:
 *   claude  {type:"assistant",message:{usage,content}} + {type:"result",total_cost_usd,...}
 *   codex   {type:"item.started"|"item.completed",item:{...}} + {type:"turn.completed",usage}
 *   agy     {event:"init"|"step_update"} + {event:"result",result:{status,error,usage}}
 *   pi      {type:"message",message:{role,content}} + {type:"result",result:{exitCode,tokens}}
 */
import { homedir } from "node:os";
import path from "node:path";

export const LOG_DIR = path.join(homedir(), ".factory/logs");
export const METRICS_DIR = path.join(homedir(), ".factory/metrics");
export const ROLLUP = path.join(METRICS_DIR, "runs.jsonl");

const oneLine = (s, n = 120) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// Sonnet-ish per-token rates, used ONLY for harnesses that report no cost of
// their own. Wrong by a constant factor is fine; blind to a whole harness is
// not — that is the failure this exists to prevent.
const RATE = { in: 3e-6, out: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6 };

export const estimateUSD = (r) =>
  (r.in ?? 0) * RATE.in + (r.out ?? 0) * RATE.out +
  (r.cacheRead ?? 0) * RATE.cacheRead + (r.cacheWrite ?? 0) * RATE.cacheWrite;

/** Group an error by the SHAPE of the failure — paths and ids differ per run
 *  and would otherwise fragment one recurring bug into a list of singletons. */
export const errorSignature = (body) =>
  oneLine(body, 70)
    .replace(/\/[\w./-]+/g, "<path>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<sha>")
    .replace(/\d+/g, "N");

/**
 * Group a HARNESS-level error message by shape.
 *
 * Deliberately lighter than errorSignature: a harness error is a sentence, not
 * a tool dump, and the path normaliser would rewrite the useful part —
 * "Unknown command: /factory-ticket" collapses to "Unknown command: <path>",
 * hiding which command is missing. Only the varying numbers are erased, which
 * is what actually fragments these ("resets in 44h1m15s" vs "44h21m16s").
 */
export const messageSignature = (msg) =>
  oneLine(msg, 90).replace(/\d+/g, "N");

/** `bj29-CLNT-616-20260804-101500.jsonl` -> repo bj29, stage ticket. */
export function identify(file) {
  const base = file.replace(/\.+jsonl$/, "");
  const repo = base.split("-")[0];
  const m = base.match(/-(factory-[a-z]+)-/);
  const stage = m ? m[1] : /-[A-Z]{2,}-\d+-/.test(base) ? "ticket" : "other";
  const ticket = (base.match(/-([A-Z]{2,}-\d+)-/) ?? [])[1] ?? null;
  return { repo, stage, ticket };
}

/**
 * Parse one transcript into a normalised Run record.
 *
 * `weighted` is the number that explains the bill. A tool result is not paid for
 * once — it sits in the context window and is re-sent on every later turn of the
 * session. So a 600KB screenshot taken at turn 5 of a 40-turn run costs roughly
 * 35 times its size in cache traffic. Weighting each payload by the turns that
 * remained after it is the cheapest honest approximation of that, and it ranks
 * tools very differently than raw payload does.
 */
export function parseRun(file, text, mtimeMs = 0) {
  const { repo, stage, ticket } = identify(file);
  const run = {
    file, repo, stage, ticket, harness: "unknown", mtime: mtimeMs,
    in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    turns: 0, tools: 0, errors: 0, durMs: 0,
    ok: null, error: null, truncated: false, wasted: false,
    resultBytes: 0, weightedBytes: 0,
    toolCalls: new Map(), toolResultBytes: new Map(), errorSigs: new Map(), commands: new Map(),
  };

  const pending = new Map();       // tool_use_id -> {name, brief}
  const payloads = [];             // {name, bytes, atTurn}
  let sawEnvelope = false;
  let sawAnyEvent = false;

  const bumpTool = (name) => {
    run.tools++;
    run.toolCalls.set(name, (run.toolCalls.get(name) ?? 0) + 1);
  };
  const bumpResult = (name, bytes) => {
    run.resultBytes += bytes;
    payloads.push({ name, bytes, atTurn: run.tools });
  };

  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    sawAnyEvent = true;

    // ---------------------------------------------------------- claude ----
    if (e.type === "assistant" && e.message) {
      run.harness = "claude";
      const u = e.message.usage ?? {};
      run.in += u.input_tokens ?? 0;
      run.out += u.output_tokens ?? 0;
      run.cacheRead += u.cache_read_input_tokens ?? 0;
      run.cacheWrite += u.cache_creation_input_tokens ?? 0;
      for (const part of e.message.content ?? []) {
        if (part.type !== "tool_use") continue;
        bumpTool(part.name);
        const brief = oneLine(part.input?.command ?? part.input?.file_path ?? part.input?.pattern ?? "", 120);
        pending.set(part.id, { name: part.name, brief });
        if (part.name === "Bash" && brief) run.commands.set(brief, (run.commands.get(brief) ?? 0) + 1);
      }
      continue;
    }
    if (e.type === "user" && e.message) {
      for (const part of e.message.content ?? []) {
        if (part.type !== "tool_result") continue;
        const src = pending.get(part.tool_use_id) ?? { name: "?", brief: "" };
        const body = typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
        bumpResult(src.name, body.length);
        if (!part.is_error) continue;
        run.errors++;
        const sig = `${src.name}|${errorSignature(body)}`;
        const hit = run.errorSigs.get(sig) ?? { count: 0, tool: src.name, sample: oneLine(body, 110) };
        hit.count++;
        run.errorSigs.set(sig, hit);
      }
      continue;
    }

    // ------------------------------------------------------------ codex ----
    if (typeof e.type === "string" && e.type.startsWith("item.")) {
      run.harness = "codex";
      const item = e.item ?? {};
      if (e.type === "item.started") {
        if (item.type === "command_execution") {
          bumpTool("Bash");
          const brief = oneLine(item.command, 120);
          if (brief) run.commands.set(brief, (run.commands.get(brief) ?? 0) + 1);
        } else if (item.type === "mcp_tool_call") {
          bumpTool(item.tool ?? "mcp");
        } else if (item.type === "file_change" || item.type === "patch") {
          bumpTool("Edit");
        }
      }
      if (e.type === "item.completed") {
        const body = String(item.aggregated_output ?? item.text ?? item.output ?? "");
        if (body) bumpResult(item.type === "command_execution" ? "Bash" : (item.tool ?? item.type), body.length);
        // Codex reports a shell failure as a non-zero exit_code, not an error flag.
        if (item.exit_code != null && item.exit_code !== 0) {
          run.errors++;
          const sig = `Bash|${errorSignature(body || `exit ${item.exit_code}`)}`;
          const hit = run.errorSigs.get(sig) ?? { count: 0, tool: "Bash", sample: oneLine(body, 110) };
          hit.count++;
          run.errorSigs.set(sig, hit);
        }
      }
      continue;
    }
    if (e.type === "turn.completed") {
      run.harness = "codex";
      sawEnvelope = true;
      const u = e.usage ?? {};
      // Codex's input_tokens is the whole-turn total and INCLUDES the cached
      // part, unlike Claude's, where the three fields are disjoint. Subtract, or
      // the same tokens get counted twice and the cache ratio reads as perfect.
      run.cacheRead += u.cached_input_tokens ?? 0;
      run.cacheWrite += u.cache_write_input_tokens ?? 0;
      run.in += Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0));
      run.out += (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
      run.turns = run.turns || run.tools || 1;
      run.ok = true;
      continue;
    }

    // -------------------------------------------------------------- agy ----
    if (e.event === "init") { run.harness = "agy"; continue; }
    if (e.event === "step_update") {
      run.harness = "agy";
      const s = e.step_update ?? {};
      if (s.step_type === "tool" && s.state === "ACTIVE") bumpTool(s.tool_name ?? "tool");
      continue;
    }
    if (e.event === "result" && e.result) {
      run.harness = "agy";
      sawEnvelope = true;
      const r = e.result;
      const u = r.usage ?? {};
      run.in += u.input_tokens ?? 0;
      run.out += u.output_tokens ?? 0;
      run.cacheRead += u.cache_read_tokens ?? 0;
      run.turns = r.num_turns ?? run.tools;
      run.durMs = (r.duration_seconds ?? 0) * 1000;
      run.error = r.error ?? null;
      run.ok = r.status === "SUCCESS" && (r.num_turns ?? 0) > 0;
      continue;
    }

    // --------------------------------------------------------------- pi ----
    if (e.type === "message" && e.message?.role === "assistant") {
      run.harness = "pi";
      for (const part of e.message.content ?? []) {
        if (part.type === "toolCall") bumpTool(part.name ?? "tool");
      }
      continue;
    }
    if (e.type === "result" && e.result && typeof e.result === "object") {
      run.harness = "pi";
      sawEnvelope = true;
      run.ok = e.result.exitCode === 0;
      run.in += e.result.tokens?.input ?? 0;
      run.out += e.result.tokens?.output ?? 0;
      run.turns = run.turns || run.tools;
      continue;
    }

    // ---------------------------------------------- claude final envelope ---
    if (e.type === "result" || "num_turns" in e || "total_cost_usd" in e) {
      run.harness = run.harness === "unknown" ? "claude" : run.harness;
      sawEnvelope = true;
      run.turns = e.num_turns ?? run.turns;
      run.cost += e.total_cost_usd ?? 0;
      run.durMs = e.duration_ms ?? run.durMs;
      const result = String(e.result ?? "");
      const unknownCommand = /^Unknown command:/.test(result);
      if (unknownCommand) run.error = oneLine(result, 90);
      run.ok = e.subtype === "success" && !e.is_error && !unknownCommand && (e.num_turns ?? 0) > 0;
    }
  }

  // A transcript with no final envelope means the process died before it could
  // write one — the wall-clock cap, a crash, or a kill. That is exactly the case
  // a Claude-only parser could not tell apart from "harness we don't understand",
  // so name it explicitly rather than folding it into a null.
  run.truncated = sawAnyEvent && !sawEnvelope;
  run.wasted = run.ok !== true;

  // Only Claude prices its own runs. Everything else gets priced from tokens so
  // that one number covers the whole factory — see lib/spend.mjs for why an
  // approximate figure beats an exact one that ignores a third of the runs.
  run.estCost = run.cost > 0 ? run.cost : estimateUSD(run);

  // Weight each payload by the turns it remained in the context window.
  for (const p of payloads) {
    const remaining = Math.max(1, run.tools - p.atTurn);
    const w = p.bytes * remaining;
    run.weightedBytes += w;
    const t = run.toolResultBytes.get(p.name) ?? { bytes: 0, calls: 0, weighted: 0 };
    t.bytes += p.bytes; t.calls++; t.weighted += w;
    run.toolResultBytes.set(p.name, t);
  }

  return run;
}
