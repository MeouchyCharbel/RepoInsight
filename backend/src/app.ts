import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Db, MongoClient } from 'mongodb';
import { AclService } from './acl/service.js';
import { aclRoutes } from './acl/routes.js';
import { SESSION_COOKIE, resolveSession } from './auth/sessions.js';
import { authRoutes } from './auth/routes.js';
import { AclUnavailableError, HttpError } from './errors.js';
import { GitHubClient } from './ingest/github.js';
import { Importer } from './ingest/importer.js';
import { Inbox } from './ingest/inbox.js';
import { ingestRoutes } from './ingest/routes.js';
import { IngestStore } from './ingest/store.js';
import { repoRoutes } from './repos/routes.js';
import { docRoutes } from './docs/routes.js';
import { TraceBuilder } from './trace/builder.js';
import type { Client } from '@opensearch-project/opensearch';
import { randomBytes } from 'node:crypto';
import { ReleaseUnavailableError } from './guidance/release.js';
import { QueryLog } from './search/querylog.js';
import { searchRoutes } from './search/routes.js';
import { SearchService } from './search/service.js';
import { TransientError } from './stream/consumer.js';
import { traceRoutes } from './trace/routes.js';
import type { Principal } from './types.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    acl: AclService;
  }
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export interface AppOptions {
  db: Db;
  client: MongoClient;
  cookieSecure?: boolean;
  logger?: boolean;
  rateLimit?: { global: number; login: number };
  acl?: AclService;
  github?: GitHubClient;
  dataDir?: string;
  search?: { client: Client; alias: string };
  queryLog?: { salt: string; rawText: boolean };
}

const GENERIC: Record<number, [string, string]> = {
  400: ['invalid_request', 'Invalid request'],
  401: ['unauthenticated', 'Sign in required'],
  404: ['not_found', 'Not found'],
  413: ['payload_too_large', 'Request body too large'],
  415: ['unsupported_media_type', 'Unsupported content type'],
  429: ['rate_limited', 'Too many requests. Try again shortly.'],
};

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] }
      : false,
    bodyLimit: 100 * 1024,
    trustProxy: false,
  });

  app.decorate('db', opts.db);
  app.decorate('acl', opts.acl ?? new AclService(opts.db, opts.client));
  app.decorateRequest('principal', null);

  await app.register(cookie);
  await app.register(rateLimit, {
    max: opts.rateLimit?.global ?? 300,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ statusCode: 429, message: 'rate_limited' }),
  });

  // Resolve the session on every request; routes decide whether it is required.
  app.addHook('onRequest', async (req) => {
    req.principal = await resolveSession(opts.db, req.cookies[SESSION_COOKIE]);
  });

  // API responses may contain private data: never let browsers or proxies cache them.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof TransientError) {
      req.log.warn({ reqId: req.id }, 'search backend unavailable');
      return reply.code(503).send({ error: { code: 'search_unavailable', message: 'Full-text search is temporarily unavailable. Repository and issue pages still work.' } });
    }
    if (err instanceof ReleaseUnavailableError) {
      return reply.code(503).send({ error: { code: 'release_unavailable', message: 'The current release cannot be verified right now.' } });
    }
    if (err instanceof AclUnavailableError) {
      req.log.warn({ reqId: req.id }, 'access check unavailable - request denied');
      return reply
        .code(503)
        .send({ error: { code: 'authorization_unavailable', message: 'Access cannot be verified right now. Try again later.' } });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      const [code, message] = GENERIC[status] ?? ['invalid_request', 'Invalid request'];
      return reply.code(status).send({ error: { code, message } });
    }
    // Internal details stay in the server log only.
    req.log.error({ err, reqId: req.id }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal error', request_id: req.id } });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } }));

  app.get('/health', async () => ({ status: 'ok' }));
  await app.register(authRoutes, { cookieSecure: opts.cookieSecure ?? false, loginRateLimit: opts.rateLimit?.login ?? 10 });
  await app.register(repoRoutes);
  await app.register(aclRoutes);

  const store = new IngestStore(opts.db, opts.client);
  const importer = new Importer(opts.db, store, {
    dataDir: opts.dataDir ?? 'data',
    github: opts.github ?? new GitHubClient(),
  });
  await app.register(ingestRoutes, { importer, inbox: new Inbox(opts.db, store, app.acl) });
  await app.register(traceRoutes, { builder: new TraceBuilder(opts.db) });

  // Without a salt (tests/dev), pseudonyms use a per-process random key.
  const log = new QueryLog(opts.db, opts.queryLog ?? { salt: randomBytes(32).toString('hex'), rawText: false });
  const service = new SearchService(opts.db, opts.search?.client ?? null, opts.search?.alias ?? 'ri-chunks', app.acl, log);
  await app.register(searchRoutes, { service, log });
  await app.register(docRoutes);
  return app;
}
