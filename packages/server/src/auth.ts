import type { FastifyReply, FastifyRequest } from 'fastify';
import { safeTokenEquals } from '@tracevault/core';

function getBearerToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth) return null;
  const [scheme, token] = auth.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

function reject(reply: FastifyReply): void {
  reply
    .code(401)
    .header('WWW-Authenticate', 'Bearer realm="tracevault"')
    .send({ error: 'Unauthorized' });
}

export function createBearerAuth(
  expectedToken: string
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const token = getBearerToken(request);
    if (!token || !safeTokenEquals(expectedToken, token)) {
      reject(reply);
      return;
    }
  };
}

export function parseBearer(request: FastifyRequest): string | null {
  return getBearerToken(request);
}
