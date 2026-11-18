# factory-arena

> Run a multi-harness competitive Arena bakeoff (codex, claude, agy), cross-judge, graft the best ideas, and verify

Run a cross-harness Arena bakeoff for the requested task using **`shared/skills/factory-arena/SKILL.md`** and `factory arena`.

1. **Frame:** State the target artifact, write a 3–6 criterion rubric to `$TMPDIR`, and write the candidate prompt (without the rubric) to `$TMPDIR`.
2. **Fan out:** If T3Code Orchestrator MCP tools (`orchestrator_capabilities`, `delegate_task`, `thread_wait`, `thread_read`) are available in the session, spawn the contenders natively inside T3Code; otherwise run `factory arena run --prompt-file <prompt> --profile <default|full> --mode <sandbox|worktree> --json` (using `~/.factory/arena.yaml` on this node, or `config/arena.example.yaml` fallback).
3. **Cross-judge:** Spawn a read-only cross-vendor judge via T3Code or run `factory arena judge --manifest <manifest> --rubric-file <rubric> --caller-vendor <vendor> --json`.
4. **Pick & Graft:** Read every surviving candidate end-to-end, compare with the cross-judge report, pick the cleanest base, and hand-graft 1–2 standout ideas from losing candidates.
5. **Verify & Cleanup:** Run targeted verification on the synthesized result, run `factory arena cleanup --manifest <manifest>`, and summarize the base, grafts, rejections, dropouts, and verification evidence.
