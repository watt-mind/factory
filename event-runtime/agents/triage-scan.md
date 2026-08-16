# triage-scan — assess a repo's open Linear issues, propose a typed triage plan

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

1. Resolve the repo's Linear team and project from
   `$FACTORY_ROOT/config/repos.yaml`, then list **all** of that project's open
   issues in `Triage` and `Todo` with paginated `factory linear raw` queries (or
   `bun "$FACTORY_ROOT/tools/linear.mjs" raw`). Hard-code the state list as
   `in:["Triage","Todo"]` in the GraphQL document: `linear.mjs raw` passes every
   `--var` value as a string, so passing a JSON-looking array through `--var`
   silently searches for one state with that literal name and can return a
   false zero. The response is usable only when it contains an `issues.nodes`
   array and complete `pageInfo`; follow `hasNextPage` until false, and fail
   closed on a missing cursor, malformed response, non-zero command, or
   interrupted pagination.
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

| action              | when                                                                                               |
| :------------------ | :------------------------------------------------------------------------------------------------- |
| `label-agent-ready` | fully specified: acceptance criteria, owned paths, verification command                            |
| `move-to-todo`      | specified and ready to queue (usually alongside agent-ready)                                       |
| `write-detail`      | missing template sections can be derived from this pinned checkout without making a product choice |
| `needs-detail`      | real work, but an agent would have to guess — say what is missing                                  |
| `mark-duplicate`    | another open issue covers it; name that issue in `reason`                                          |
| `needs-human`       | a decision only the operator can make                                                              |

Never invent an action id. Never propose changes to issues outside this repo.

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
  `detail`. Every entry must name a concrete regular file that exists in
  `./repo` at `repoPin.sha`. Reject globs (`*`, `?`, bracket/brace patterns),
  directories, generated guesses, and paths broader than the expected diff.
  Prefer `needs-detail` over a broad path.
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
