import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const COOKIE = 'orch_token';
const MAX_AGE_S = 30 * 24 * 3600;

const loginBody = z.object({ token: z.string().min(1) });

/**
 * Single owner token. Every /api and /ws request needs it, either as `Authorization: Bearer <token>`
 * (curl, scripts) or as the HttpOnly cookie set by POST /api/login (dashboard; browsers can't set
 * headers on a WebSocket handshake, but they do send cookies).
 */
export function registerAuth(app: FastifyInstance, ownerToken: string) {
  const expected = digest(ownerToken);
  const matches = (candidate: string | undefined) =>
    candidate !== undefined && timingSafeEqual(digest(candidate), expected);

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?', 1)[0]!;
    const protectedPath = path.startsWith('/api/') || path === '/ws';
    if (!protectedPath || path === '/api/login') return;

    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (matches(bearer) || matches(readCookie(req.headers.cookie, COOKIE))) return;
    return reply.status(401).send({ error: 'Unauthorized' });
  });

  app.post('/api/login', async (req, reply) => {
    if (!matches(loginBody.parse(req.body).token)) return reply.status(401).send({ error: 'Wrong token' });
    reply.header(
      'set-cookie',
      `${COOKIE}=${encodeURIComponent(ownerToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_S}`,
    );
    return reply.status(204).send();
  });
}

function digest(s: string) {
  return createHash('sha256').update(s).digest();
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return undefined; // malformed cookie: treat as missing
    }
  }
  return undefined;
}
