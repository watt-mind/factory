# evals

Prompt changes are the only part of this system with no regression test. Without these, a skill silently degrades and you find out weeks later when the merge rate has quietly halved.

**Treat a prompt edit like a code change.** CI runs the frozen cases below against any changed skill; if a skill's pass rate drops, the PR fails.

## Structure

```
cases/<skill>/<case-name>/
  input.md      the ticket / diff / PR the skill receives
  expect.md     what a correct response must contain, and must not
```

The directory name may be either a shared skill or a pinned
`event-runtime/agents/<name>.md` prompt. Source resolution checks the shared
skill first, then the emitted `plugins/core` skill, then the agent prompt, so a
skill with the same name always wins. `--dry-run` prints the resolved path.

`expect.md` is graded, not diffed — the wording will vary. State observable properties ("names a Verification Command that runs", "does not promote"), never exact phrasing.

## Choosing cases

The valuable cases are the ones where the skill is **tempted to do the wrong thing**: a ticket that looks specifiable but hides a product decision, a diff that looks cosmetic but changes an authorization check, a PR whose CI is green but whose test asserts nothing. A case the skill passes trivially teaches nothing and costs a run.

Freeze a case once it's written. A case edited to match new behavior is no longer a regression test.

## Running

    node evals/run.mjs                 # all
    node evals/run.mjs --skill ticket-spec

One case is two model calls: the **subject** run puts the case's own prompt (`shared/skills/<skill>/SKILL.md`, falling back to the emitted `plugins/core/skills/…`, then `event-runtime/agents/<name>.md`) in front of `input.md` and captures what it produces, then the **grader** judges that response against `expect.md` and answers with one line — `PASS: <reason>` or `FAIL: <reason>`. The subject may read the repo; the grader gets no tools, because it is judging text, not looking things up. Nothing is mutated: the subject is told this is an offline evaluation and is denied write tools.

A grader that hangs, crashes, or answers with prose instead of a verdict **fails that case**, never the run.

### Other flags

    node evals/run.mjs --dry-run       # list the cases and their resolved skill source; zero model calls
    node evals/run.mjs --json          # the run as JSON on stdout, for CI
    node evals/run.mjs --compare evals/.results/<file>.json
    node evals/run.mjs --timeout 240 --budget 1.50 --total-timeout 1800 --total-budget 10
    node evals/run.mjs --results-dir <dir> | --no-results
    node evals/run.mjs --help

Exit codes: **0** everything passed · **1** a case failed or regressed · **2** the runner could not run (bad flag, no cases, unpinned grader). The non-zero exit is the whole CI contract — no wrapper script needed.

### The grader is pinned, in policy

A grader that floats with whatever the CLI defaults to today moves the pass bar silently: a suite that "went green" would be indistinguishable from one whose judge got more generous. So the models come from an `evals:` stanza in `config/policy.yaml`, and a real run **refuses to start** without one (`--dry-run` still works, so discovery stays testable without spend):

```yaml
evals:
  # The model that RUNS the skill under test. "default" rides the CLI default,
  # which is what dispatch does today.
  subject:
    model: default
  # The model that GRADES the response against expect.md. Pinned by name so a
  # grader upgrade is a deliberate, reviewable change and never a silent shift
  # in the pass bar; the "default" sentinel is refused here for that reason.
  grader:
    model: claude-sonnet-4-6
  limits:
    case_timeout_seconds: 300
    case_budget_usd: 2.00
    total_seconds: 3600
    total_budget_usd: 20.00
```

`config/policy.yaml` is operator-local and gitignored, so add the same stanza to the tracked `config/policy.example.yaml`. Every limit is optional and defaults to the values above; the grader model is not. Reaching a total cap fails the cases it stopped, naming the cap — passing them would be a lie, and skipping them would let a slow or expensive regression walk through the gate.

### Runs are recorded, and drops are what you compare

Two runs of the same cases on the same models can disagree, so an absolute score cannot tell you whether a prompt edit made things worse. The diff can. Every run writes `evals/.results/<timestamp>.json` — the models, the case set, and per-case pass/fail with the grader's reason — and `--compare <file>` reports the transitions against an earlier one: `pass -> fail` is a **regression** and exits non-zero; a case present in the previous run and absent from the current one is reported as removed and does not fail the run, because case sets legitimately differ across branches; a grader change is flagged, because runs judged by different models are not a comparable measurement.

`evals/.results/` is local run output, not repo content. Add it to `.gitignore` (tracked in [#1090](https://github.com/watt-mind/factory/issues/1090), together with the policy stanza above) or pass `--no-results`.

### Tests

    bun test --timeout 20000 evals/run.test.mjs

`evals/run.test.mjs` covers discovery, the exit contract, `--skill` filtering, the timeout and cap paths, and `--compare` detecting a regression. **No test makes a model call**: `main()` takes the two model functions as a parameter and the tests pass fakes. A suite that needed a live grader to prove the gate works could never be the gate.

Cases are written first deliberately: they're the specification of what the skill is for, and writing them has already surfaced disagreements about what "agent-ready" means.
