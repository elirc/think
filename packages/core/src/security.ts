import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { expandHomePath } from './config.js';

export interface AllowlistOptions {
  resolveSymlinks: boolean;
}

export function canonicalizePath(input: string, options: AllowlistOptions): string {
  const expanded = expandHomePath(input);
  const absolute = resolve(expanded);

  if (!existsSync(absolute)) {
    return absolute;
  }

  if (options.resolveSymlinks) {
    return realpathSync(absolute);
  }

  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    return realpathSync(absolute);
  }

  return absolute;
}

function normalizeForCompare(pathValue: string): string {
  return pathValue.endsWith(sep) ? pathValue : `${pathValue}${sep}`;
}

export function isWithinBaseDir(targetPath: string, baseDir: string): boolean {
  const target = normalizeForCompare(resolve(targetPath));
  const base = normalizeForCompare(resolve(baseDir));
  return target.toLowerCase().startsWith(base.toLowerCase());
}

export function assertAllowedPath(
  inputPath: string,
  allowedBaseDirs: string[],
  options: AllowlistOptions
): string {
  const target = canonicalizePath(inputPath, options);
  const resolvedBases = allowedBaseDirs.map((base) => canonicalizePath(base, options));

  const allowed = resolvedBases.some((base) => isWithinBaseDir(target, base));
  if (!allowed) {
    throw new Error(`Path is outside allowed base dirs: ${target}`);
  }

  return target;
}
