#!/usr/bin/env node
import { createInterface } from 'node:readline';
import Fastify from 'fastify';
import {
  generateSecureToken,
  loadConfig,
  redactSession,
  saveConfig,
  safeTokenEquals,
  stableHash,
  TraceVaultService,
  upsertRuntimeService,
  type Session,
  type SessionRef
} from '@tracevault/core';
import { createIndexerFromConfig, type TraceIndexer } from '@tracevault/indexer';

interface StartMcpOptions {
  transport: 'stdio' | 'http';
  port?: number;
}

interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

function encodeCursor(index: number): string {
  return Buffer.from(String(index)).toString('base64url');
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function paginate<T>(items: T[], cursor?: string, limit = 20): Paginated<T> {
  const safeLimit = Math.max(1, Math.min(200, limit));
  const start = decodeCursor(cursor);
  const slice = items.slice(start, start + safeLimit);
  const next = start + safeLimit < items.length ? encodeCursor(start + safeLimit) : null;
  return { items: slice, nextCursor: next };
}

function summarizeSession(session: Session) {
  return {
    id: session.id,
    sourceId: session.sourceId,
    projectId: session.projectId,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    model: session.model,
    turnCount: session.turns.length,
    errorCount: session.errors.length
  };
}

async function buildToolset(service: TraceVaultService, indexer: TraceIndexer | null) {
  return {
    async list_sources() {
      return service.sourceStatus();
    },

    async list_projects() {
      return service.listProjects();
    },

    async list_sessions(args: { projectId?: string; cursor?: string; limit?: number }) {
      let sessions: SessionRef[];
      if (args.projectId) sessions = await service.listSessions(args.projectId);
      else sessions = await service.listAllSessions();
      return paginate(sessions, args.cursor, args.limit ?? 30);
    },

    async get_session_metadata(args: { sessionId: string }) {
      const session = await service.getSession(args.sessionId);
      if (!session) return null;
      return summarizeSession(session);
    },

    async get_session_entries(args: { sessionId: string; cursor?: string; limit?: number }) {
      const session = await service.getSession(args.sessionId);
      if (!session) return null;
      return paginate(session.turns, args.cursor, args.limit ?? 30);
    },

    async search_sessions(args: { query: string; cursor?: string; limit?: number }) {
      const limit = args.limit ?? 30;
      const rows = indexer ? await indexer.search(args.query, 500) : await service.searchFallback(args.query, 500);
      return paginate(rows, args.cursor, limit);
    },

    async get_usage_stats() {
      if (indexer) return indexer.stats();
      return service.usageStats();
    },

    async compare_sessions(args: { leftId: string; rightId: string }) {
      const left = await service.getSession(args.leftId);
      const right = await service.getSession(args.rightId);
      if (!left || !right) {
        return { error: 'One or both sessions not found' };
      }

      const leftTools = left.turns.flatMap((turn) => turn.toolCalls.map((call) => call.name));
      const rightTools = right.turns.flatMap((turn) => turn.toolCalls.map((call) => call.name));

      return {
        left: summarizeSession(left),
        right: summarizeSession(right),
        diff: {
          turnDelta: left.turns.length - right.turns.length,
          onlyInLeftTools: [...new Set(leftTools.filter((name) => !rightTools.includes(name)))],
          onlyInRightTools: [...new Set(rightTools.filter((name) => !leftTools.includes(name)))]
        }
      };
    },

    async export_session_bundle(args: { sessionId: string; profile?: string }) {
      const session = await service.getSession(args.sessionId);
      if (!session) return null;

      const config = service.getConfig();
      const profileName = args.profile ?? config.redaction.defaultProfile;
      const profile = config.redaction.profiles[profileName] ?? config.redaction.profiles.safe;
      const redacted = redactSession(session, profile);
      const bundleId = stableHash(JSON.stringify({ id: redacted.id, updatedAt: redacted.updatedAt, profileName }), 32);

      return {
        bundleId,
        profile: profileName,
        session: summarizeSession(redacted)
      };
    }
  };
}

async function executeTool(
  toolset: Awaited<ReturnType<typeof buildToolset>>,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const fn = toolset[name as keyof typeof toolset] as ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  if (!fn) {
    return { error: `Unknown tool: ${name}` };
  }
  return fn(args);
}

export async function startMcpServer(options: StartMcpOptions): Promise<void> {
  const config = loadConfig();
  if (!config.auth.token) {
    config.auth.token = generateSecureToken();
    saveConfig(config);
    process.stdout.write(`[tracevault-mcp] generated token: ${config.auth.token}\n`);
  }

  const service = new TraceVaultService(config);
  const indexer = config.index.enabled ? await createIndexerFromConfig(config) : null;
  if (indexer) {
    await indexer.sync(service);
  }

  const toolset = await buildToolset(service, indexer);

  const listToolsPayload = {
    tools: [
      'list_sources',
      'list_projects',
      'list_sessions',
      'get_session_metadata',
      'get_session_entries',
      'search_sessions',
      'get_usage_stats',
      'compare_sessions',
      'export_session_bundle'
    ]
  };

  if (options.transport === 'stdio') {
    upsertRuntimeService({
      name: 'mcp-stdio',
      pid: process.pid,
      host: 'stdio',
      port: 0,
      url: 'stdio://tracevault',
      startedAt: new Date().toISOString()
    });

    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    process.stdout.write('[tracevault-mcp] stdio transport ready\n');

    rl.on('line', async (line) => {
      if (!line.trim()) return;

      let request: any;
      try {
        request = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify({ id: null, error: 'Invalid JSON' })}\n`);
        return;
      }

      if (request.method === 'tools/list') {
        process.stdout.write(`${JSON.stringify({ id: request.id ?? null, result: listToolsPayload })}\n`);
        return;
      }

      if (request.method === 'tools/call') {
        const name = request.params?.name as string;
        const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
        const result = await executeTool(toolset, name, args);
        process.stdout.write(`${JSON.stringify({ id: request.id ?? null, result })}\n`);
        return;
      }

      process.stdout.write(`${JSON.stringify({ id: request.id ?? null, error: 'Unsupported method' })}\n`);
    });

    return;
  }

  const app = Fastify({ logger: false });

  app.post('/mcp', async (request, reply) => {
    const auth = request.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!safeTokenEquals(config.auth.token, token ?? '')) {
      reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer realm="tracevault-mcp"')
        .send({ error: 'Unauthorized' });
      return;
    }

    const body = request.body as any;

    if (body.method === 'tools/list') {
      return { id: body.id ?? null, result: listToolsPayload };
    }

    if (body.method === 'tools/call') {
      const name = body.params?.name as string;
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      const result = await executeTool(toolset, name, args);
      return { id: body.id ?? null, result };
    }

    return { id: body.id ?? null, error: 'Unsupported method' };
  });

  const port = options.port ?? 0;
  await app.listen({ host: config.server.host, port });
  const address = app.server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind MCP server');
  }

  const url = `http://${config.server.host}:${address.port}/mcp`;
  upsertRuntimeService({
    name: 'mcp-http',
    pid: process.pid,
    host: config.server.host,
    port: address.port,
    url,
    startedAt: new Date().toISOString()
  });

  process.stdout.write(`[tracevault-mcp] http transport ready at ${url}\n`);
}

const isMain = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');
if (isMain) {
  const transport = process.argv.includes('--http') ? 'http' : 'stdio';
  const portIndex = process.argv.findIndex((arg) => arg === '--port');
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0;
  startMcpServer({ transport, port }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
