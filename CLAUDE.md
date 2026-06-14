# AudioManager — Claude guidance

## Response Style (Caveman Mode Active)
- No preamble, no openers, no summaries
- Fragments OK — drop articles (a/an/the), filler (just/really/basically), pleasantries
- Short synonyms: big not extensive, fix not "implement a solution for"
- Code blocks unchanged, technical terms exact
- Pattern: `[thing] [action] [reason]. [next step].`

## Continuing development — use the skill

For any dev task on this repo (resume work, new phase/PROMPT, implement/fix, or
before staging), invoke the **`audiomanager-dev`** skill (`/audiomanager-dev`). It
loads the orient→plan→implement→verify→review loop, the exact verify gate, the
phase + Codex-review process, the file map, and the token-discipline rules — so the
session stays correct and cheap. Skill lives in the main repo `.claude/skills/`
(local-only; `.claude/` is gitignored). If absent (fresh clone / worktree), the
process below still applies.

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

## Audio Architecture

Current state:
- **MixerEngine**: N inputs → 1 output (max 8 inputs), per-input gain/mute, metering with clipping
- **AudioGraph**: Input/output nodes, flexible routing, per-route controls
- **Passthrough**: Single input → output (Phase 4+ deprecated, kept as reference)
- **Routing**: Route struct with gain/mute/enable states

Pro features roadmap:
1. Virtual audio output (like Voicemeeter loopback)
2. Multiple outputs per route / output grouping
3. Streaming DSP: compressor, noise gate, soft limiter, high-pass filter, ducking
4. Advanced metering: RMS, LUFS, spectrum
5. Preset snapshots (routes + gains + effects)
6. Console UI: faders, meter bridge, solo/quick-mute
