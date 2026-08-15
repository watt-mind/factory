Assign all historical factory-related tickets to the Factory Project in Linear, and align config/repos.yaml, commands, and tools so future factory tickets route to WM / Factory project properly.

### Problem & Context
Currently, factory tickets might not be consistently routed or assigned to the correct project in Linear. The `config/repos.yaml` file lists `team: OPS` for the `factory` repo and lacks a specific project mapping. We need to assign historical factory tickets to the "Factory Project" in Linear, and update `config/repos.yaml` (and any related tools/commands) so future factory tickets are routed to the `WM` team and the "Factory Project".

### Acceptance Criteria
- A script or process is provided (or executed) to assign historical factory-related tickets to the Factory Project in Linear.
- `config/repos.yaml` is updated so the `factory` repo has `team: WM` and `project: "Factory"` (or the exact names required by Linear).
- Any tools or commands that hardcoded the `OPS` team for factory routing are updated.

### Source File Pointers
- `config/repos.yaml`
- Any scripts under `tools/` or `scripts/` used for Linear routing.

### Owned Paths
- `config/repos.yaml`
- `tools/**`
- `scripts/**`

### Verification Command
`bun test && bun build/emit.mjs --check`
