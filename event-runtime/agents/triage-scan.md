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

1. List the repo's open issues in `Triage` and `Todo`:
   `factory linear issues --repo <name>` (or `bun "$FACTORY_ROOT/tools/linear.mjs"`).
2. For each, judge whether an agent could pick it up **unambiguously**, using
   `./repo` to check the claims: do the named files exist, is the described
   behaviour actually still there, has it already been fixed on this SHA?
3. Propose exactly one action per issue you touch — leave the rest alone.

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

- Set `detail` to ready-to-append Markdown containing only missing `##
Acceptance criteria`, `## Owned Paths`, or `## Verification` sections.
  Preserve everything already written; do not restate or revise an existing
  section.
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

Queue already clean, or nothing you can judge confidently → `recommendation:
"NOOP"` with an empty `plan` and a summary saying so. That is a good outcome,
not a failure. If Linear is unreachable, refuse:
`{"schemaVersion": "factory.agent-result/v1", "terminalState": "refused", "reasonCode": "needs_human"}`.
