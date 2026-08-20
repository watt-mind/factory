# wattmind/buzz

The factory as a Buzz agent. First `connectors` extension (WM-921): inbox items
post to `#general`, 👍/👎/💤 (and numbered reactions) plus thread replies map
onto `inbox.decide`, and a closed command grammar (`@factory dispatch`,
`@factory status`) injects events.

Telegram stays the blocker channel until a real `BLOCKED` push has been
observed end-to-end on Buzz. This connector is additive.

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

3. Uncomment the `extensions: - path: extensions/buzz` block in
   `config/policy.yaml` (commented on purpose so test `serve` does not hit
   the live relay). Restart `serve`. The connector starts even when the
   secrets are missing (`health().ok === false` until they are set).

Optional config (non-secret, in the policy `config:` block):

| Key           | Default                                                | Meaning                                                                |
| ------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `relayUrl`    | `https://watt-mind.communities.buzz.xyz`               | HTTP relay                                                             |
| `channel`     | `#general` uuid `91572011-2505-5288-b6f5-4a7d74abf106` | kind-9 `h` tag                                                         |
| `dmBlockedTo` | unset                                                  | owner pubkey hex; BLOCKED / CIRCUIT BREAKER / SMOKE RED also NIP-17 DM |
| `postKinds`   | every Decide + Red + Ready inbox kind                  | which ledger rows to post                                              |
| `pollSeconds` | 15                                                     | `/query` interval (5–120)                                              |
| `approvers`   | owner pubkey from the auth tag                         | who may react / command                                                |

## What it does

- **Egress.** New inbox items (subscribe + poll, so a missed `inbox.subscribe`
  fan-out still lands) become one kind-9 in `channel`: subject, the decision
  question, `👍 approve · 👎 reject · 💤 not now` (or numbered options), and a
  `#/inbox/<id>` deep link. `delivery.buzz = { eventId, postedAt }` is written
  through `client.inbox.markDelivered` when that seam exists; until then the
  mapping is held in connector memory. Resolved items get a thread reply.
- **Ingress.** Poll `/query` for kind-7 reactions and kind-9 replies on posted
  event ids. 👍 → approve, 👎 → reject (asks for a reason in-thread when the
  option requires one), 💤 → dismiss. Idempotent on the reaction event id.
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
