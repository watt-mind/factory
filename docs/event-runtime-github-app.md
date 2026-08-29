# GitHub App authentication

The Factory control plane can use a GitHub App installation token for its
GitHub Issues and Projects v2 traffic. Installation tokens have their own
rate budget, are repository-scoped, and expire after one hour. The supervised
token daemon refreshes the cached token before expiry; `github.mjs` reads that
cache for each `gh api` child process.

## Installation permissions

Install the App on every repository managed by the GitHub control plane and
grant this complete permission set:

| Scope        | Permission    | Access         | Used for                                                        |
| ------------ | ------------- | -------------- | --------------------------------------------------------------- |
| Repository   | Metadata      | Read-only      | Repository, collaborator-permission, and project linkage reads  |
| Repository   | Issues        | Read and write | Tickets, labels, comments, assignment, and open/close mutations |
| Repository   | Pull requests | Read-only      | Closing-PR references used by the duplicate-work claim guard    |
| Organization | Projects      | Read and write | Projects v2 items and the `Status` field                        |

Read the grant that an installation actually carries with the App JWT (no
token is minted, nothing is written):

```
GET /app/installations/{installation_id}   ->  .permissions
```

The `watt-mind` installation was read this way on 2026-08-29 and already
carries `issues: write` and `organization_projects: write`. No permission
change was needed to fix the claim failure — see the note below on `GET
/user`, which is not grantable to an installation at any permission level.

Changing App permissions requires the organization owner to approve the new
installation permissions. Re-mint the installation token after approval; an
already-cached token retains its old grants until it expires or is replaced.

Claims deliberately use one additional credential: the ambient `gh` user
login. A GitHub App installation is not a user, `GET /user` always returns
`403 Resource not accessible by integration` for an installation token, and
the App's `[bot]` account is not an assignable issue user. Factory therefore
uses the ambient user only to resolve the assignable lock owner; labels,
assignment, project status, comments, and read-back still use the App token.
Keep the operator login configured:

```bash
gh auth login -h github.com
gh auth status -h github.com
```

The ambient user must be assignable on every managed repository. Factory
reads the assignment back after each claim; a different assignee remains a
lost-race outcome.

## Runtime configuration

Set these variables in the environment used to start `bin/live-stack.sh`:

```bash
FACTORY_GH_APP_ID=123456
FACTORY_GH_APP_INSTALLATION_ID=7890123
FACTORY_GH_APP_PRIVATE_KEY_PATH="$HOME/.factory/keys/factory-app.pem"
# Optional; defaults to ~/.factory/gh-app-token.json
FACTORY_GH_APP_TOKEN_FILE="$HOME/.factory/gh-app-token.json"
```

### The `GH_TOKEN` caveat

Do not export the installation token into the environment that starts the
stack. `GH_TOKEN` (and `GITHUB_TOKEN`) override the `hosts.yml` user
credential for every `gh` call, including the one lookup — `GET /user` — that
must run as a human account, which then fails with `401 Requires
authentication` or `403 Resource not accessible by integration`.

The control plane defends itself: on that lookup it drops `GH_TOKEN` /
`GITHUB_TOKEN` from the child environment when their value is exactly the App
installation token (the resolved token, or the contents of
`FACTORY_GH_APP_TOKEN_FILE`), so `gh` falls back to the ambient user
credential. A token with any other value is an operator PAT and is left
untouched. The App token still authenticates every repository and Projects
call. Setting `FACTORY_GH_APP_*` and letting the daemon manage the cache is
the supported configuration; an exported copy is not.

Keep the private key and token cache outside the repository with mode `0600`.
`bin/live-stack.sh up` performs an initial mint, then supervises
`bun lib/control-plane/gh-app-auth.mjs --daemon`. If App configuration is
absent, the control plane uses the ambient `gh` credential for all calls. If
the configured cache is unavailable or stale, it logs one warning and falls
back to that credential until the daemon refreshes the token.

## Verification and errors

Verify token refresh without printing the token:

```bash
bun lib/control-plane/gh-app-auth.mjs
tail -n 20 ~/.factory/run/gh-app-token.log
```

Claim and release a scratch issue that is already on the configured Projects
v2 board:

```bash
bun tools/ticket.mjs claim OWNER/REPO#123 --repo REPO_NAME
bun tools/ticket.mjs unclaim OWNER/REPO#123 --repo REPO_NAME
```

Permission failures name the failed claim step and required setting. In
particular:

- label, assignment, or issue read-back failures point to repository
  **Issues** access;
- status failures point to organization **Projects: read and write**;
- lock-owner lookup failures ask for `gh auth login` rather than suggesting an
  App permission that cannot make `GET /user` available.

After changing permissions or credentials, run one real dispatch and confirm
that it passes claim and reaches `RUNNING`; a unit test cannot verify the live
installation grants.
