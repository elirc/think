import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSourceAdapter } from '../src/adapters/fileAdapter.js';

describe('file adapter parser', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses JSON session into normalized turns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tracevault-'));
    roots.push(root);
    const project = join(root, 'proj-a');
    mkdirSync(project, { recursive: true });

    const sessionFile = join(project, 'session.json');
    writeFileSync(
      sessionFile,
      JSON.stringify(
        {
          model: 'gpt-test',
          turns: [
            {
              timestamp: '2026-01-01T00:00:00.000Z',
              role: 'user',
              content: 'hello'
            },
            {
              timestamp: '2026-01-01T00:00:01.000Z',
              role: 'assistant',
              content: 'world',
              tool_calls: [{ name: 'read_file', args: { path: '/tmp/a' } }]
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    );

    const adapter = new FileSourceAdapter('custom', 'Custom', root);
    const projects = await adapter.listProjects();
    expect(projects.length).toBe(1);

    const sessions = await adapter.listSessions(projects[0]);
    expect(sessions.length).toBe(1);

    const session = await adapter.readSession(sessions[0]);
    expect(session.model).toBe('gpt-test');
    expect(session.turns.length).toBe(2);
    expect(session.turns[0]?.userText).toBe('hello');
    expect(session.turns[1]?.assistantText).toBe('world');
    expect(session.turns[1]?.toolCalls[0]?.name).toBe('read_file');
  });
});
