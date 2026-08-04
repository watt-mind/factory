#!/usr/bin/env bun
/**
 * Turn `claude -p --output-format stream-json` into something a human can watch.
 *
 *   claude -p ... --output-format stream-json --verbose | bun runners/report.mjs --log <file>
 *
 * The factory is meant to be watched, and `--output-format json` buffers
 * everything until the end — you stare at a blank terminal for minutes and then
 * get a wall of text, with no idea whether it is working or stuck. This prints
 * each step as it happens and still parses the final envelope for the exit code.
 *
 * Exit 0 only when the run actually did something: subtype success, not
 * is_error, more than zero turns, and not an "Unknown command" reply.
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const logFile = argv.includes("--log") ? argv[argv.indexOf("--log") + 1] : null;
// Harnesses stream different schemas for the same events. Claude:
// {type:"assistant",message:{content:[{type:"tool_use",...}]}} and a final
// envelope with subtype/result/num_turns. Antigravity (agy):
// {event:"step_update",step_update:{step_type:"tool",tool_name,state}} and a
// final {status:"SUCCESS",response,num_turns}. Same information, different
// shape — normalise here rather than teaching every caller both.
const HARNESS = argv.includes("--harness") ? argv[argv.indexOf("--harness") + 1] : "claude";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};
const clock = () => new Date().toTimeString().slice(0, 8);
const oneLine = (s, n = 100) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** A compact, honest summary of what a tool call is about to do. */
function describeTool(name, input = {}) {
  switch (name) {
    case "Bash":       return oneLine(input.command);
    case "Read":       return oneLine(input.file_path);
    case "Edit":
    case "Write":      return oneLine(input.file_path);
    case "Glob":
    case "Grep":       return oneLine(input.pattern) + (input.path ? c.dim(` in ${oneLine(input.path, 40)}`) : "");
    case "Task":       return oneLine(input.description);
    case "WebFetch":   return oneLine(input.url);
    default: {
      // MCP tools carry the interesting bit in varied fields; show something.
      const k = ["query", "title", "id", "identifier", "issueId", "description"].find((x) => input[x]);
      return k ? oneLine(input[k], 80) : c.dim(Object.keys(input).slice(0, 4).join(", "));
    }
  }
}

let envelope = null;
let turns = 0;
const toolCounts = new Map();

const decoder = new TextDecoder();
let buf = "";

for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) handle(line);
}
if (buf.trim()) handle(buf);

function handle(line) {
  const t = line.trim();
  if (!t) return;
  if (logFile) { try { appendFileSync(logFile, t + "\n"); } catch {} }
  if (!t.startsWith("{")) { if (t) console.log(c.dim("  " + oneLine(t, 160))); return; }

  let e;
  try { e = JSON.parse(t); } catch { return; }

  // ---- Codex ----------------------------------------------------------
  if (HARNESS === "codex") {
    if (e.type === "turn.started" || e.type === "turn.created") { turns++; return; }
    if (e.type === "item.started" || e.type === "item.completed") {
      const item = e.item ?? {};
      if (e.type === "item.started" && (item.type === "command_execution" || item.type === "call")) {
        const name = "bash";
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        console.log(`  ${c.dim(clock())} ${c.cyan(name)} ${oneLine(item.command, 90)}`);
      } else if (e.type === "item.started" && item.type === "mcp_tool_call") {
        const name = item.tool ?? "mcp";
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        console.log(`  ${c.dim(clock())} ${c.cyan(name)} ${describeTool(name, item.arguments ?? {})}`);
      } else if (e.type === "item.completed" && item.type === "agent_message" && item.text) {
        console.log(`  ${c.dim(clock())} ${oneLine(item.text, 160)}`);
      }
      return;
    }
    if (e.type === "turn.completed") {
      const usage = e.usage ?? {};
      const totalTok = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      envelope = { status: "SUCCESS", num_turns: turns || 1, duration_seconds: 0, usage: { total_tokens: totalTok } };
    }
    return;
  }

  // ---- Pi -------------------------------------------------------------
  if (HARNESS === "pi") {
    if (e.type === "session") {
      console.log(c.dim(`  ${clock()} session ${String(e.id).slice(0, 8)}`));
      return;
    }
    if (e.type === "message" && e.message?.role === "assistant") {
      for (const part of e.message.content ?? []) {
        if (part.type === "toolCall") {
          turns++;
          const name = part.name ?? "tool";
          toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
          console.log(`  ${c.dim(clock())} ${c.cyan(name)} ${describeTool(name, part.input)}`);
        } else if (part.type === "text" && part.text?.trim()) {
          console.log(`  ${c.dim(clock())} ${oneLine(part.text, 160)}`);
        }
      }
      return;
    }
    if (e.type === "result" && e.result) {
      const res = e.result;
      const ok = res.exitCode === 0;
      envelope = {
        status: ok ? "SUCCESS" : "FAILED",
        num_turns: turns || 1,
        duration_seconds: 0,
        usage: { total_tokens: res.tokens?.total ?? 0 },
      };
    }
    return;
  }

  // ---- Antigravity (agy) ----------------------------------------------
  if (HARNESS !== "claude") {
    if (e.event === "init") {
      console.log(c.dim(`  ${clock()} conversation ${String(e.conversation_id).slice(0, 8)} · ${(e.init?.tools ?? []).length} tools`));
      return;
    }
    if (e.event === "step_update") {
      const s = e.step_update ?? {};
      if (s.step_type === "tool" && s.state === "ACTIVE") {
        turns++;
        const name = s.tool_name ?? "tool";
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        const par = s.tool_info?.parameters ?? {};
        const brief = oneLine(
          par.CommandLine ?? par.command ?? par.AbsolutePath ?? par.path ?? par.Query ?? par.query ??
          (Object.keys(par).length ? JSON.stringify(par) : ""), 90);
        console.log(`  ${c.dim(clock())} ${c.cyan(name)} ${brief}`);
      }
      if (s.step_type === "agent_response" && s.state === "DONE" && s.text) {
        console.log(`  ${c.dim(clock())} ${oneLine(s.text, 160)}`);
      }
      return;
    }
    // Final envelope is nested: {event:"result", result:{...}}
    if (e.event === "result" && e.result) envelope = e.result;
    else if ("status" in e && "num_turns" in e) envelope = e;
    return;
  }

  if (e.type === "system" && e.subtype === "init") {
    console.log(c.dim(`  ${clock()} session ${e.session_id?.slice(0, 8)} · model ${e.model ?? "?"} · ${(e.tools ?? []).length} tools`));
    return;
  }

  // Worth surfacing on a subscription: this is the only visibility anyone gets
  // into how much of the usage window is left.
  if (e.type === "rate_limit_event") {
    const i = e.rate_limit_info ?? {};
    const resets = i.resetsAt ? new Date(i.resetsAt * 1000).toTimeString().slice(0, 5) : "?";
    const label = `rate limit: ${i.status} (${i.rateLimitType}, resets ${resets})`;
    console.log(i.status === "allowed" ? c.dim(`  ${label}`) : c.yellow(`  ! ${label}`));
    return;
  }

  if (e.type === "assistant") {
    for (const part of e.message?.content ?? []) {
      if (part.type === "text" && part.text?.trim()) {
        console.log(`  ${c.dim(clock())} ${oneLine(part.text, 160)}`);
      } else if (part.type === "tool_use") {
        turns++;
        toolCounts.set(part.name, (toolCounts.get(part.name) ?? 0) + 1);
        console.log(`  ${c.dim(clock())} ${c.cyan(part.name)} ${describeTool(part.name, part.input)}`);
      }
    }
    return;
  }

  if (e.type === "user") {
    for (const part of e.message?.content ?? []) {
      if (part.type !== "tool_result") continue;
      const body = typeof part.content === "string"
        ? part.content
        : (part.content ?? []).map((x) => x.text ?? "").join(" ");
      const isErr = part.is_error;
      const shown = oneLine(body, 120);
      if (shown) console.log(`         ${isErr ? c.red("→ " + shown) : c.dim("→ " + shown)}`);
    }
    return;
  }

  // The final envelope has no "type" in some versions; detect by its fields.
  if (e.type === "result" || "num_turns" in e || "total_cost_usd" in e) envelope = e;
}

console.log();
if (!envelope) {
  console.error(c.red("  no result envelope — the run produced no final status."));
  process.exit(1);
}

// Normalise the two envelope shapes into one verdict.
const result = String(envelope.result ?? envelope.response ?? "");
if (HARNESS !== "claude") {
  const ok = envelope.status === "SUCCESS" && (envelope.num_turns ?? 0) > 0;
  if (result) console.log(result + "\n");
  const toolsUsed = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n}×${k}`).join(" ");
  console.log("  " + (ok ? c.green("ok") : c.red(`FAILED: ${envelope.status ?? "unknown"}`)) +
    c.dim(`   ${envelope.num_turns ?? 0} turns   ${(envelope.duration_seconds ?? 0).toFixed(0)}s   ${envelope.usage?.total_tokens ?? 0} tokens`));
  if (toolsUsed) console.log(c.dim(`  tools: ${toolsUsed}`));
  if (logFile) console.log(c.dim(`  transcript: ${logFile}`));
  console.log();
  process.exit(ok ? 0 : 1);
}

const unknownCommand = /^Unknown command:/.test(result);
const didNothing = (envelope.num_turns ?? 0) === 0;
const ok = envelope.subtype === "success" && !envelope.is_error && !unknownCommand && !didNothing;

if (result && !unknownCommand) console.log(result + "\n");

if (unknownCommand) {
  console.error(c.red(`  ${result}`));
  console.error(c.dim("  Fix: bun build/emit.mjs --link-repos"));
} else if (didNothing) {
  console.error(c.yellow("  Zero turns — the session started and did nothing."));
}

const tools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n}×${k}`).join(" ");
console.log(
  "  " + (ok ? c.green("ok") : c.red("FAILED")) +
  c.dim(`   ${envelope.num_turns ?? 0} turns   ~$${(envelope.total_cost_usd ?? 0).toFixed(3)} notional   ${((envelope.duration_ms ?? 0) / 1000).toFixed(0)}s`)
);
if (tools) console.log(c.dim(`  tools: ${tools}`));
if (logFile) console.log(c.dim(`  transcript: ${logFile}`));
console.log();

process.exit(ok ? 0 : 1);
