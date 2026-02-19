import { createHash } from 'node:crypto';

export function stableHash(input: string, length = 20): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}
