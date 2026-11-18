---
name: factory-arena
description: "Run a multi-harness competitive Arena bakeoff (codex, claude, agy), cross-judge, graft the best ideas, and verify. Invoke only when the user explicitly asks to run /factory-arena or the factory-arena workflow."
---

# factory-arena

The user's accompanying request is this workflow's argument string. Wherever these instructions refer to `$ARGUMENTS`, interpret it as that request.

Run a cross-harness Arena bakeoff for the requested task using **`shared/skills/factory-arena/SKILL.md`** and `factory arena`.

1. **Frame:** State the target artifact, write a 3–6 criterion rubric to `$TMPDIR`, and write the candidate prompt (without the rubric) to `$TMPDIR`.
2. **Fan out:** If T3Code Orchestrator MCP tools (`orchestrator_capabilities`, `delegate_task`, `task_cancel`, `t3_thread_wait`, `t3_thread_read`) are available in the session, call `orchestrator_capabilities` once per thread and spawn contenders via `delegate_task` (`mode: "async"`; never `create_threads`/`t3_thread_launch`), then end your turn for reactive wakeup; otherwise run `factory arena run --prompt-file <prompt> --profile <default|full> --mode <sandbox|worktree> --json` (using `~/.factory/arena.yaml` on this node, or `config/arena.example.yaml` fallback).
3. **Cross-judge:** Spawn a fresh read-only cross-vendor judge via `delegate_task` (`mode: "async"`) or run `factory arena judge --manifest <manifest> --rubric-file <rubric> --caller-vendor <vendor> --json`.
4. **Pick & Graft:** Read every surviving candidate end-to-end, compare with the cross-judge report, pick the cleanest base, and hand-graft 1–2 standout ideas from losing candidates.
5. **Verify & Cleanup:** Run targeted verification on the synthesized result, run `factory arena cleanup --manifest <manifest>`, and summarize the base, grafts, rejections, dropouts, and verification evidence.
