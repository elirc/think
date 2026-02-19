# TraceVault

TraceVault is a local-first trace platform for AI coding assistant conversations.

It discovers traces written by local tools (Claude Code, Codex CLI, Gemini CLI, Kimi Code, Copilot CLI), normalizes them into one schema, and exposes them consistently through:

- CLI
- TUI
- Web UI (full + lite)
- REST API (with Swagger)
- MCP server (stdio + HTTP)

## What Problem TraceVault Solves

AI coding assistants generate valuable context, but that context is fragmented:

- Every tool stores traces in different directories and formats.
- Teams can’t easily search history across assistants and projects.
- Debugging agent failures is hard without a unified session view.
- Exporting traces safely is risky without structured redaction.
- Opening local paths from remote/UI calls can be unsafe if path checks are weak.

TraceVault solves this by creating a single, secure abstraction over heterogeneous local traces.

## Core Design Goals

1. Local-first by default
- Data lives on your machine.
- Remote ingestion is optional and off by default.

2. Uniform abstraction
- All sources map into `Source -> Project -> Session -> Turn`.

3. Fast exploration and search
- DuckDB indexer (`tracevault-indexer`) for sync/search/stats.
- Graceful fallback paths when indexer/DuckDB is unavailable.

4. Agent-grade interfaces
- MCP tools with pagination and consistent payload shapes.

5. Security-first path handling
- Canonicalization + symlink-aware allowlist enforcement for path actions.

6. Safe sharing/export
- Redaction profiles for secrets, paths, and file-content blocks.

## How the App Works (End-to-End)

### 1) Source discovery and normalization

`packages/core` contains source adapters and the shared service layer.

- Adapters detect source roots and enumerate projects/sessions.
- Sessions are parsed defensively (JSON, JSONL, text fallback).
- Parse errors are captured in-session instead of crashing ingestion.

Canonical model includes:

- `Source`
- `Project`
- `Session`
- `Turn` (user text, assistant text, thinking blocks, tool calls/results, token usage)

### 2) Service layer

`TraceVaultService` provides one API used by CLI, server, and MCP:

- `listSources`, `sourceStatus`
- `listProjects`, `listSessions`, `listAllSessions`
- `getSession`, `resolveSession`
- `searchFallback`, `usageStats`

This avoids duplicated logic across interfaces.

### 3) Indexing and analytics

`packages/indexer` implements `TraceIndexer`:

- Initializes DuckDB schema if binding is available.
- Attempts `INSTALL/LOAD fts` and FTS index creation.
- Supports:
  - `tracevault-indexer sync`
  - `tracevault-indexer watch`
  - `tracevault-indexer search`
  - `tracevault-indexer stats`

If DuckDB native binding is missing, indexer falls back to in-memory mode and still serves search/stats behavior.

### 4) REST + Swagger

`packages/server` (Fastify) serves:

- `/api/v1/*` endpoints (Bearer-protected)
- `/swagger` OpenAPI UI
- static full web app
- static lite app

Server writes runtime info (PID/host/port/url/start time) into `~/.tracevault/runtime.json`.

### 5) MCP

`packages/mcp` provides:

- stdio transport
- HTTP transport (`/mcp`, Bearer-protected)

Tools:

- `list_sources`
- `list_projects`
- `list_sessions`
- `get_session_metadata`
- `get_session_entries` (paginated)
- `search_sessions`
- `get_usage_stats`
- `compare_sessions`
- `export_session_bundle`

All high-volume tools are cursor/limit paginated.

### 6) CLI + TUI

`packages/cli` is the main user entrypoint.

CLI capabilities include setup, source/project/session traversal, export, serve modes, token/status/doctor, and remote-agent watch/push.

TUI (blessed) provides a 3-pane workflow:

- left: project browser
- middle: sessions list
- right: session viewer

Keybindings:

- `/` filter
- `s` source cycle
- `t` tree/flat toggle
- `e` export
- `esc` back
- `q` quit

## Security Model

### Bearer auth

- REST (`/api/v1/*`) and MCP HTTP require bearer token.
- Token comparison uses constant-time equality.
- Unauthorized responses include `WWW-Authenticate` header.

### Path sandboxing

Path-accepting operations (`/api/v1/open-in`) enforce:

- path expansion + canonicalization
- optional symlink resolution
- base directory allowlist checks

This blocks common symlink traversal bypass patterns.

### Redaction

Two default profiles:

- `safe` (paths + likely secrets + code blocks stripped)
- `internal` (secrets stripped, keeps paths/content)

Used for exports and bundle/share pipelines.

## Configuration and Runtime Files

### Config

`~/.tracevault/config.json`

Holds source settings, security allowlist, server/index settings, redaction profiles, remote options, and API token.

### Runtime state

`~/.tracevault/runtime.json`

Tracks active services and auto-selected ports.

## REST API Surface

Base endpoints:

- `GET /api/v1/health`
- `GET /api/v1/sources`
- `GET /api/v1/projects`
- `GET /api/v1/projects/{id}/sessions`
- `GET /api/v1/sessions/{id}`
- `GET /api/v1/search?q=...`
- `GET /api/v1/stats`
- `GET /api/v1/indexer/health`
- `POST /api/v1/export`
- `POST /api/v1/open-in`
- `POST /api/v1/ingest`

Swagger UI:

- `/swagger`

## Repository Layout

- `packages/core`: types, config, adapters, service, runtime, security, redaction
- `packages/indexer`: indexer logic + CLI binary
- `packages/server`: Fastify app + auth + REST routes + static serving
- `packages/mcp`: MCP transports + tool execution
- `packages/cli`: CLI command surface + TUI + setup wizard
- `apps/web`: full React UI
- `apps/lite`: lightweight React debug UI

## Quick Start

### Prerequisites

- Node.js 20+
- Corepack enabled

### Install

```bash
corepack pnpm install
```

### Build and test

```bash
corepack pnpm build
corepack pnpm test
```

### Generate token and configure

```bash
corepack pnpm --filter @tracevault/cli exec tracevault token
corepack pnpm --filter @tracevault/cli exec tracevault setup
```

### Run full server

```bash
corepack pnpm --filter @tracevault/cli exec tracevault serve --port 0
```

### Run lite server

```bash
corepack pnpm --filter @tracevault/cli exec tracevault serve lite --port 0
```

### Run MCP

```bash
corepack pnpm --filter @tracevault/cli exec tracevault serve mcp --transport stdio
corepack pnpm --filter @tracevault/cli exec tracevault serve mcp --transport http --port 0
```

### Run indexer manually

```bash
corepack pnpm --filter @tracevault/indexer exec tracevault-indexer sync
corepack pnpm --filter @tracevault/indexer exec tracevault-indexer search auth
corepack pnpm --filter @tracevault/indexer exec tracevault-indexer stats
```

## CLI Commands

Primary:

- `tracevault` (launches TUI)
- `tracevault setup`
- `tracevault token`
- `tracevault status`
- `tracevault doctor`

Source/project/session:

- `tracevault sources list|status`
- `tracevault projects list|tree|summary`
- `tracevault sessions list|view|resolve`

Export:

- `tracevault export session <id> --format md|json --profile safe`

Serve:

- `tracevault serve [--port 0] [--no-open]`
- `tracevault serve lite`
- `tracevault serve mcp`

Security config helper:

- `tracevault config security.allowedBaseDirs add <dir>`

Remote agent helper:

- `tracevault agent watch --push <url> --token <token>`

## Testing Coverage

Included unit tests:

- allowlist + symlink enforcement:
  - `packages/core/test/security.test.ts`
- adapter parsing:
  - `packages/core/test/adapter.test.ts`
- indexer search/stats pipeline:
  - `packages/indexer/test/indexer.test.ts`
- auth middleware behavior:
  - `packages/server/test/auth.test.ts`

## Known Runtime Notes

1. DuckDB native binding
- If DuckDB native binary is unavailable, indexer logs fallback and runs in memory mode.
- To enable native DuckDB in locked pnpm environments, approve package build scripts (`duckdb`).

2. Best-effort source parsing
- Local assistant trace formats evolve over time.
- Parsers are intentionally fault-tolerant and preserve parse errors in normalized output.

## Roadmap Ideas

- Full official MCP SDK wiring + richer protocol negotiation
- Optional embedding/vector search mode
- Additional source-specific parsers and metadata enrichers
- Prometheus metrics endpoint
- Bundle sharing UI with explicit share-preview diffs

## Screenshots

Placeholders:

- `docs/screenshots/tui.png`
- `docs/screenshots/web-dashboard.png`
- `docs/screenshots/web-explorer.png`
- `docs/screenshots/swagger.png`
