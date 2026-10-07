# TraceVault

TraceVault is a local-first trace browser for AI coding assistant conversations.

It scans the local directories used by Claude Code, Codex CLI, Gemini CLI, Kimi Code and
Copilot CLI, normalizes every supported file it finds into one schema, and exposes the
result through:

- CLI
- TUI (blessed)
- Web UI (full + lite)
- REST API (Fastify, with Swagger)
- A minimal JSON-over-stdio / JSON-over-HTTP tool server modelled on MCP (see the MCP section for what it does and does not implement)

This README was written from the source in this repository. Commands are listed as they
are defined in `package.json` files and Commander definitions; no output shown here was
captured from a run.

## What problem it addresses

Assistant transcripts live in different directories and formats, which makes it hard to
search history across tools, inspect a failing agent session, or share a transcript
without leaking secrets and local paths. TraceVault puts one read-only abstraction over
those directories, plus redacted export and a path allowlist for "open in editor" actions.

## Core design goals (and how far the code goes)

1. **Local-first.** Config, runtime state, bundles and the index all live under
   `~/.tracevault/` (`packages/core/src/config.ts:6,23-35`). The server binds to
   `127.0.0.1` by default (`config.ts:50-54`).
2. **Uniform model.** Everything maps to `Source -> Project -> Session -> Turn`
   (`packages/core/src/types.ts`).
3. **Search and stats.** A DuckDB-backed indexer with an in-memory fallback
   (`packages/indexer/src/lib.ts`), plus an index-free fallback in the service layer.
4. **One service for every interface.** CLI, TUI, REST and the tool server all call
   `TraceVaultService` (`packages/core/src/service.ts`).
5. **Path allowlist** for the one endpoint that accepts a path (`packages/core/src/security.ts`).
6. **Redacted export** with two built-in profiles (`packages/core/src/redaction.ts`).

## How the app works (end-to-end walkthrough)

### 1) Source adapters — one generic parser for every tool

`buildAdapters` (`packages/core/src/adapters/index.ts:7-15`) creates five adapters, but
they are all the same class: `ClaudeAdapter` and `CodexAdapter` are three-line subclasses
that only set a name (`adapters/claude.ts:3-7`, `adapters/codex.ts:3-7`), and Kimi, Gemini
and Copilot use `GenericSourceAdapter` (`adapters/stub.ts:13-17`). **No adapter knows any
tool's real on-disk format.** All behaviour lives in `FileSourceAdapter`
(`adapters/fileAdapter.ts`):

- **Projects** (`listProjects`, lines 48-67): every *top-level directory* under the
  source root becomes a project. Only if there are no subdirectories does the root itself
  become the single project (lines 61-64). Files sitting directly in a root that also has
  subdirectories are never scanned.
- **Sessions** (`listSessions`, lines 69-82): every file under the project, recursively,
  with extension `.json`, `.jsonl`, `.log`, `.md` or `.txt` (line 9). A session id is
  `sha256("<source>:<projectId>:<filePath>")` truncated to 20 hex chars (line 75,
  `packages/core/src/hash.ts:3-5`), so ids are stable as long as the file does not move.
  Any config or notes file with those extensions also becomes a "session".
- **Parsing** (`readSession`, lines 84-141) tries three strategies in order:
  1. whole-file JSON: an array of turns, or an object with `turns` or `messages`
     (lines 233-299). For an object, the **entire parsed object** becomes
     `session.metadata` (line 257);
  2. JSONL: one turn per line; an unparseable line becomes a plain-text turn plus a
     `ParseError` (lines 201-231);
  3. raw text: the whole file becomes one user turn plus a `ParseError` (lines 106-121).

  In practice step 3 almost never runs: `tryParseAsJsonLines` reports success whenever the
  file has at least one non-empty line, even if *every* line fails to parse (lines 202-230).
  A plain-text or Markdown file therefore becomes one turn per line, each with a
  `turn`-scoped "Invalid JSONL line" error; only an empty or whitespace-only file reaches
  the raw-text fallback.
- **Turn normalization** (`normalizeTurn`, lines 301-339) accepts `user`/`assistant`
  fields or `role` + `content`/`text`, `thinking` (string or array), `tool_calls`,
  `tool_results`, `token_usage`. Non-string values are `JSON.stringify`-ed (lines 341-346).
- **File references** (`extractFileRefs`, lines 348-355) use a regex that matches Windows
  drive paths and Unix paths under `/Users`, `/home`, `/var` or `/etc` only.

Parse problems are recorded in `session.errors` rather than thrown — the "fault tolerant"
claim is real — but read errors on the file itself (`readFile`, line 85) still throw.

### 2) Service layer

`TraceVaultService` (`packages/core/src/service.ts`) offers `listSources`,
`sourceStatus`, `listProjects`, `listSessions`, `listAllSessions`, `getSession`,
`resolveSession`, `searchFallback` and `usageStats`. There is no cache:
`resolveProjectCache` (lines 168-180) rebuilds the project map from disk on every call,
and `getSession` (lines 81-91) walks every project's file list until it finds the id.
`searchFallback` (103-125) and `usageStats` (127-166) call `getSession` once per session,
so each of them re-walks the whole tree once per session.

### 3) Indexing (`packages/indexer`)

`TraceIndexer.init` (`lib.ts:57-81`) dynamically imports the optional `duckdb` package
(`packages/indexer/package.json` lists it under `optionalDependencies`). On any failure it
logs to stderr and switches to `memory` mode.

- **Schema** (`setupSchema`, lines 326-402): `projects`, `sessions`, `turns`, `tools`,
  `thinking_blocks`, `stats_daily`, `parse_errors`. It then tries `INSTALL fts`,
  `LOAD fts` and `PRAGMA create_fts_index('turns', 'text')`, ignoring failures.
- **Sync** (lines 87-132): clears every table, then inserts every session inside one
  transaction, then rebuilds `stats_daily`. SQL is assembled by string concatenation with
  a `quote()` helper that doubles single quotes (lines 465-477).
- **Search** (lines 141-160): DuckDB mode runs `lower(text) LIKE '%q%'` capped at 200
  rows; the FTS index created above is **never queried**. Memory mode filters an array.
- **Stats** (lines 162-214) and **health** (216-241).
- **Watch** (lines 134-139): a full re-sync every `intervalMs` (default 15 s) in an
  endless loop.

CLI binary: `packages/indexer/bin/tracevault-indexer.js` imports `dist/index.js`, which
defines `sync`, `watch [--interval ms]`, `search <query> [--limit n]` and `stats`
(`packages/indexer/src/index.ts`). In memory mode, `search` and `stats` start a fresh
process with an empty index (they never call `sync`), so they return empty results.

### 4) REST server (`packages/server`)

`startServer` (`packages/server/src/index.ts:31-81`) loads config, generates and saves a
token if none exists (lines 33-37, printing it to stdout), runs one indexer sync if
`index.enabled` (46-49), builds the app, listens, and records the URL in
`~/.tracevault/runtime.json` (68-75). Nothing removes that entry on shutdown
(`clearRuntimeService` in `packages/core/src/runtime.ts:30-35` has no callers), so
`tracevault status` can list servers that are no longer running.

`createTraceVaultServer` (`packages/server/src/app.ts:86-386`):

- A `preHandler` hook applies bearer auth to any URL starting with `/api/v1`
  (lines 111-116). `/swagger`, `/share/:bundleId` and the static apps are unauthenticated.
- `POST /api/v1/export` (199-244) redacts the session with the requested profile (falling
  back to `safe` for an unknown name) and returns JSON, Markdown, or — for
  `format: "bundle"` — writes `session.json` and `session.md` under
  `~/.tracevault/bundles/<id>/`.
- `POST /api/v1/open-in` (246-273) checks `path` against `security.allowedBaseDirs`
  **plus every discovered project path** (line 254), then, if `app` is given, spawns
  `app` with the path as its only argument (260-266). The lite UI uses this with
  `code` and `cursor` (`apps/lite/src/LiteApp.tsx:81,90`).
- `POST /api/v1/ingest` (275-306) appends the posted `sessions[]` as one JSONL line to
  `~/.tracevault/ingest/<hash>.jsonl`. Nothing reads that directory back.
- Static hosting (325-357): the full web build at `/` in full mode, the lite build at `/`
  in lite mode or at `/lite/` otherwise. If no build exists, `/` serves a short HTML hint.

Both web apps keep the bearer token in `localStorage` under `tracevault_token`
(`apps/web/src/App.tsx:42-50`, `apps/lite/src/LiteApp.tsx:11-15`).

### 5) Tool server ("MCP")

`packages/mcp/src/index.ts` exposes nine tools: `list_sources`, `list_projects`,
`list_sessions`, `get_session_metadata`, `get_session_entries`, `search_sessions`,
`get_usage_stats`, `compare_sessions`, `export_session_bundle` (lines 59-137).

- **Pagination** (lines 28-44): the cursor is the base64url of an integer offset; limit
  is clamped to 1-200. `list_sessions`, `get_session_entries` and `search_sessions` are
  paginated. `search_sessions` fetches at most 500 hits and pages over those (lines 88-92).
- `export_session_bundle` (120-135) computes a bundle id and returns a session summary;
  unlike the REST `bundle` format it writes nothing to disk.
- **Protocol** (151-272): requests are bare JSON objects with `method` = `tools/list` or
  `tools/call`. There is no `jsonrpc` field, no `initialize` handshake and no capability
  negotiation, so standard MCP clients will not connect to it as-is. The stdio transport
  also prints a non-JSON `[tracevault-mcp] stdio transport ready` line to stdout
  (line 192). The HTTP transport serves `POST /mcp` with the same bearer check (224-251).

### 6) CLI + TUI (`packages/cli`)

`tracevault` with no arguments launches the TUI (`packages/cli/src/index.ts:361-364`).
TUI keys (`packages/cli/src/tui.ts:230-273`): `/` filter projects, `s` cycle source
filter, `t` toggle tree/flat, `e` export the selected session with the `safe` profile to
the current directory, `esc` scroll to top or refocus the session list, `q`/`Ctrl-C` quit.

The setup wizard (`packages/cli/src/setup.ts:40-77`) asks, per source, whether to enable
it and which path to use, then asks for the allowlist, symlink resolution, browser-open
and index-watch preferences, and saves the config.

## Security model

### Bearer auth

- `packages/server/src/auth.ts:20-30` rejects missing or mismatched tokens with 401 and
  `WWW-Authenticate: Bearer realm="tracevault"`.
- `safeTokenEquals` (`packages/core/src/token.ts:7-13`) uses `timingSafeEqual` after an
  early length check, and returns `false` when either side is empty — so a server with an
  empty token refuses everything instead of accepting everything.
- Tokens are 32 random bytes, base64url (`token.ts:3-5`). `TRACEVAULT_API_TOKEN`
  overrides the configured token (`config.ts:140`).

### Path allowlist

`assertAllowedPath` (`packages/core/src/security.ts:39-53`) expands `~`, resolves to an
absolute path, resolves symlinks with `realpathSync` when the path exists (lines 9-27),
canonicalizes every base dir the same way, and requires the target to start with one of
them plus a path separator (lines 29-37). Two limits worth knowing:

- a path that does not exist is returned unresolved (lines 13-15), so symlinked parent
  directories are not followed for it;
- the prefix comparison lower-cases both sides (line 36), which is right for Windows and
  macOS defaults but treats `/home/u/Dev` and `/home/u/dev` as the same directory on a
  case-sensitive Linux file system.

### Redaction

`redactText` (`packages/core/src/redaction.ts:43-55`) applies, depending on the profile:
secret patterns (`api_key=`, `token=`, `sk-…`, `ghp_…`, lines 3-8) plus a Shannon-entropy
check that replaces any whitespace-delimited token of 24+ characters with entropy ≥ 3.7
(lines 33-39); absolute paths (same regex family as the adapter, line 10); and fenced
code blocks (line 11). Profiles (`config.ts:60-66`):

- `safe` — secrets, paths and fenced blocks stripped (the default)
- `internal` — secrets stripped, paths and content kept

`redactSession` (lines 57-77) redacts turn text, thinking blocks, tool-call args and tool
results, blanks `sourceSessionRef` and `filesReferenced` when paths are stripped — and
passes every other field through unchanged (see Senior review #3).

## Configuration and runtime files

- `~/.tracevault/config.json` — created with defaults on first load
  (`config.ts:118-129`). Defaults (`config.ts:37-77`): Claude, Kimi, Copilot and Codex
  enabled, Gemini disabled; allowlist `~/dev`, `~/work`; host `127.0.0.1`, port `0`
  (OS-assigned); index at `~/.tracevault/index.duckdb`; redaction default `safe`.
- Environment overrides (`config.ts:136-143`): `TRACEVAULT_SERVER_HOST`,
  `TRACEVAULT_SERVER_PORT`, `TRACEVAULT_API_TOKEN`, `TRACEVAULT_INDEX_PATH`.
- `~/.tracevault/runtime.json` — services, PIDs and URLs (`packages/core/src/runtime.ts`).
- `~/.tracevault/bundles/`, `~/.tracevault/ingest/` — written by the REST server.

`index.watch` and the whole `remote` block are saved and editable but **not read by any
code** (the setup wizard asks about `index.watch` at `setup.ts:72`); remote ingestion is
"off" only in the sense that nothing pushes unless you run `tracevault agent watch`.

## REST API surface

All under bearer auth:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/health` | mode, indexer health, project and session counts (walks every source) |
| `GET /api/v1/sources` | enabled + detected status per source |
| `GET /api/v1/projects` | all projects, newest activity first |
| `GET /api/v1/projects/{id}/sessions` | session refs for one project |
| `GET /api/v1/sessions/{id}` | full normalized session (unredacted) |
| `GET /api/v1/search?q=...&limit=...` | indexer search, falling back to `searchFallback` |
| `GET /api/v1/stats` | indexer stats, falling back to `usageStats` |
| `GET /api/v1/indexer/health` | indexer mode and counts |
| `POST /api/v1/export` | `{ sessionId, format: json|md|bundle, profile }` |
| `POST /api/v1/open-in` | `{ path, app? }` |
| `POST /api/v1/ingest` | `{ workspaceName, workspaceFingerprint, sessions[] }` |

Unauthenticated: `GET /swagger`, `GET /share/{bundleId}` (reports whether a bundle exists
and its on-disk path).

## Repository layout

- `packages/core` — types, config, adapters, service, runtime state, path security, redaction, token helpers
- `packages/indexer` — `TraceIndexer` + `tracevault-indexer` CLI
- `packages/server` — Fastify app, bearer auth, REST routes, static hosting
- `packages/mcp` — tool server (stdio + HTTP)
- `packages/cli` — Commander CLI, blessed TUI, enquirer setup wizard
- `apps/web` — full React UI
- `apps/lite` — small React debug UI (health, sources, open-in)

## Quick start

Prerequisites: Node.js 20+ (Node 22 typings are used) and Corepack; the repo pins
`pnpm@10.6.1` (`package.json:5`).

```bash
corepack pnpm install
corepack pnpm build        # pnpm -r build (tsc per package, vite build for apps/web and apps/lite)
corepack pnpm test         # vitest run over packages/**/test/**/*.test.ts
corepack pnpm typecheck
corepack pnpm lint
```

Generate a token and configure:

```bash
corepack pnpm --filter @tracevault/cli exec tracevault token
corepack pnpm --filter @tracevault/cli exec tracevault setup
```

Run services:

```bash
corepack pnpm --filter @tracevault/cli exec tracevault serve --port 0
corepack pnpm --filter @tracevault/cli exec tracevault serve lite --port 0
corepack pnpm --filter @tracevault/cli exec tracevault serve mcp --transport stdio
corepack pnpm --filter @tracevault/cli exec tracevault serve mcp --transport http --port 0
```

Run the indexer manually:

```bash
corepack pnpm --filter @tracevault/indexer exec tracevault-indexer sync
corepack pnpm --filter @tracevault/indexer exec tracevault-indexer search auth
corepack pnpm --filter @tracevault/indexer exec tracevault-indexer stats
```

For development, root `pnpm dev` runs the server with `tsx watch` and the web app's dev
server together (`package.json:8`). Read Senior review #1 before relying on
`tracevault <subcommand>` from the built CLI.

## CLI commands

Defined in `packages/cli/src/index.ts`:

- `tracevault` — TUI
- `tracevault setup`, `token`, `status`, `doctor`
- `tracevault sources list|status`
- `tracevault projects list|tree|summary`
- `tracevault sessions list [--project <id>]|view <id>|resolve <id>`
- `tracevault export session <id> [--format md|json] [--profile safe] [--out <dir>]` (default format `md`)
- `tracevault serve [--port] [--host] [--no-open]`, `serve lite`, `serve mcp [--transport stdio|http] [--port]`
- aliases `serve-lite`, `serve-mcp`
- `tracevault index-sync`
- `tracevault config security.allowedBaseDirs add <dir>`
- `tracevault agent watch --push <url> --token <token> [--interval ms]`

`agent watch` (lines 318-359) polls every 20 s by default and pushes each session id **once**:
ids go into an in-memory `seen` set, so later changes to a session are never re-sent, and
a restart re-sends everything.

## Testing coverage

Four test files run under Vitest (`vitest.config.ts`):

- `packages/core/test/security.test.ts` — allowlist accepts a descendant; a symlink
  escape is rejected. If creating the symlink/junction fails, the test **returns early and
  passes** (lines 40-44), so on a machine without symlink permission the escape case is not
  exercised.
- `packages/core/test/adapter.test.ts` — one JSON-object session parsed into two turns.
  JSONL, raw-text fallback and `messages` arrays have no test.
- `packages/indexer/test/indexer.test.ts` — sync + search + stats with a mock adapter;
  passes in either DuckDB or memory mode, so it does not prove DuckDB works.
- `packages/server/test/auth.test.ts` — the bearer hook in isolation (401 with header, 200
  with token). No route of `createTraceVaultServer` is tested; redaction, the tool server,
  the CLI and both web apps have no tests.

## Exercises

1. **Goal:** see how a directory becomes projects.
   **Check:** point the `claude` source at a temp folder containing `a/x.jsonl`,
   `b/y.json` and a root-level `z.txt`; `tracevault projects list` lists two projects and
   `tracevault sessions list` never shows `z.txt`.
2. **Goal:** exercise every parser path.
   **Check:** add a JSONL file with one broken line, a three-line plain `.txt` file and an
   empty `.txt` file. `tracevault sessions view <id>` shows one `turn`-scoped error for the
   first, three `turn`-scoped errors for the second, and one `session`-scoped
   "raw text fallback" error for the third.
3. **Goal:** confirm the `metadata` gap in redaction.
   **Check:** export a JSON-object session containing `sk-` plus 20 letters in a turn with
   `--format json --profile safe`; the string is `[REDACTED_SECRET]` under `turns` but still
   present under `metadata.turns`.
4. **Goal:** prove which search the indexer runs.
   **Check:** with DuckDB available, search for a substring in the middle of a word (e.g.
   `uth` for `auth`); it matches, which full-text search on tokens would not.
5. **Goal:** add a real test for the JSONL path.
   **Check:** a new case in `adapter.test.ts` asserts `turns.length` and `errors.length`
   for a three-line file with one bad line, and fails if `tryParseAsJsonLines` is removed.
6. **Goal:** fix the stats fallback (review #5).
   **Check:** with an indexer whose `stats()` rejects, `GET /api/v1/stats` returns the
   `usageStats` shape instead of a 500.

## Senior review (findings from reading the code)

1. **Importing the CLI starts extra servers.** `packages/server/src/index.ts:83-93` and
   `packages/mcp/src/index.ts:274-283` decide they are "main" when `process.argv[1]` ends
   in `index.js` or `index.ts`. The CLI entry is `packages/cli/dist/index.js`
   (`packages/cli/package.json` `bin`), and it imports both packages
   (`packages/cli/src/index.ts:15-16`). So when the CLI runs, both checks are true: any
   `tracevault ...` command will also start a full web server and a stdio tool server, and
   the stdio "ready" line goes to the same stdout the CLI prints JSON on. Use
   `import.meta.url === pathToFileURL(process.argv[1]).href` or separate bin files.
2. **`open-in` launches any program.** `app` comes straight from the request body and is
   passed to `spawn` (`packages/server/src/app.ts:260-266`); only the *argument* is
   allowlisted. Anyone holding the token can run an arbitrary executable. Allowlist the
   editor names instead. The allowlist also silently includes every discovered project
   path (line 254).
3. **Redaction misses `metadata` and `errors`.** `redactSession` spreads the session
   (`redaction.ts:58`) and only rewrites turns. For JSON-object files, `metadata` is the
   whole original document (`fileAdapter.ts:257`), so `safe` JSON exports and bundle
   `session.json` files carry the unredacted conversation. `errors[].context` holds file
   paths and the first 120 characters of bad lines (`fileAdapter.ts:119,216`).
4. **The index is empty during every sync.** `sync` deletes all rows before `BEGIN`
   (`lib.ts:88-101`), and DuckDB runs those deletes as their own statements, so searches
   during a sync see nothing, and a failed sync rolls back the inserts but not the deletes.
   Move `clearTables` inside the transaction.
5. **Stats fallback never fires.** `return indexer.stats();` inside `try` without `await`
   (`app.ts:177-183`) returns the promise before it rejects, so the `catch` is dead and a
   failing indexer produces a 500. The search route awaits correctly (line 165).
6. **Quadratic disk walks.** `searchFallback` and `usageStats` call `getSession` per
   session, and `getSession` re-lists every project and session file (`service.ts:81-91`,
   `103-166`). The indexer's `sync` does the same (`lib.ts:112-114`), and `watch` repeats it
   every 15 seconds.
7. **Modes disagree on tool counts.** DuckDB mode stores tool *results* in the `tools`
   table with `tool_name = 'tool_result'` (`lib.ts:296-301`), so `toolFrequency` gains a
   `tool_result` entry that memory mode never reports.
8. **FTS is set up but unused, and the LIKE query is mis-escaped.** `search` doubles single
   quotes when building the pattern and `quote()` doubles them again (`lib.ts:144,148,465-467`),
   so a query such as `don't` searches for `don''t` and finds nothing. `%` and `_` are not
   escaped, so `_` matches any character.
9. **Ingest is unbounded.** `POST /api/v1/ingest` appends whatever it receives, with no size
   cap beyond Fastify's default body limit and no reader on the other side (`app.ts:275-306`).
10. **The tool server is not MCP-compatible** (no JSON-RPC envelope or `initialize`), so the
    "MCP server" label needs that qualifier until the official SDK is wired in.

## Known runtime notes

1. **DuckDB native binding.** If the optional `duckdb` package cannot load, the indexer logs
   `DuckDB unavailable, using memory fallback` to stderr and keeps running in memory. Under
   pnpm, native packages need their build scripts approved before the binding is compiled.
2. **Best-effort parsing.** Assistant trace formats change; the parser keeps parse errors in
   the normalized output instead of failing, but it has no per-tool knowledge.

## Roadmap ideas

- Wire the official MCP SDK (JSON-RPC, `initialize`, capability negotiation)
- Query the FTS index, or add an embedding/vector search mode
- Source-specific parsers and metadata enrichers
- Prometheus metrics endpoint
- Bundle sharing UI with explicit share-preview diffs

## Screenshots

`docs/screenshots/` contains only a `.gitkeep`; the planned images (`tui.png`,
`web-dashboard.png`, `web-explorer.png`, `swagger.png`) have not been added.
