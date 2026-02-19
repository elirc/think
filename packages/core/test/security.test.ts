import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertAllowedPath } from '../src/security.js';

describe('allowlist path security', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows direct descendant files', () => {
    const root = mkdtempSync(join(tmpdir(), 'tracevault-'));
    roots.push(root);
    const base = join(root, 'allowed');
    mkdirSync(base, { recursive: true });
    const file = join(base, 'notes.txt');
    writeFileSync(file, 'ok', 'utf8');

    const resolved = assertAllowedPath(file, [base], { resolveSymlinks: true });
    expect(resolved).toContain('notes.txt');
  });

  it('blocks symlink escapes outside allowlist', () => {
    const root = mkdtempSync(join(tmpdir(), 'tracevault-'));
    roots.push(root);
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    mkdirSync(allowed, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'nope', 'utf8');

    const link = join(allowed, 'escape');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      return;
    }

    expect(() => assertAllowedPath(join(link, 'secret.txt'), [allowed], { resolveSymlinks: true })).toThrow(
      /outside allowed base dirs/
    );
  });
});
