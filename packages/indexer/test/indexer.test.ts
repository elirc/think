import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig, type AdapterProjectRef, type Session, type SessionRef, TraceVaultService } from '@tracevault/core';
import { TraceIndexer } from '../src/lib.js';

describe('indexer search', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('syncs and searches content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tracevault-'));
    roots.push(root);

    const project: AdapterProjectRef = {
      id: 'project-1',
      path: root,
      name: 'project-1',
      displayPath: root,
      lastActivityAt: '2026-01-01T00:00:00.000Z'
    };

    const sessionRef: SessionRef = {
      id: 'session-1',
      projectId: project.id,
      sourceSessionRef: join(root, 'session.json'),
      updatedAt: '2026-01-01T00:00:01.000Z'
    };

    const session: Session = {
      id: sessionRef.id,
      sourceId: 'claude',
      projectId: project.id,
      sourceSessionRef: sessionRef.sourceSessionRef,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      model: 'test-model',
      metadata: {},
      turns: [
        {
          index: 0,
          timestamp: '2026-01-01T00:00:00.000Z',
          userText: 'please fix auth middleware',
          assistantText: 'I fixed auth middleware',
          thinkingBlocks: ['thinking about auth'],
          toolCalls: [{ name: 'read_file', args: '{"path":"src/auth.ts"}' }],
          toolResults: [],
          tokenUsage: { prompt: 10, completion: 15 }
        }
      ],
      errors: [],
      filesReferenced: []
    };

    const adapter = {
      sourceId: 'claude' as const,
      displayName: 'Mock Claude',
      rootPath: root,
      async detect() {
        return true;
      },
      async listProjects() {
        return [project];
      },
      async listSessions() {
        return [sessionRef];
      },
      async readSession() {
        return session;
      },
      asSource(enabled: boolean) {
        return {
          id: 'claude' as const,
          displayName: 'Mock Claude',
          rootPath: root,
          enabled
        };
      }
    };

    const config = defaultConfig();
    config.index.path = join(root, 'index.duckdb');
    const service = new TraceVaultService(config, [adapter]);

    const indexer = new TraceIndexer(config.index.path);
    await indexer.init();
    await indexer.sync(service);

    const rows = await indexer.search('auth');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.text.toLowerCase()).toContain('auth');

    const stats = await indexer.stats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalTurns).toBe(1);
  });
});
