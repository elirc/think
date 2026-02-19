import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ignore = new Set(['node_modules', '.git', '.pnpm-store', 'dist', 'coverage']);

function walk(dir, prefix = '') {
  const entries = readdirSync(dir).sort();
  for (const name of entries) {
    if (ignore.has(name)) continue;
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    console.log(rel);
    if (statSync(full).isDirectory()) {
      walk(full, rel);
    }
  }
}

walk(process.cwd());
