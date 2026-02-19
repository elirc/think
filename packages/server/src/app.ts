import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  assertAllowedPath,
  getTraceVaultDir,
  redactSession,
  stableHash,
  TraceVaultService,
  type Session,
  type TraceVaultConfig
} from '@tracevault/core';
import type { TraceIndexer } from '@tracevault/indexer';
import { createBearerAuth } from './auth.js';

export interface CreateServerOptions {
  config: TraceVaultConfig;
  service: TraceVaultService;
  indexer: TraceIndexer | null;
  mode: 'full' | 'lite';
}

function findExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function markdownExport(session: Session): string {
  const lines: string[] = [];
  lines.push(`# TraceVault Session ${session.id}`);
  lines.push('');
  lines.push(`- Source: ${session.sourceId}`);
  lines.push(`- Project: ${session.projectId}`);
  lines.push(`- Model: ${session.model ?? 'unknown'}`);
  lines.push(`- Started: ${session.startedAt ?? 'unknown'}`);
  lines.push(`- Updated: ${session.updatedAt ?? 'unknown'}`);
  lines.push('');

  for (const turn of session.turns) {
    lines.push(`## Turn ${turn.index}`);
    lines.push(`Timestamp: ${turn.timestamp ?? 'unknown'}`);
    lines.push('');
    lines.push('### User');
    lines.push(turn.userText || '_empty_');
    lines.push('');
    lines.push('### Assistant');
    lines.push(turn.assistantText || '_empty_');
    lines.push('');

    if (turn.thinkingBlocks.length > 0) {
      lines.push('### Thinking');
      for (const block of turn.thinkingBlocks) {
        lines.push('```text');
        lines.push(block);
        lines.push('```');
      }
    }

    if (turn.toolCalls.length > 0) {
      lines.push('### Tool Calls');
      for (const call of turn.toolCalls) {
        lines.push(`- ${call.name}: ${call.args}`);
      }
    }

    if (turn.toolResults.length > 0) {
      lines.push('### Tool Results');
      for (const result of turn.toolResults) {
        lines.push(`- (${result.status ?? 'ok'}) ${result.output}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

export async function createTraceVaultServer(options: CreateServerOptions) {
  const { config, service, indexer, mode } = options;
  const app = Fastify({ logger: false });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'TraceVault API',
        version: '0.1.0'
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer'
          }
        }
      }
    }
  });

  await app.register(swaggerUi, {
    routePrefix: '/swagger'
  });

  const authPreHandler = createBearerAuth(config.auth.token);
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/v1')) {
      await authPreHandler(request, reply);
    }
  });

  app.get('/api/v1/health', async () => {
    const projects = await service.listProjects();
    const sessions = await service.listAllSessions();
    const indexHealth = indexer ? await indexer.health() : { ready: false, mode: 'none', dbPath: config.index.path };

    return {
      ok: true,
      mode,
      indexer: indexHealth,
      dbPath: config.index.path,
      projectCount: projects.length,
      sessionCount: sessions.length
    };
  });

  app.get('/api/v1/sources', async () => {
    return service.sourceStatus();
  });

  app.get('/api/v1/projects', async () => {
    return service.listProjects();
  });

  app.get('/api/v1/projects/:id/sessions', async (request) => {
    const params = request.params as { id: string };
    return service.listSessions(params.id);
  });

  app.get('/api/v1/sessions/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const session = await service.getSession(params.id);
    if (!session) {
      reply.code(404);
      return { error: 'Session not found' };
    }
    return session;
  });

  app.get('/api/v1/search', async (request) => {
    const query = request.query as { q?: string; limit?: string };
    const q = query.q ?? '';
    const limit = Number(query.limit ?? '30');

    if (!q.trim()) return [];

    if (indexer) {
      try {
        const rows = await indexer.search(q, limit);
        return { mode: indexer.getMode(), results: rows };
      } catch {
        const fallback = await service.searchFallback(q, limit);
        return { mode: 'fallback', results: fallback };
      }
    }

    return { mode: 'fallback', results: await service.searchFallback(q, limit) };
  });

  app.get('/api/v1/stats', async () => {
    if (indexer) {
      try {
        return indexer.stats();
      } catch {
        return service.usageStats();
      }
    }
    return service.usageStats();
  });

  app.get('/api/v1/indexer/health', async () => {
    if (!indexer) {
      return {
        ready: false,
        mode: 'none',
        dbPath: config.index.path,
        message: 'Indexer is disabled'
      };
    }
    return indexer.health();
  });

  app.post('/api/v1/export', async (request, reply) => {
    const body = request.body as {
      sessionId?: string;
      format?: 'md' | 'json' | 'bundle';
      profile?: string;
    };

    if (!body.sessionId) {
      reply.code(400);
      return { error: 'sessionId is required' };
    }

    const session = await service.getSession(body.sessionId);
    if (!session) {
      reply.code(404);
      return { error: 'Session not found' };
    }

    const format = body.format ?? 'json';
    const profileName = body.profile ?? config.redaction.defaultProfile;
    const profile = config.redaction.profiles[profileName] ?? config.redaction.profiles.safe;
    const redacted = redactSession(session, profile);

    if (format === 'json') {
      return { format, profile: profileName, content: redacted };
    }

    if (format === 'md') {
      return { format, profile: profileName, content: markdownExport(redacted) };
    }

    const bundleSeed = JSON.stringify({ id: redacted.id, updatedAt: redacted.updatedAt, profileName });
    const bundleId = stableHash(bundleSeed, 32);
    const bundleDir = join(getTraceVaultDir(), 'bundles', bundleId);
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'session.json'), JSON.stringify(redacted, null, 2), 'utf8');
    writeFileSync(join(bundleDir, 'session.md'), markdownExport(redacted), 'utf8');

    return {
      format,
      profile: profileName,
      bundleId,
      bundlePath: bundleDir,
      shareUrl: `/share/${bundleId}`
    };
  });

  app.post('/api/v1/open-in', async (request, reply) => {
    const body = request.body as { path?: string; app?: string };
    if (!body.path) {
      reply.code(400);
      return { error: 'path is required' };
    }

    const projects = await service.listProjects();
    const allowedBaseDirs = [...new Set([...config.security.allowedBaseDirs, ...projects.map((project) => project.path)])];

    const resolved = assertAllowedPath(body.path, allowedBaseDirs, {
      resolveSymlinks: config.security.resolveSymlinks
    });

    if (body.app) {
      const child = spawn(body.app, [resolved], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    }

    return {
      ok: true,
      resolvedPath: resolved,
      launched: Boolean(body.app)
    };
  });

  app.post('/api/v1/ingest', async (request, reply) => {
    const body = request.body as {
      workspaceFingerprint?: string;
      workspaceName?: string;
      sessions?: unknown[];
    };

    if (!Array.isArray(body.sessions)) {
      reply.code(400);
      return { error: 'sessions[] is required' };
    }

    const workspace = body.workspaceName ?? 'unknown-workspace';
    const workspaceKey = stableHash(`${workspace}:${body.workspaceFingerprint ?? ''}`);
    const ingestDir = join(getTraceVaultDir(), 'ingest');
    mkdirSync(ingestDir, { recursive: true });

    const filePath = join(ingestDir, `${workspaceKey}.jsonl`);
    const payload = JSON.stringify({
      workspaceFingerprint: body.workspaceFingerprint ?? '',
      workspaceName: workspace,
      receivedAt: new Date().toISOString(),
      sessions: body.sessions
    });
    appendFileSync(filePath, `${payload}\n`, 'utf8');

    return {
      ok: true,
      storedAt: filePath,
      count: body.sessions.length
    };
  });

  app.get('/share/:bundleId', async (request, reply) => {
    const params = request.params as { bundleId: string };
    const bundleDir = join(getTraceVaultDir(), 'bundles', params.bundleId);
    const jsonPath = join(bundleDir, 'session.json');

    if (!existsSync(jsonPath)) {
      reply.code(404);
      return { error: 'Bundle not found' };
    }

    return {
      bundleId: params.bundleId,
      bundlePath: bundleDir,
      message: 'Bundle is available on disk; full web rendering is handled by the web app route.'
    };
  });

  const webDist = findExistingPath([
    join(process.cwd(), 'apps/web/dist'),
    join(process.cwd(), '../apps/web/dist'),
    join(dirname(fileURLToPath(import.meta.url)), '../../../apps/web/dist')
  ]);

  const liteDist = findExistingPath([
    join(process.cwd(), 'apps/lite/dist'),
    join(process.cwd(), '../apps/lite/dist'),
    join(dirname(fileURLToPath(import.meta.url)), '../../../apps/lite/dist')
  ]);

  if (mode === 'full' && webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: true
    });
  }

  if (mode === 'lite' && liteDist) {
    await app.register(fastifyStatic, {
      root: liteDist,
      prefix: '/',
      wildcard: true
    });
  } else if (liteDist) {
    await app.register(fastifyStatic, {
      root: liteDist,
      prefix: '/lite/',
      wildcard: true
    });
  }

  if (mode !== 'full' || !webDist) {
    app.get('/', async (_request, reply) => {
      if (mode === 'lite') {
        return reply.type('text/html').send(`
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>TraceVault Lite</title></head>
  <body>
    <h1>TraceVault Lite</h1>
    <p>Use /api/v1/* endpoints and /swagger for docs.</p>
  </body>
</html>`);
      }

      return reply.type('text/html').send(`
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>TraceVault</title></head>
  <body>
    <h1>TraceVault</h1>
    <p>Build web assets to enable full UI. API docs: <a href="/swagger">/swagger</a></p>
  </body>
</html>`);
    });
  }

  return app;
}

