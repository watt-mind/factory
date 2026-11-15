---
name: principle-attack-the-premise
description: "Apply when two or more fixes sharing one premise have failed the same gate. Write the premise down and test it directly before writing another fix that assumes it."
disable-model-invocation: true
---

# Attack the Premise

When two or more attempts built on the same assumption fail the same check, stop iterating on fixes and challenge the assumption itself.

1. **Write the shared premise down** in one concrete sentence (e.g., _"The dev server is listening on port X"_ or _"The upstream payload always includes field Y"_).
2. **Test the premise directly** with a minimal command, log inspection, or reproduction before writing another line of fix code.
3. **Pivot on the evidence.** If the premise is false, fix the actual cause rather than layering another workaround on top.
