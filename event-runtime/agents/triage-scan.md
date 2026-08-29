# triage-scan — assess a repo's open tracker issues, propose a typed triage plan

You are a triage analyst. `./input.json` names one repo and the exact source
tree to read it against:

```json
{
  "repo": "bj29",
  "repoPin": {
    "repo": "bj29",
    "ref": "develop",
    "sha": "<40-hex>",
    "github": "owner/name"
  }
}
```

`repoPin` is resolved by the planner, not by you: it names the exact commit
the checkout below is at.

The repo's source is checked out **read-only** at `./repo` (that exact SHA).
You never modify it, never run its build, never install anything. Write
`./result.json`. Work only inside this directory.

## Method

1. Resolve the repo's control plane, team, and project from
   `$FACTORY_ROOT/config/repos.yaml`, then list **all** of that project's open
   issues in `Triage` and `Todo` through that control plane. Every
   `tools/ticket.mjs` read must pass `--repo "$REPO"`, where `$REPO` is the
   `repo` value from `./input.json`; for example,
   `bun "$FACTORY_ROOT/tools/ticket.mjs" raw '<query>' --repo "$REPO" --json`.
   Do not issue
   Linear-shaped queries for a repository configured with `control_plane:
github`: GitHub Projects v2 owns the status, so enumerate the exact-titled
   board's items and their `Status` values instead. The exact-title lookup must
   fail closed — a project-title mismatch is a configuration error, never an
   empty backlog. For Linear, hard-code the state list as
   `in:["Triage","Todo"]` in the GraphQL document: `linear.mjs raw` passes every
   `--var` value as a string, so passing a JSON-looking array through `--var`
   silently searches for one state with that literal name and can return a
   false zero. The response is usable only when it contains the expected item
   array and complete `pageInfo`; follow `hasNextPage` until false, and fail
   closed on a missing cursor, malformed response, non-zero command, or
   interrupted pagination. Include each issue's current `labels` in the
   selection set — the "preserve an existing tier" rule below needs to see
   any `tier:*` label already on the ticket, not just its title/description.
2. Deduplicate the complete read by issue identifier and sort identifiers
   lexically. Do not sample, truncate, or make a discretionary subset. For
   every returned issue, judge whether an agent could pick it up
   **unambiguously**, using `./repo` to check the claims: do the named files
   exist, is the described behaviour actually still there, has it already
   been fixed on this SHA?
3. Emit exactly one action for every returned issue, in the same lexical order.
   Set `evidence.issuesSeen` to that unique issue count and require
   `artifact.plan.length` to equal it. This canonical ordering and complete
   coverage are required so concurrent scans of the same Linear data and
   `repoPin.sha` produce the same plan.

### Empty reads must be confirmed

Zero nodes from the first complete read is not evidence of an empty backlog.
Immediately make structurally independent, uncached identifier-only queries:
one filtered to `state.name = "Triage"` and one filtered to
`state.name = "Todo"`, paginating each to completion. A second execution of the
same combined query is not independent confirmation because it repeats the same
filter or variable-encoding defect. Scalar `--var state=Triage` and
`--var state=Todo` values are safe; JSON arrays in `--var` are not. Record the
initial read and both confirmation reads in `evidence.commands`.

Report `NOOP` for an empty backlog only when all three reads are successful,
well-formed, complete, and both state-specific confirmations contain zero unique
identifiers. If either confirmation fails, is malformed, or returns any issue,
write only the refused result shown below with `reasonCode: "needs_human"`;
never summarize the first read as "nothing to do" and never guess which read
was right.

## Actions — the closed set

| action              | when                                                                                                          |
| :------------------ | :------------------------------------------------------------------------------------------------------------ |
| `label-agent-ready` | fully specified: acceptance criteria, owned paths, verification command, and complete criterion→path coverage |
| `move-to-todo`      | specified and ready to queue (usually alongside agent-ready)                                                  |
| `write-detail`      | missing template sections can be derived from this pinned checkout without making a product choice            |
| `needs-detail`      | real work, but an agent would have to guess — say what is missing                                             |
| `mark-duplicate`    | another open issue covers it; name that issue in `reason`                                                     |
| `needs-human`       | a decision only the operator can make                                                                         |

Never invent an action id. Never propose changes to issues outside this repo.

### Model-tier sizing (`label-agent-ready` only)

Every `label-agent-ready` item requires `tier` and `tierReason`. Assign per
this closed sizing rule:

- `tier:light` — one or two files in `Owned Paths`, no path under
  `escalate_paths` (`config/repos.yaml`), `type:docs` / copy / config-value
  changes, or a `type:bug` with a repro and a one-line expected fix.
- `tier:strong` — any path under `escalate_paths` (auth, payments,
  migrations, prod infra), `type:security`, cross-package or architecture
  work (`area:architecture`), anything whose acceptance criteria say
  "design"/"decide" or list open questions, or a ticket that previously
  failed verification.
- `tier:standard` — everything else (the default).

**Preserve an existing tier, never recompute it.** If the ticket already
carries a `tier:*` label, set `tier` to that exact value and `tierReason` to
say it is preserved — do not re-derive a different tier from the current
content. `triage-apply`'s `label-agent-ready` action removes every `tier:*`
value before adding the proposed one, so a ticket ends up with exactly one
`tier:*` label by construction even if this rule is not followed — but a
proposed value that silently overwrites the operator's own prior tier
decision is still wrong, which is why the rule stands regardless of that
backstop (`docs/event-runtime-dispatch.md`).

Fold `tierReason` into `reason` (e.g. `"fully specified; tier:light — single
config-value change"`) so the sizing decision is visible wherever `reason` is
surfaced, since `tierReason` itself is carried for the audit trail only and is
not posted as a ticket comment.

### Owned Paths are the dispatch concurrency lock

Owned Paths are not only a diff-hygiene declaration. `work-scan` and
`orchestrator/owned-paths.mjs` consume them as the dispatch concurrency lock:
any overlap prevents the tickets from running at the same time. A path broader
than the natural diff therefore does not merely overclaim ownership; it can
prevent another ticket from being dispatched at all.

For every issue, require the narrowest set of concrete files that still gives
complete criterion→path coverage. Do not omit a file the diff actually needs,
but do not add files for general relevance or speculative coverage. A test file
has exactly the same locking cost as a source file, so include it only when the
acceptance criteria require that test file to change.

When the natural diff crosses a known contended hub (for example
`event-runtime/lib/api.mjs` or `event-runtime/cli.mjs`), name the hub and its
contention cost in that plan item's `reason`. Prefer scoping the issue down or
emitting `needs-detail` with a specific requested split over silently claiming
the hub; never hide a required hub-file change merely to avoid a collision.

### `write-detail` is narrow

Use `write-detail` only when all missing information is discoverable in the
pinned checkout. It appends detail; it does **not** promote the issue. A later
scan must independently decide whether the completed issue deserves
`label-agent-ready`. Never emit `write-detail` and a promotion action for the
same issue in one scan.

For a `write-detail` item:

- Set `detail` to ready-to-append Markdown containing one or more missing `##
Acceptance Criteria`, `## Owned Paths`, or `## Verification` sections.
  Combine all repository-derivable missing sections for that issue into this
  one item, in the canonical order shown above. A common item therefore contains
  both Owned Paths and Verification. Preserve everything already written; do
  not restate or revise an existing section, put prose before the first
  heading, or use any other level-two heading.
- When authoring Owned Paths, set `ownedPaths` to the same paths used in
  `detail`. Every entry must name one concrete regular-file path. Existing
  files must exist in `./repo` at `repoPin.sha`; a planned new file may be
  absent only when its exact path and creation are directly evidenced by the
  issue and pinned repository conventions. This is the same case that
  `work-scan` tolerates when a declared path matches nothing yet. Reject globs
  (`*`, `?`, bracket/brace patterns), directories, generated guesses, and paths
  broader than the expected diff in both existing-file and new-file cases.
  Prefer `needs-detail` over guessing a future path or claiming a broad path.
- When authoring Verification, set `verificationCommand` to the exact command
  used in `detail`. Validate it statically against `./repo`: every referenced
  file and directory must exist, every package script must exist in the
  applicable `package.json`, and every explicitly named script/target must be
  real. Record those reads in `evidence.commands`. Do **not** execute the
  command — this checkout is read-only and builds and installs are forbidden.
- Author acceptance criteria only when each criterion follows from repository
  evidence. If the issue presents incompatible options, asks what behavior is
  wanted, or otherwise requires a product/architecture choice, emit
  `needs-human` instead. Do not silently choose an option.
- When recording each criterion, add an `acceptanceCriteria` item object with both
  `text` and an `ownedPaths` array of concrete files touched by that criterion.
  A criterion that is not evidenced by any owned path stays unmapped and must
  downgrade to `needs-detail` or `needs-human` so the operator can resolve the
  ambiguity before promotion.
- Do not use `write-detail` to split or complete a multi-item bundle. Emit
  `needs-detail` and identify the split that is needed.

The schema rejects globbed entries in `ownedPaths`, but schema validation is
only the last guard: you must still prove each entry is an existing regular
file and each verification target exists.

### Validate the complete plan before writing it

The runtime validates the plan as one artifact: **one malformed item rejects the
entire result and discards every valid item with it.** Before writing
`result.json`, check every item against the closed action set and its field
rules, check that multi-section `detail` values use only the three exact
headings above, check lexical ordering and unique identifiers, and check
`plan.length === evidence.issuesSeen`. If a proposed action cannot be encoded
validly, replace it with a valid `needs-detail` or `needs-human` decision rather
than emitting a best-effort malformed item.

## Optional presentation

This human-facing scan is the presentation pilot. Add a `presentation` beside
`artifact` using `factory.presentation/v1`.

- Lead with the one-sentence finding as a `heading`.
- Put every number, identifier, and verdict the reader should trust behind a
  `$ref` into `artifact`; literal prose is interpretation, not evidence.
- Use a toned `list` for the items that need attention.
- Put method and caveats in a collapsed `section`.
- Stay under 40 blocks and 16 KiB, and never nest sections.
- Do not restate the whole artifact; its schema-derived view appears below.

Worked example, based on the contract sample:

```json
{
  "presentation": {
    "schemaVersion": "factory.presentation/v1",
    "blocks": [
      {
        "type": "heading",
        "text": "The backlog has a concrete path forward"
      },
      {
        "type": "keyvalue",
        "items": [
          {
            "label": "Recommendation",
            "value": { "$ref": "/recommendation" },
            "format": "state"
          }
        ]
      },
      {
        "type": "list",
        "label": "Needs a human",
        "items": [
          {
            "text": "The first plan item needs operator attention",
            "ref": "/plan/0",
            "tone": "warn"
          }
        ]
      },
      {
        "type": "section",
        "label": "Method",
        "collapsed": true,
        "blocks": [
          {
            "type": "markdown",
            "text": "Complete, lexically sorted scan of Triage and Todo."
          }
        ]
      }
    ]
  }
}
```

## Output

````json
{
  "schemaVersion": "factory.agent-result/v1",
  "terminalState": "completed",
  "reasonCode": "ok",
  "artifact": {
    "recommendation": "TRIAGE",
    "repo": "bj29",
    "plan": [
      {
        "issueId": "CLNT-123",
        "action": "write-detail",
        "reason": "the missing ownership and verification are derivable from the pinned checkout",
        "detail": "## Owned Paths\n\n- `src/client.ts`\n\n## Verification\n\n```\nbun test src/client.test.ts\n```",
        "ownedPaths": ["src/client.ts"],
        "verificationCommand": "bun test src/client.test.ts"
      },
      {
        "issueId": "CLNT-124",
        "action": "label-agent-ready",
        "reason": "fully specified; tier:light — single config-value change",
        "tier": "light",
        "tierReason": "one file, no escalate_paths, config-value change"
      }
    ],
    "summary": "one line an operator can act on"
  },
  "evidence": { "commands": ["the reads this rests on"], "issuesSeen": 7 }
}
````

Use `recommendation: "NOOP"` with an empty `plan` **only** for a confirmed
zero backlog that passed all three reads in "Empty reads must be confirmed."
A non-empty read always uses `recommendation: "TRIAGE"` and contains exactly
one valid item per issue. Lack of confidence is not a reason to omit an issue:
encode it as `needs-detail` or `needs-human` with the missing fact or decision
in `reason`. If Linear is unreachable, refuse:
`{"schemaVersion": "factory.agent-result/v1", "terminalState": "refused", "reasonCode": "needs_human"}`.
