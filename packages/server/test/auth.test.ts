import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createBearerAuth } from '../src/auth.js';

describe('auth middleware', () => {
  it('returns 401 without token and 200 with token', async () => {
    const app = Fastify();
    app.addHook('preHandler', createBearerAuth('secret-token'));
    app.get('/protected', async () => ({ ok: true }));

    const unauthorized = await app.inject({ method: 'GET', url: '/protected' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['www-authenticate']).toContain('Bearer');

    const authorized = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer secret-token' }
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ ok: true });
  });
});
