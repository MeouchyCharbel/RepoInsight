import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { HttpError, parse } from '../errors.js';
import type { UserDoc } from '../types.js';
import { DUMMY_HASH, verifyPassword } from './passwords.js';
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, deleteSession } from './sessions.js';

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export interface AuthRouteOptions {
  cookieSecure: boolean;
  loginRateLimit: number;
}

/** preHandler: rejects requests without a valid session. */
export async function requireAuth(req: FastifyRequest) {
  if (!req.principal) throw new HttpError(401, 'unauthenticated', 'Sign in required');
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOptions) {
  const db = app.db;

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: opts.cookieSecure,
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: opts.loginRateLimit, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { username, password } = parse(loginBody, req.body);
      const user = await db.collection<UserDoc>('users').findOne({ username });
      // Always run one hash verification so timing does not reveal whether the user exists.
      const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok || user.disabled) {
        await audit(db, {
          actor_id: user?.user_id ?? null,
          action: 'auth.login',
          outcome: 'denied',
          ip: req.ip,
        });
        throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
      }
      const token = await createSession(db, user.user_id);
      await audit(db, { actor_id: user.user_id, action: 'auth.login', outcome: 'success', ip: req.ip });
      setCookie(reply, token);
      return { user: { id: user.user_id, username: user.username } };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => ({
    user: { id: req.principal!.userId, username: req.principal!.username },
  }));
}
