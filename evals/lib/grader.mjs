/**
 * The two model calls a case needs, and nothing else (#1073).
 *
 *   runSkill — put the skill's own prompt in front of the case's `input.md`
 *              and capture what it produces (the "subject" run)
 *   grade    — hand `expect.md` and that response to the PINNED grader model
 *              and read back one verdict line
 *
 * Both are injected into the runner as a seam (`evals/lib/case-run.mjs`), so
 * every test in `evals/run.test.mjs` runs against fakes and the suite never
 * makes a real model call.
 *
 * The spawn conventions here deliberately mirror
 * `event-runtime/lib/adapters/claude.mjs`: detached process group so a TERM
 * reaches the CLI's own children, SIGTERM then SIGKILL after a grace period,
 * `--strict-mcp-config` with no config so no MCP server is loaded, and
 * ANTHROPIC_API_KEY stripped so the CLI uses subscription auth rather than
 * billing per token (docs/architecture.md §2.9). They are re-implemented
 * rather than imported because that adapter pulls in the whole event-runtime
 * registry graph, and `node evals/run.mjs` must stand alone.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { DEFAULT_MODEL } from "./policy.mjs";

export const KILL_GRACE_MS = 30_000;

/** Env the CLI inherits. An allowlist, so a worker's authority is not passed on. */
export const INHERITED_ENV = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
];

/** The subject may read the repo (a skill legitimately consults docs); never write. */
export const SUBJECT_TOOLS = ["Read", "Grep", "Glob"];

/** The grader judges text. It gets no tools at all — it has nothing to look up. */
export const GRADER_DENIED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Task",
];

export function childEnvironment(env = process.env) {
  const child = Object.fromEntries(
    INHERITED_ENV.flatMap((key) =>
      env[key] === undefined ? [] : [[key, env[key]]],
    ),
  );
  delete child.ANTHROPIC_API_KEY;
  delete child.CLAUDECODE;
  delete child.CLAUDE_CODE_ENTRYPOINT;
  return child;
}

/**
 * argv for one bounded, non-interactive CLI call. `model` uses the same
 * "default" sentinel as the adapters: pass no `--model` and ride the CLI's own.
 */
export function buildClaudeArgv({
  prompt,
  model,
  budgetUsd,
  allowedTools = [],
  disallowedTools = [],
}) {
  const args = ["-p", prompt, "--output-format", "json"];
  if (typeof model === "string" && model !== "" && model !== DEFAULT_MODEL) {
    args.push("--model", model);
  }
  if (allowedTools.length > 0)
    args.push("--allowedTools", allowedTools.join(","));
  if (disallowedTools.length > 0)
    args.push("--disallowedTools", disallowedTools.join(","));
  if (
    typeof budgetUsd === "number" &&
    Number.isFinite(budgetUsd) &&
    budgetUsd > 0
  ) {
    args.push("--max-budget-usd", String(budgetUsd));
  }
  args.push("--strict-mcp-config");
  return args;
}

/**
 * Run the CLI once, bounded by `timeoutMs` and `budgetUsd`.
 *
 * Resolves — never rejects — on a timeout or a non-zero exit: a hung or
 * failing call is evidence about ONE case, and the caller turns it into that
 * case's failure rather than into a dead run.
 *
 * @returns {Promise<{text: string, costUsd: number, exitCode: number|null, timedOut: boolean, error: string|null}>}
 */
export function callClaude({
  prompt,
  model,
  cwd,
  timeoutMs,
  budgetUsd,
  allowedTools = [],
  disallowedTools = [],
  killGraceMs = KILL_GRACE_MS,
  spawnFn = spawn,
  env = process.env,
  signal,
}) {
  const argv = buildClaudeArgv({
    prompt,
    model,
    budgetUsd,
    allowedTools,
    disallowedTools,
  });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn("claude", argv, {
        cwd,
        env: childEnvironment(env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      resolve({
        text: "",
        costUsd: 0,
        exitCode: null,
        timedOut: false,
        error: String(error?.message ?? error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    let timedOut = false;
    let killTimer = null;
    const escalate = () => {
      killProcessGroup(child, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(
          () => killProcessGroup(child, "SIGKILL"),
          killGraceMs,
        );
        killTimer.unref?.();
      }
    };
    const termTimer = setTimeout(() => {
      timedOut = true;
      escalate();
    }, timeoutMs);
    termTimer.unref?.();
    const onAbort = () => escalate();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (exitCode, error) => {
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.("abort", onAbort);
      const parsed = parseCliJson(stdout);
      resolve({
        text: parsed.text,
        costUsd: parsed.costUsd,
        exitCode,
        timedOut,
        error:
          error ??
          (exitCode === 0 || timedOut
            ? null
            : stderr.trim() || `claude exited ${exitCode}`),
      });
    };

    child.on("error", (error) => finish(null, String(error?.message ?? error)));
    child.on("close", (exitCode) => finish(exitCode, null));
  });
}

/** Terminate the CLI and everything it started (the adapter's WM-263 rule). */
export function killProcessGroup(
  child,
  signal = "SIGTERM",
  kill = process.kill,
) {
  const pid = child?.pid;
  if (!pid) return;
  try {
    kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * `--output-format json` emits one result object. Fall back to the raw bytes
 * rather than losing a response to a shape change in the CLI.
 */
export function parseCliJson(stdout) {
  const raw = String(stdout ?? "");
  try {
    const parsed = JSON.parse(raw);
    const text =
      typeof parsed?.result === "string"
        ? parsed.result
        : typeof parsed?.text === "string"
          ? parsed.text
          : raw;
    const cost = parsed?.total_cost_usd;
    return {
      text,
      costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : 0,
    };
  } catch {
    return { text: raw, costUsd: 0 };
  }
}

export const VERDICT_CONTRACT =
  'Answer with exactly one line and nothing else: "PASS: <reason>" or "FAIL: <reason>". The reason is one sentence naming the specific property that was met or missed.';

/**
 * Read the grader's verdict. Anything that is not an unambiguous PASS/FAIL
 * line is `null`, which the runner records as a failed case — a judge that
 * did not answer must never be read as approval.
 */
export function parseVerdict(text) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^\s*\**\s*(PASS|FAIL)\b\s*\**\s*[:\-–—]?\s*(.*)$/i.exec(
      line,
    );
    if (!match) continue;
    return {
      pass: match[1].toUpperCase() === "PASS",
      reason: match[2].trim().replace(/\s+/g, " ") || "(grader gave no reason)",
    };
  }
  return null;
}

export function buildSubjectPrompt({
  candidateName,
  candidateText,
  inputText,
}) {
  return [
    `You are being evaluated on the "${candidateName}" skill. Its instructions follow verbatim; follow them exactly as written.`,
    "",
    `<<<SKILL ${candidateName}>>>`,
    candidateText.trim(),
    "<<<END SKILL>>>",
    "",
    "This is an offline evaluation against a frozen case. Do not call any tracker, issue tracker, or API; do not modify any file; do not open a pull request. You may read the repository you are running in to ground your answer.",
    "",
    "Apply the skill to the input below and write the outcome you would produce: the decision you reach, any comment text you would post, any labels or state changes you would make, and the evidence you consulted (cite paths).",
    "",
    "<<<INPUT>>>",
    inputText.trim(),
    "<<<END INPUT>>>",
  ].join("\n");
}

export function buildGraderPrompt({
  candidateName,
  inputText,
  expectText,
  responseText,
}) {
  return [
    `You are grading one frozen evaluation case for the "${candidateName}" skill.`,
    "",
    "Grade against the PROPERTIES in EXPECTED, not against its wording — the response is expected to be phrased differently. The case passes only if every 'Must' property holds and no 'Must not' property is violated. A violated 'Must not' is a FAIL even when everything else is right. Missing evidence for a required property is a FAIL, not a benefit of the doubt.",
    "",
    "<<<INPUT GIVEN TO THE SKILL>>>",
    inputText.trim(),
    "<<<END INPUT>>>",
    "",
    "<<<EXPECTED PROPERTIES>>>",
    expectText.trim(),
    "<<<END EXPECTED>>>",
    "",
    "<<<RESPONSE UNDER TEST>>>",
    responseText.trim(),
    "<<<END RESPONSE>>>",
    "",
    VERDICT_CONTRACT,
  ].join("\n");
}

/**
 * The real, model-backed pair. `case-run.mjs` never imports these directly —
 * `run.mjs` passes them in, and the tests pass fakes in their place.
 */
export function modelRunners({
  repoRoot,
  policy,
  spawnFn = spawn,
  env = process.env,
}) {
  return {
    async runSkill({ evalCase, timeoutMs, budgetUsd, signal }) {
      const candidateText = readFileSync(evalCase.candidateSource, "utf8");
      const inputText = readFileSync(evalCase.inputPath, "utf8");
      const result = await callClaude({
        prompt: buildSubjectPrompt({
          candidateName: evalCase.candidateName,
          candidateText,
          inputText,
        }),
        model: policy.subject.model,
        cwd: repoRoot,
        timeoutMs,
        budgetUsd,
        allowedTools: SUBJECT_TOOLS,
        spawnFn,
        env,
        signal,
      });
      if (result.timedOut)
        throw new Error(`skill run timed out after ${timeoutMs}ms`);
      if (result.error) throw new Error(`skill run failed: ${result.error}`);
      return { text: result.text, costUsd: result.costUsd };
    },

    async grade({ evalCase, response, timeoutMs, budgetUsd, signal }) {
      const inputText = readFileSync(evalCase.inputPath, "utf8");
      const expectText = readFileSync(evalCase.expectPath, "utf8");
      const result = await callClaude({
        prompt: buildGraderPrompt({
          candidateName: evalCase.candidateName,
          inputText,
          expectText,
          responseText: response.text,
        }),
        model: policy.grader.model,
        cwd: repoRoot,
        timeoutMs,
        budgetUsd,
        disallowedTools: GRADER_DENIED_TOOLS,
        spawnFn,
        env,
        signal,
      });
      if (result.timedOut)
        throw new Error(`grader timed out after ${timeoutMs}ms`);
      if (result.error) throw new Error(`grader failed: ${result.error}`);
      const verdict = parseVerdict(result.text);
      if (!verdict) {
        return {
          pass: false,
          reason: "grader returned no PASS/FAIL verdict",
          costUsd: result.costUsd,
        };
      }
      return { ...verdict, costUsd: result.costUsd };
    },
  };
}
