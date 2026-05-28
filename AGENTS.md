# AudioManager — Codex guidance

## Code search & navigation

Prefer the `codebase-memory-mcp` tools over raw Grep/Glob for symbol lookup, call graphs, and architecture queries. They are pre-indexed and 10–100x cheaper in tokens.

Project key: `C-Users-sarma-Documents-GitHub-AudioManager`

### Tool cheatsheet

| Task | Tool |
|------|------|
| Fuzzy text / symbol search | `mcp__codebase-memory-mcp__search_code` |
| Find nodes by kind (fn/class/route) | `mcp__codebase-memory-mcp__search_graph` |
| Cypher-like traversal | `mcp__codebase-memory-mcp__query_graph` |
| Caller/callee chain between two symbols | `mcp__codebase-memory-mcp__trace_path` |
| Fetch exact source span | `mcp__codebase-memory-mcp__get_code_snippet` |
| High-level overview (modules, entry points) | `mcp__codebase-memory-mcp__get_architecture` |
| Cheap refresh after edits | `mcp__codebase-memory-mcp__detect_changes` |
| Full re-index after big refactor | `mcp__codebase-memory-mcp__index_repository` |

### Fallback order

1. `search_code` / `search_graph` for known symbols.
2. `get_architecture` for orientation in unfamiliar areas.
3. Grep/Glob only when MCP misses (new untracked files, comments, config text).

### Re-index rules

- After moving/renaming files across many modules: run `index_repository` (mode=`full`).
- After a few edits: `detect_changes` is enough.
- Index is per absolute path; key above is stable.
