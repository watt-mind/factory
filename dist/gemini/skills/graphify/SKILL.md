---
name: graphify
description: Navigate codebase architecture, dependencies, callers, callees, and symbol relationships using precomputed knowledge graphs. Use when exploring code, tracing dependencies, finding callers/callees, or assessing blast radius.
---

# Graphify Knowledge Graph Navigation

When `graphify-out/graph.json` or the `graphify` command is present in the workspace, use Graphify CLI queries for fast, token-efficient codebase exploration instead of running wide grep/find searches.

## Query Commands

All queries operate locally on the precomputed graph with zero LLM API spend:

- **Explain a symbol or module:**
  ```bash
  graphify explain "<SymbolOrPath>"
  ```
  Returns a plain-language summary of the node, its callers, callees, community role, and direct neighbors.

- **Trace shortest dependency path between two symbols:**
  ```bash
  graphify path "<Source>" "<Target>"
  ```
  Returns the exact call/dependency chain connecting two nodes.

- **Identify architectural hubs:**
  ```bash
  graphify god-nodes --top 10
  ```
  Lists the most heavily connected symbols (architectural hubs) in the repository.

- **Natural language question / query:**
  ```bash
  graphify query "<Question>"
  ```
  Extracts and returns the relevant subgraph answering the question.

## Keeping the Graph Current

After making code edits on a branch:
```bash
graphify update .
```
Runs a fast, local AST re-scan on changed files (takes ~1-2 seconds with 0 API tokens). Never run full `graphify extract .` during ticket work.

## Fallback

If `graphify-out/graph.json` or `graphify` is unavailable, fall back to standard targeted grep/find tools.
