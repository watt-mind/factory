---
name: factory-recap-video
description: "Catch the operator up with a silent subtitled landscape MP4 walkthrough and self-contained decision cards. Invoke only when the user explicitly asks to run /factory-recap-video or the factory-recap-video workflow."
---

# factory-recap-video

The user's accompanying request is this workflow's argument string. Wherever these instructions refer to `$ARGUMENTS`, interpret it as that request.

Catch the operator up with **one silent, subtitled `1280x720` landscape MP4** walkthrough paired with self-contained text decision cards underneath.

Follow every scope-window, live fact-checking, voice, fail-closed Checkout Freshness (`"unknown"` on failed fetch), and `## Calls waiting on you` rule in `/factory-recap` — replacing `/factory-recap`'s prose and Mermaid summary with the rendered MP4. Keep repository checkouts, git refs, tickets, and PRs strictly **read-only** (write only the scratch storyboard JSON and output MP4 outside the repository).

## 1. Gather & verify delta

Resolve the exact same dual scope window as `/factory-recap`:

- **Active session delta (bare invocation in an active chat):** everything after the last message the human personally wrote prior to `/factory-recap-video` — system wakeups, background notifications, and any earlier `/factory-recap` or `/factory-recap-video` calls do **not** reset this boundary — plus any unresolved human call from earlier in the chat, cross-checked live via `gh pr view`, REST check-runs, and `factory ticket get`.
- **AFK / Control-plane delta (`--repo`, `--all`, `--since`, or a cold chat with no prior work turns):** run `factory recap --json $ARGUMENTS` (for example `factory recap --since overnight --json`) to collect branch deltas, merged PRs + `## Handoff` `Risks`, `ux-screenshot` artifacts, `ai:escalated` PRs, `ai:blocked` holds, and `event-runtime` `runs`/`inbox_items`.

If nothing happened in the window and nothing waits on the operator, reply _"Nothing is waiting on you."_ and stop without rendering a video.

## 2. Draft storyboard (`1..10` slides, no tables or lists)

Before rendering, draft brief internal scratch notes (do **not** paste them into chat): a 1-sentence takeaway plus 1 line per candidate slide, dropping any slide that does not change what the operator knows (**hard cap: `1..10` slides**; fewer is better).

- **Ground strictly in real evidence:** build slides only from verified facts, diffs, measured metrics, and existing screenshot artifacts (`~/.factory/events/artifacts/<sha256>` or session artifact paths). Never invent mock UI screens, fake charts, or guessed numbers (`"unknown"` when unverified). If a visible UI change has no screenshot yet, use `layout: "screenshot"` with `noScreenshotNote: "No screenshot yet — <what changed on screen>"`. Never call `Read` on screenshot or frame PNGs.
- **Progressive visual continuity:** evolve shared node structures and consistent semantic state colors (`done`, `running`, `failed`, `blocked`, `escalated`) across consecutive slides using the supported visual layouts — `"flow"`, `"stack"`, `"before-after"`, `"screenshot"`, and `"options"` — pointing at changes with `highlight: true` and `callouts`. **Never** put bullet lists, status lists, or tables on slides.
- **Subtitles & hold-timing law (`added_words / 3`):**
  - Give each slide **1 conversational `subtitle`** (`~10` words, max `18` words) rendered in the dedicated non-overlapping `1280x96` bottom subtitle strip beneath the `1280x624` visual stage (`1280x720` total).
  - Pure slide hold duration (excluding cross-fade transitions) satisfies `holdSeconds >= added_words / 3` (`addedWords / 3`), where `added_words` counts the slide's subtitle words plus **only new or changed** slide labels relative to the immediately preceding slide (embedded screenshot pixels add `0` words).

## 3. Render & verify deterministically

1. Choose an output path **outside the repository**:
   - Interactive harness with a session artifact directory: `<artifact-dir>/<session>-recap.mp4`
   - Dispatched or CLI sessions: `${FACTORY_ARTIFACT_DIR:-${TMPDIR:-/tmp}}/recap-<stamp>.mp4` (published via the artifact store when `$FACTORY_RUN_ID` is set)
2. Write the storyboard JSON to a session-namespaced scratch file (`${TMPDIR:-/tmp}/recap-<session-or-stamp>.json`):
   ```json
   {
     "takeaway": "Two PRs landed on develop and one auth cookie PR needs your merge call.",
     "slides": [
       {
         "layout": "stack",
         "subtitle": "Two harness PRs landed green on develop",
         "nodes": [
           { "id": "p1", "label": "Garden command", "state": "done" },
           {
             "id": "p2",
             "label": "Deploy verifier",
             "state": "done",
             "highlight": true
           }
         ],
         "edges": [{ "from": "p1", "to": "p2" }]
       },
       {
         "layout": "options",
         "subtitle": "Auth cookie PR waits on your merge call",
         "options": [
           {
             "title": "Merge PR #12",
             "gain": "Blocks login CSRF",
             "cost": "One re-login",
             "recommended": true
           },
           {
             "title": "Hold for staging",
             "gain": "Extra soak day",
             "cost": "Leaves cookie lax"
           }
         ]
       }
     ]
   }
   ```
   Supported slide layouts (`factory recap-video --help`): `"flow"` and `"stack"` (`nodes`, `edges`), `"before-after"` (`before`, `after`, or `nodes`/`edges`), `"screenshot"` (`imagePath` or `noScreenshotNote`, optional `callouts: [{ "label", "x", "y" }]`), and `"options"` (`options: [{ "title", "gain", "cost", "recommended" }]`).
3. Render and verify in one deterministic step:
   ```bash
   factory recap-video "${TMPDIR:-/tmp}/recap-<id>.json" --out "<output.mp4>" --json
   ```
   `factory recap-video` renders HTML/SVG slides via `bin/chrome-headless.sh`, stitches smooth `xfade` transitions via `ffmpeg` without `drawtext` or `libass`, and automatically verifies `1280x720` `yuv420p` output plus per-slide pixel-matched pure hold duration (`>= added_words / 3`) without loading PNG frames into LLM context.
4. If validation or verification exits non-zero, fix the storyboard JSON and re-run **once**.

## 4. Reply format (and fail-open fallback)

Output in this exact order:

1. **Opening sentence (`1` short line):** name what waits on the operator right now, or _"Nothing is waiting on you."_
2. **Video:** embed or link the rendered `1280x720` MP4 (or its `$FACTORY_WEB_URL/api/artifacts/<sha256>` link when published).
3. **Remaining autonomous work (`1` line):** name any work the agent or pipeline is still finishing on its own (omit when none).
4. **`## Calls waiting on you`:** self-contained text decision cards following every `/factory-recap` call rule (`~30` words per item, ordered riskiest first, **Pick** + ID/link + user impact + evidence + **Risk** + wait cost), using the exact option names shown in the video. Omit when nothing waits on the operator.

**Fail-open fallback:** if rendering fails (for example, headless Chrome or `ffmpeg` is unavailable or the single retry still exits non-zero), state the render error in `1` short line and output the text recap and `## Calls waiting on you` cards immediately — never block operator decisions behind video tooling.
