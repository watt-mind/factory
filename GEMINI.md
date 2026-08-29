# GEMINI.md

Gemini, please refer to **[AGENTS.md](./AGENTS.md)** and **[`docs/protocol.md`](./docs/protocol.md)** for the
primary repository context, architecture, commands, operational rules, and tracker issue
management standards.

This file (GEMINI.md) is an entry point to ensure you find the centralized instructions.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
