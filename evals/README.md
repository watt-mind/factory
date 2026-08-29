# evals

Prompt changes are the only part of this system with no regression test. Without these, a skill silently degrades and you find out weeks later when the merge rate has quietly halved.

**Treat a prompt edit like a code change.** CI runs the frozen cases below against any changed skill; if a skill's pass rate drops, the PR fails.

## Structure

```
cases/<skill>/<case-name>/
  input.md      the ticket / diff / PR the skill receives
  expect.md     what a correct response must contain, and must not
```

`expect.md` is graded, not diffed — the wording will vary. State observable properties ("names a Verification Command that runs", "does not promote"), never exact phrasing.

## Choosing cases

The valuable cases are the ones where the skill is **tempted to do the wrong thing**: a ticket that looks specifiable but hides a product decision, a diff that looks cosmetic but changes an authorization check, a PR whose CI is green but whose test asserts nothing. A case the skill passes trivially teaches nothing and costs a run.

Freeze a case once it's written. A case edited to match new behavior is no longer a regression test.

## Running

    node evals/run.mjs                 # all
    node evals/run.mjs --skill ticket-spec

Each case runs the skill under test against its `input.md`, then a model grades
the response against `expect.md` — **graded, not diffed**: `expect.md` states
properties, and the wording of a correct response will vary. Every case yields
`pass | fail` and the grader's one-line reason. Output is human-readable by
default; `--json` emits the same for CI.

The runner exits non-zero if any case fails, so it drops into CI as a gate with
no wrapper:

    node evals/run.mjs && echo "prompts safe to merge"

Other flags:

    --dry-run              list the cases that would run and their resolved
                           skill source; makes no model calls (testable without spend)
    --compare <file>       diff this run against a prior .results/<ts>.json and
                           report any *regression* — a case that passed then and
                           fails now — so a drop is detectable, not just a score
    --timeout <ms>         per-case bound for the subject run and the grader
    --total-timeout <ms>   total cap for the whole run
    --json                 machine-readable output

### The grader is pinned

Grading uses a model call, and the grader model is pinned in
`config/policy.yaml` so a grader upgrade is a deliberate, reviewable change —
never a silent shift in the pass bar. Set it under an `evals:` block:

    evals:
      grader:
        model: <your-strong-model>

If that pin is absent the runner falls back to `models.claude.strong`, and
finally to the CLI's own default. The resolved model and its source are printed
at the top of every non-`--json` run, and recorded into the results file.

### Determinism is honest

Every run records the model, the case set, and per-case pass/fail into
`evals/.results/<timestamp>.json`. `--compare` reads one of those back and
flags regressions. A hung grader fails its own case rather than wedging the run.

### Scope of the current runner

The subject run is a lightweight harness: it applies the skill's `SKILL.md` to
the case `input.md` with a bounded model call — no repository workspace, no MCP,
no Linear. That is enough for the self-contained judgement cases this corpus is
built from. Cases that require the skill to explore a live repository are a
follow-up, not silently unsupported.
