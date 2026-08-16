# Editorial agent runtime: Hermes migration and cell architecture

**Status:** architecture reference, not yet implemented  
**Decision:** one `SiteCell` per website plus one `ArticleCell` per article  
**Captured:** 2026-08-16  
**Tracking:** WM-347  
**Related operational defect:** [OPS-524](https://linear.app/watt-mind/issue/OPS-524/hermes-scheduled-job-results-fail-delivery-to-unsupported-webui)

## 1. Purpose

This document captures the current editorial automation deployed in Hermes on
`shadow` and defines the target architecture for implementing it in Factory's
event runtime.

The target is a multi-site editorial system in which temporary agents can:

1. discover useful topics;
2. compare them with previous coverage;
3. research and draft an article;
4. review and revise it;
5. queue an approved revision for publication;
6. publish through a constrained CMS adapter; and
7. verify independently that the intended revision is live.

Agents may run on different machines and at different times. They communicate
through typed events and durable domain APIs rather than shared mutable files.

This document deliberately separates:

- **deployed facts** observed on `shadow`;
- **Factory patterns** already implemented in the local event runtime; and
- **proposed design**, which remains work to implement.

It contains no credentials, secret values, private memories, channel IDs, or
customer/user PII.

## 2. Architecture decision

Use a hybrid cell boundary:

- A **SiteCell** owns site-wide editorial policy, previous-coverage knowledge,
  queue projections, calendar, and publication history.
- An **ArticleCell** owns one article's brief, sources, revisions, reviews,
  approvals, publication receipt, and live verification.

A single SiteCell would make previous-article queries easy but would serialize
all article work for a site and grow into a large mixed-responsibility object.
One cell per article would scale well but would have no natural authority for
site-wide coverage, policy, or queue selection. The hybrid preserves both
site-wide awareness and article-level isolation.

Cells are domain authorities, not long-running LLM processes. Agents remain
ephemeral workers. A cell stores state, validates transitions, issues leases,
and accepts or rejects versioned results.

## 3. Evidence boundaries

### 3.1 Hermes evidence

The Hermes inventory came from a read-only SSH inspection of `shadow` over its
Tailnet address `100.66.162.128` on 2026-08-16. No service was restarted and no
file or external service was modified. Secret values, `.env` files, private
memory contents, session/message bodies, email bodies, and authenticated CMS
reads were intentionally excluded.

### 3.2 Factory evidence

The Factory event-runtime review used the local Factory implementation and the
following primary files:

- `event-runtime/README.md`
- `event-runtime/event-types.json`
- `event-runtime/edges.json`
- `event-runtime/lib/planner.mjs`
- `event-runtime/lib/chain.mjs`
- `event-runtime/lib/worker.mjs`
- `event-runtime/lib/verify.mjs`
- `event-runtime/lib/artifacts.mjs`
- `event-runtime/agents/triage-scan.*`
- `event-runtime/agents/triage-apply.*`
- `event-runtime/agents/work-scan.*`
- `event-runtime/agents/dispatch.*`

At the time of investigation, the event runtime was present in the local
Factory history but not in `origin/main`; Factory's active development branch
is `develop`. Implementation agents must re-read the current branch rather than
assuming this snapshot is still exact.

## 4. Current Hermes deployment

### 4.1 Runtime and services

The deployed runtime was Hermes Agent `v0.20.1 (2026.8.13)` on Python 3.11.15.
The source checkout was `NousResearch/hermes-agent` at commit prefix
`1c3fbd21`; the Hermes WebUI checkout was `nesquena/hermes-webui` at commit
prefix `3c9304ae`.

All four relevant user services were active:

| Service                  | Observed execution                          |
| ------------------------ | ------------------------------------------- |
| `hermes-gateway`         | `python -m hermes_cli.main gateway run`     |
| `hermes-dashboard`       | dashboard on `127.0.0.1:9119`               |
| `hermes-dashboard-proxy` | `172.18.0.1:9119` to `127.0.0.1:9119`       |
| `hermes-webui`           | `python3 server.py`, listening on port 8787 |

The local dashboard and WebUI HTTP endpoints returned `200`.

### 4.2 Hermes durable state

Observed under `~/.hermes`:

- `state.db`, approximately 186 MB: sessions/messages, FTS, system prompts,
  routing, async delegations, delivery obligations, leases, and usage;
- `sessions/`: 135 JSON session files;
- `cron/jobs.json`: six enabled schedule definitions;
- `cron/executions.db`: schedule claims and execution state;
- `kanban.db`: tasks, runs, events, comments, links, attachments, and
  notification subscriptions;
- `skills/`: approximately 120 skill definitions;
- `memories/`: four files, contents not inspected;
- `state/`: gateway heartbeat and job-produced state artifacts; and
- `webui/`: session and attachment persistence.

Hermes therefore already models schedules, sessions, leases, delivery
obligations, and task state. These are Hermes-specific and spread across
several stores; they must not be copied wholesale into Factory without an
explicit source-of-truth mapping.

### 4.3 Relevant integrations

The implementation contains integrations or tools for:

- Telegram;
- GitHub and Linear;
- Himalaya email;
- WordPress REST;
- Postiz;
- web/browser research;
- AgentMemory MCP;
- constrained read-only Coach Watts PostgreSQL access;
- Intervals.icu competitive-content synchronization; and
- the read-only Coach Watts diagnostics collector.

Agents must not inherit ambient access to all of these. Each Factory agent
definition must declare only the capabilities required for that stage.

## 5. Current editorial workflows

### 5.1 Coach Watts weekly blog writer

Primary sources:

- `~/.hermes/skills/productivity/coachwatts-content/SKILL.md`
- `~/wiki/workflows/coachwatts-content-pipeline.md`
- `~/wiki/workflows/coachwatts-content-backlog.md`
- `~/wiki/coachwatts/articles/*.md`
- `~/.hermes/cron/jobs.json`

The enabled job has ID `c7039ccb8c19`, runs Mondays at 09:00, and declares
`/home/hdkiller/workspace` as its workspace.

Its current combined flow is:

1. read the pipeline and Markdown backlog;
2. select an open, high-priority topic;
3. rotate sport/content type where possible;
4. research the prior week using the skill's evidence hierarchy;
5. produce a 1,400–2,200 word English SEO draft with required frontmatter,
   sources, safety constraints, and verified-only product claims;
6. save `~/wiki/coachwatts/articles/{slug}.md`;
7. mark the Markdown backlog item complete and attach the file path; and
8. report sources and verification gaps.

This is one prompt-driven scheduled agent, not a multi-agent pipeline. It is
**draft-only**: the skill forbids CMS/API publication until an approved
integration is supplied and explicitly enabled.

### 5.2 Previous-article awareness

The Coach Watts agent currently learns previous work primarily from
`~/wiki/workflows/coachwatts-content-backlog.md`. Completed rows link to local
drafts. There is no observed:

- semantic similarity search;
- structured topic or publication index;
- live CMS reconciliation;
- slug uniqueness check against the live site;
- durable CMS ID/canonical URL ledger; or
- distinction between generated, approved, published, and verified-live.

The observed backlog had six completed Coach Watts topics while
`~/wiki/coachwatts/articles/` contained five Markdown drafts. All inspected
draft frontmatter used `status: draft`. This is direct evidence that a mutable
checkbox is not a sufficient lifecycle authority.

### 5.3 Property-content WordPress draft publisher

Relevant sources:

- `~/.hermes/skills/productivity/hungarian-property-content/SKILL.md`
- `~/hermes-workspace/scripts/publish_post.py`

The property workflow can write to WordPress, but it creates posts with
`status: "draft"`; a human must make them public. The script:

1. parses Markdown and simple YAML-like frontmatter;
2. converts Markdown to HTML;
3. sends a WordPress REST request;
4. creates a new draft with RankMath metadata; and
5. prints the remote ID and link.

Observed gaps:

- every invocation creates a new draft;
- there is no idempotency key or update/upsert path;
- the CMS response is not persisted as a durable receipt;
- there is no reconciliation against an existing remote post;
- missing frontmatter falls back to inferred values; and
- an independent verifier does not validate the intended remote state.

This script is a useful prototype for a closed CMS adapter, but must not be
ported unchanged.

### 5.4 Other approval-oriented workflows

- Coach Watts welcome-email automation produces drafts only.
- Social workflows require human review and explicit approval before
  scheduling; publication remains manual.
- Partner outreach follows unsent draft, review, confirmation, then send.
- The attorney digest is an explicitly approved automated email conditioned
  on material content and protected by Sent-folder subject deduplication.

### 5.5 Enabled Hermes jobs

| Job                              | Schedule          | Current purpose                         |
| -------------------------------- | ----------------- | --------------------------------------- |
| GitHub trending                  | daily 07:00       | deterministic trending collector        |
| Hungarian property topic/article | Monday 08:00      | research, write, create WordPress draft |
| Coach Watts blog writer          | Monday 09:00      | research and write local Markdown draft |
| Coach Watts welcome-email drafts | daily 08:00       | drafts only                             |
| Linear project activity          | every 240 minutes | compare/update Linear activity state    |
| Hungarian attorney digest        | Monday 09:00      | verified digest email                   |

Three successful jobs recorded delivery failures because their output target
was the unsupported platform `webui`: the Coach Watts blog writer, welcome
email drafts, and Linear activity job. This is tracked in OPS-524. The migration
must choose a supported sink such as the Factory inbox/UI, Telegram, or a
persisted accepted artifact; it must not copy the invalid platform name.

## 6. Factory patterns to preserve

The target should reuse Factory's control-plane model instead of teaching one
large autonomous agent to mutate every system.

### 6.1 Separate facts, decisions, execution, and accepted results

```text
external/scheduled fact
        -> authenticated, deduplicated event
        -> deterministic planner and immutable RunSpec
        -> watched proposal/approval where required
        -> worker lease
        -> isolated agent execution
        -> verifier outside the model
        -> accepted result and receipt
        -> transactional outbox
        -> typed downstream event
```

The LLM belongs only in execution. Event admission, idempotency, permissions,
approval, transition validation, and result verification remain code.

### 6.2 Agents recommend; the runtime chains

Factory agents do not directly spawn other agents. An accepted typed result can
carry a registered recommendation. `edges.json` maps that value into another
event through the same intake path, preserving deduplication, causation,
approval, and audit history.

Apply the same rule here. A review agent may return `APPROVE`, `REVISE`, or
`NEEDS_HUMAN`; it may not directly launch a writer or publisher.

### 6.3 Scan and apply are different trust levels

Read-only scan agents inspect pinned state and propose typed plans. Mutating
apply stages execute only approved, registered actions. Where possible, apply
uses deterministic command/action adapters rather than another unconstrained
model.

Publication must be a closed adapter, not a tool available to research,
drafting, or review agents.

### 6.4 Artifacts are pinned inputs

Research snapshots, source extracts, drafts, review reports, rendered content,
CMS responses, and verification reports should be immutable artifacts identified
by content hash. Downstream RunSpecs pin exact hashes at plan time. Agents must
not browse an ambient shared artifact directory.

### 6.5 Verification is external to the model

An agent cannot certify its own output. Schema, hash, lifecycle, CMS, and live
site checks must run in deterministic verifier code. Agent critique may add
editorial judgment but cannot replace machine checks.

## 7. Target component model

```text
                             Factory event runtime
                   events / plans / approvals / receipts
                                      |
                  +-------------------+-------------------+
                  |                                       |
           ephemeral agents                       closed adapters
                  |                                       |
                  +-------------------+-------------------+
                                      |
                          SiteCell + ArticleCells
                                      |
                    +-----------------+----------------+
                    |                                  |
             object/artifact store                    CMS
                                                       |
                                                 public website
```

### 7.1 Authority table

| Concern                                             | Authority                        |
| --------------------------------------------------- | -------------------------------- |
| site strategy, style, coverage, calendar            | SiteCell                         |
| article brief, sources, revisions, decisions        | ArticleCell                      |
| run planning, approvals, leases, attempts, receipts | Factory event runtime            |
| immutable large run outputs                         | content-addressed artifact store |
| remote draft/publication record                     | CMS                              |
| whether a revision is publicly available            | independent live-site verifier   |
| images and large media                              | private object/media storage     |

Do not represent one lifecycle field as independently mutable in both Factory
and an ArticleCell. Factory owns execution state; ArticleCell owns editorial
entity state. The CMS owns its remote post state.

### 7.2 SiteCell

One logical cell per site, for example:

```text
site:coachwatts.com
site:watt-mind.com
site:property-law.example
```

Responsibilities:

- site identity and CMS adapter reference;
- editorial policy, voice, locale, audience, and safety rules;
- topic taxonomy and content pillars;
- normalized index of verified published articles;
- recent coverage and topic-frequency projections;
- content gaps and editorial calendar;
- article queue projection;
- publication and verification summaries; and
- site-level concurrency and cadence policy.

Suggested logical tables:

```text
site_config
editorial_policy_versions
topic_clusters
article_queue_projection
published_article_index
content_gaps
publication_summaries
site_events
outbox
```

A CMS credential must never be stored in the cell. Store only an adapter and
secret reference resolved by trusted execution infrastructure.

### 7.3 ArticleCell

One logical cell per article, for example:

```text
article:coachwatts.com:01J...
```

Responsibilities:

- immutable identity and owning site;
- canonical topic, audience, intent, locale, and proposed slug;
- research-source metadata and claim provenance;
- immutable draft revisions and their hashes;
- review findings and revision requests;
- approval decisions and exact approved revision hash;
- current lifecycle state and version;
- task/run reservations and fencing tokens;
- CMS publication receipt; and
- independent verification receipt.

Suggested logical tables:

```text
article
brief_versions
research_sources
claims
revision_artifacts
reviews
approvals
run_leases
publication_receipts
verification_receipts
article_events
outbox
```

Markdown may remain a generated human-readable export. It must not remain the
operational authority.

## 8. Editorial lifecycle

Initial closed state machine:

```text
IDEA
  -> SELECTED
  -> RESEARCHING
  -> READY_TO_DRAFT
  -> DRAFTING
  -> REVIEW
  -> REVISION_REQUIRED -> DRAFTING
  -> APPROVED
  -> PUBLISH_QUEUED
  -> CMS_DRAFT
  -> PUBLICATION_APPROVED
  -> PUBLISHED
  -> VERIFYING
  -> LIVE
```

Exceptional terminal or parked states:

```text
BLOCKED
REJECTED
RETIRED
PUBLISH_FAILED
VERIFICATION_FAILED
```

Every transition records:

- previous and next state;
- expected entity version;
- actor or accepted Factory run ID;
- causation/correlation IDs;
- revision and artifact hashes where relevant;
- timestamp; and
- reason or approval reference.

Illegal transitions fail closed.

Imported Hermes data must not infer publication from a checked backlog item.
Useful import states are:

```text
DRAFT_IMPORTED
MISSING_DRAFT
PUBLISHED_UNVERIFIED
LIVE_VERIFIED
```

These may be migration-only classifications rather than permanent lifecycle
states.

## 9. Proposed event graph

```text
clock.tick.editorial
  -> editorial.topic-scan.requested
  -> topic-scan result
     -> NOOP
     -> NEEDS_HUMAN
     -> PROPOSE_TOPICS
        -> approved topic-apply
        -> article.created
        -> article.research.requested
        -> article.research.accepted
        -> article.draft.requested
        -> article.draft.accepted
        -> article.review.requested
           -> REVISE -> article.draft.requested (bounded loop)
           -> NEEDS_HUMAN
           -> APPROVE -> article.approved
        -> article.publish.requested
        -> approved publish-apply
        -> article.cms-written
        -> article.verify.requested
           -> RETRY_LATER (bounded schedule)
           -> VERIFICATION_FAILED
           -> LIVE
```

Suggested event families:

```text
clock.tick.editorial
editorial.topic-scan.requested
editorial.topics-proposed
article.create.requested
article.created
article.research.requested
article.research-accepted
article.draft.requested
article.draft-accepted
article.review.requested
article.revision-requested
article.approval-requested
article.approved
article.publish.requested
article.cms-written
article.verify.requested
article.live
article.blocked
```

Each event schema must carry `siteId`, `articleId` where applicable,
`correlationId`, a stable source event ID, and the expected domain version or
artifact hash needed to prevent stale work.

## 10. Agent and adapter definitions

### 10.1 `topic-scan`

Read-only capabilities:

```text
site:read
web:read
artifact:write-candidate
```

Inputs include a pinned SiteCell editorial snapshot and external evidence.
Output contains ranked candidate topics, coverage comparison, source evidence,
and a recommendation. It cannot create ArticleCells or edit the queue.

### 10.2 `topic-apply`

Deterministic approved action that creates an ArticleCell and registers its
projection in the SiteCell. It refuses unknown action IDs or a stale SiteCell
version before any mutation.

### 10.3 `article-research`

Read-only web/source agent. It outputs source metadata, claims, citations,
confidence, and unresolved questions as a typed artifact. It does not mutate
the CMS or mark the article approved.

### 10.4 `article-draft`

Receives a pinned brief, accepted research artifact, style-policy version, and
previous revision/review when revising. It outputs a candidate immutable
revision artifact. A deterministic apply step commits it against the expected
ArticleCell version.

### 10.5 `article-review`

Checks overlap, structure, style, unsupported claims, safety constraints,
search intent, internal-link opportunities, metadata, and source quality.
Returns only a registered verdict:

```text
APPROVE
REVISE
NEEDS_HUMAN
```

Revision loops have an explicit maximum. Reaching it emits `NEEDS_HUMAN`
rather than continuing indefinitely.

### 10.6 `publish-apply`

Closed CMS adapter with the only CMS write credential. Minimum input:

```json
{
  "siteId": "coachwatts",
  "articleId": "article-0192",
  "approvedRevisionHash": "sha256:...",
  "expectedArticleVersion": 7,
  "action": "create-draft",
  "idempotencyKey": "coachwatts:article-0192:revision-3:create-draft"
}
```

Minimum result receipt:

```json
{
  "cmsPostId": "...",
  "cmsUrl": "...",
  "cmsStatus": "draft",
  "revisionHash": "sha256:...",
  "adapterVersion": "wordpress@1"
}
```

Before writing, it re-reads the ArticleCell and proves the approved hash and
version still match. A retry reconciles by idempotency key/CMS ID instead of
creating a sibling post.

### 10.7 `verify-live`

Prefer deterministic HTTP/CMS checks. Verify at least:

- expected URL returns the expected status;
- canonical URL matches;
- CMS ID and state match the publication receipt;
- title and an immutable revision marker/hash match;
- required metadata exists;
- robots/indexability policy is satisfied;
- sitemap or RSS inclusion is correct when required; and
- no duplicate slug/post was created.

An optional visual/editorial critic may augment these checks but cannot turn a
failed deterministic verification into success.

## 11. Previous-article awareness

Do not place every historical article into an LLM context. SiteCell provides a
bounded, reproducible editorial snapshot containing:

- policy version;
- recent verified articles;
- relevant topic clusters;
- similar article summaries and similarity scores;
- publication frequency and recency;
- known content gaps;
- prohibited/recently saturated topics; and
- current queue collisions.

Initial matching can use normalized topics, keywords, locale, audience, and
SQL. Vector similarity may be added later, but the embedding model/version and
source revision hash must be stored so results are reproducible.

Only an article with accepted live verification should enter the authoritative
published index. Drafts and queued work participate in collision checks but are
not represented as published coverage.

For cross-site duplication later, add an explicit portfolio index/projection.
Do not let SiteCells scan one another ambiently.

## 12. Concurrency, idempotency, and failure recovery

### 12.1 Versioned submissions

An agent RunSpec receives:

```json
{
  "articleId": "article-0192",
  "articleVersion": 7,
  "snapshotHash": "sha256:...",
  "inputArtifactHashes": ["sha256:..."]
}
```

Submission includes the expected version. If the ArticleCell is now version 8,
the result is stale and cannot overwrite current state. The planner may create
a fresh run from the new snapshot.

### 12.2 Leases and fencing

Long model calls should run in Factory workers rather than holding an open cell
request. ArticleCell records a bounded reservation containing run ID, lease
expiry, and monotonically increasing fencing token. A late worker cannot
publish after another attempt has taken over.

### 12.3 At-least-once delivery

Assume every event and adapter call can be retried. Protect each layer with:

- unique source event IDs;
- deterministic Factory idempotency keys;
- expected cell versions;
- fencing tokens;
- CMS idempotency/reconciliation keys; and
- accepted-result receipts.

Exactly-once execution is not required; duplicate externally visible effects
must be prevented.

### 12.4 Cross-cell updates

An ArticleCell update and SiteCell projection update are not one transaction.
The ArticleCell commits its state and writes a durable outbox event. Delivery
updates the SiteCell projection idempotently. Queue/topic scans may tolerate a
briefly stale projection; publication must always re-read the authoritative
ArticleCell immediately before the CMS write.

## 13. Approvals and security

Initial policy:

- topic selection: human approval;
- article approval: human approval after agent review;
- CMS draft creation: human approval or an explicitly approved site policy;
- public publication: human approval;
- retries that do not change approved bytes: may become automatic after
  observed reliability;
- permission expansion, adapter installation, or generated executable code:
  human-only.

Agents never receive CMS credentials. They propose structured state changes.
Trusted adapters resolve secret references and perform narrowly scoped effects.

Keep research/browser capabilities separate from CMS/email/social write
capabilities. No agent may grant itself a tool, secret, destination, or larger
budget.

celld is currently alpha and its own documentation says it is not safe for
hostile multi-tenant use. If celld backs the cells, expose only the public
application listener, keep the internal/operator listener on Tailscale or an
equivalent encrypted private network, and treat fleet-bucket credentials as
fleet administrator credentials.

## 14. Artifacts and retention

Persist as content-addressed artifacts:

- external research snapshot;
- candidate-topic rationale;
- source extracts where licensing permits;
- accepted research report;
- every article revision;
- review report;
- rendered CMS payload;
- CMS response receipt with secrets removed;
- live verification report; and
- agent transcript when policy permits retention.

Store large images/media in dedicated private media/object storage. ArticleCell
stores metadata, hashes, provenance, and references. Do not rely on celld's
internal fleet bucket as an application-visible R2 binding; celld does not
implement the Cloudflare R2 service binding.

Retention policy must distinguish issued/published artifacts, which are
immutable, from temporary unaccepted candidates, which may expire.

## 15. Migration plan

### Phase 0: repair visibility

Resolve OPS-524 by selecting supported delivery destinations for current Hermes
jobs. Preserve successful outputs as visible artifacts while the old jobs still
run.

### Phase 1: inventory and import

1. Parse Coach Watts/property backlogs and draft directories.
2. Hash every discovered draft.
3. Create SiteCell records and ArticleCells without inferring publication.
4. Reconcile missing drafts, duplicate slugs, and checked-but-missing rows.
5. Optionally query each CMS through a read-only reconciliation adapter.
6. Generate an import report requiring human resolution for ambiguity.

### Phase 2: topic scan only

Implement SiteCell editorial snapshots, schedule events, `topic-scan`, schemas,
and watched proposals. Keep Hermes draft generation operational until Factory's
scan output is trustworthy. Do not publish.

### Phase 3: research, draft, and review

Implement ArticleCell lifecycle, pinned artifacts, versioned submissions,
bounded revision loops, and human approval. Compare generated output with the
existing Hermes skill requirements.

### Phase 4: closed CMS draft adapter

Refactor the behavior prototyped by `publish_post.py` into a tested,
idempotent adapter. Initially permit only `create-draft`; persist CMS receipts
and reconcile retries.

### Phase 5: live publication and verification

Add a separate approved transition for public publication and deterministic
live verification. Do not retire the Hermes job until Factory can prove the
intended revision is live and results reach the operator.

### Phase 6: multi-site and earned automation

Add site-specific adapters/configuration, portfolio-level duplicate detection,
performance feedback, and selectively automated approvals only after measured
reliability. Each site remains a separate SiteCell and trust boundary.

## 16. Concrete implementation surfaces in Factory

A future implementation will likely add or extend:

```text
event-runtime/event-types.json
event-runtime/edges.json
event-runtime/schedules.json
event-runtime/agents/editorial-*.json
event-runtime/agents/editorial-*.md
event-runtime/schemas/editorial-*.json
event-runtime/lib/adapters/<cms>.mjs
event-runtime/lib/verify.mjs
```

Cell runtime/domain code should live behind a versioned client interface rather
than being embedded directly into agent prompts. Exact paths and package
boundaries remain an implementation decision and must be specified in a future
Linear ticket before coding.

Each agent definition must pin prompt and schema hashes, declare model tier,
workspace, limits, and capabilities, and increment its version when a contract
changes.

## 17. Minimum viable vertical slice

The first production-shaped slice should cover one Coach Watts article and stop
at CMS draft:

1. schedule/manual event requests topic scan;
2. operator approves one candidate;
3. SiteCell creates one ArticleCell;
4. research agent emits a pinned source artifact;
5. draft agent emits one immutable revision;
6. review agent returns a typed verdict;
7. operator approves the exact revision hash;
8. closed adapter creates/reconciles one CMS draft;
9. deterministic verifier confirms the remote draft and receipt; and
10. Factory inbox displays the accepted outcome.

Success means a retry at every boundary creates no duplicate ArticleCell,
revision, Factory run effect, or CMS post.

## 18. Open decisions

Resolve these before implementation tickets become agent-ready:

1. First target CMS and site: Coach Watts CMS is not currently configured in
   Hermes; property WordPress has the only observed publisher prototype.
2. Cell runtime: managed Cloudflare Durable Objects, celld, or a local domain
   service with the same versioned API for the first slice.
3. Location and technology of the content-addressed editorial artifact store.
4. Required human approval surface: Factory inbox/UI, Telegram deep link, or
   both.
5. Canonical source format for article revisions and rendering ownership.
6. CMS revision marker used to prove that the approved bytes are live.
7. Retention and privacy policy for sources, transcripts, and generated drafts.
8. Whether site performance analytics influence topic selection in the first
   release or a later feedback phase.
9. Whether existing Markdown/wiki files remain generated projections or are
   retired after reconciliation.

## 19. Non-goals for the first slice

- unrestricted agent-generated JavaScript;
- agents granting themselves capabilities;
- fully autonomous public publishing;
- global SQL transactions across sites/articles;
- replacing the CMS as the publication authority;
- ingesting private Hermes memories or historical session bodies;
- semantic/vector search before structured topic matching works; and
- migrating unrelated Hermes email, Linear, social, or infrastructure jobs.

## 20. Implementation handoff checklist

Before an implementation agent begins:

- [ ] create a Linear ticket with exact acceptance criteria, Owned Paths, and
      verification command;
- [ ] name the first site and CMS adapter;
- [ ] define SiteCell and ArticleCell API/schema versions;
- [ ] define event, input, output, and refusal schemas;
- [ ] register every edge and bound every loop;
- [ ] decide approval policy for each transition;
- [ ] define idempotency keys and stale-version behavior;
- [ ] define CMS reconciliation and rollback behavior;
- [ ] define deterministic verification checks;
- [ ] define artifact retention and secret-redaction rules;
- [ ] build import/reconciliation as read-only before enabling writes; and
- [ ] verify retries and stale workers cannot duplicate external effects.
