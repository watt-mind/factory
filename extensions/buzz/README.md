# wattmind/buzz

The factory as a Buzz agent (WM-921, interrupt-channel contract WM-974). Inbox
items that **wait on a human** post to `#ops-factory`. 👍/👎/💤/🔁/📤/💬/🔓
reactions and thread replies map onto `inbox.decide`. A closed command grammar
(`@factory dispatch`, `@factory status`) injects events.

Run starts and other telemetry do **not** go here — that is a later
`#feed-factory` channel (WM-975). Telegram stays the blocker channel until a
real `BLOCKED` push has been observed end-to-end on Buzz. This connector is
additive.

## Setup

1. Generate an agent key and a NIP-OA tag (owner nsec is read once, never stored):

   ```sh
   uv run ~/Develop/hdkiller/scripts/buzz.py keygen
   uv run ~/Develop/hdkiller/scripts/buzz.py auth-tag
   ```

   `keygen` prints `nsec` / `npub` / hex. `auth-tag` mints
   `["auth", <owner-pubkey>, <conditions>, <sig>]` from `BUZZ_OWNER_NSEC` for
   `BUZZ_AGENT_NSEC` (WM-905).

2. Put the two secrets in `~/.factory/secrets.env` (`chmod 600`):

   ```
   FACTORY_EXT_BUZZ_AGENT_NSEC=nsec1…
   FACTORY_EXT_BUZZ_AUTH_TAG=["auth","…","kind=9&created_at<…","…"]
   ```

3. Enable `extensions: - path: extensions/buzz` in `config/policy.yaml`. Restart
   `serve`. The connector starts even when the secrets are missing
   (`health().ok === false` until they are set).

Optional config (non-secret, in the policy `config:` block):

| Key           | Default                                                          | Meaning                                                                        |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `relayUrl`    | `https://watt-mind.communities.buzz.xyz`                         | HTTP relay                                                                     |
| `channel`     | `#ops-factory` uuid (policy); schema default is `#general`       | kind-9 `h` tag — the pager                                                     |
| `webUrl`      | unset (`FACTORY_WEB_URL`)                                        | Absolute http(s) origin for inbox deep links. Hash-only links are never posted |
| `dmBlockedTo` | unset                                                            | owner pubkey hex; BLOCKED / CIRCUIT BREAKER / SMOKE RED also NIP-17 DM         |
| `postKinds`   | ESCALATED, BLOCKED, CI RED, SMOKE RED, CIRCUIT BREAKER, RC READY | interrupt set only                                                             |
| `pollSeconds` | 15                                                               | `/query` interval (5–120)                                                      |
| `approvers`   | owner pubkey from the auth tag                                   | who may react / command                                                        |

## What it does

- **Egress.** New inbox items (subscribe + poll) become one kind-9 in `channel`
  when they are actually answerable: `ESCALATED` needs a ticket; dismiss-only
  cards stay on the web inbox. Subject is `kind  repo  ticket`, then the why
  (`decision.context` / `body` / question), then reaction options, then an
  absolute `#/inbox/<id>` link when `webUrl` is set. `delivery.buzz = { eventId,
postedAt }` is written through `client.inbox.markDelivered`. Resolved items
  get a thread reply.
- **Ingress.** Poll `/query` for kind-7 reactions and kind-9 replies on posted
  event ids. Closed-set effects map to unique emojis (👍 approve, 👎 reject,
  💤 not now, 🔁 requeue, 📤 triage, 💬 answer, 🔓 authorise). A thread reply
  selects `recommended` or `answer` and uses the reply text as the required
  field. Idempotent on the reaction event id.
- **Commands.** In the channel, from an approver:
  - `@factory dispatch WM-123 repo=factory` → `factory.dispatch.requested`
  - `@factory status` → inbox open count + this connector's health
  - anything else is ignored
- **Outage.** Failed POSTs sit on a bounded in-memory queue and retry; a queue
  overflow is logged and counted in `health().detail`. Reaction/reply queries
  are not bounded by `since` (idempotent on event id via `seenIngress`), so a
  reaction that lands during downtime is not lost on restart — only the broad
  channel-wide command query resumes with `since`. `health()` reports the last
  successful relay round-trip.

## Verify

```sh
bun test --timeout 20000 --max-concurrency=4 extensions/buzz/test
bun event-runtime/cli.mjs extensions validate extensions/buzz
```
