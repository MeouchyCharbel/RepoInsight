import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/routes.js';
import { HttpError, parse } from '../errors.js';
import { GitHubError } from './github.js';
import { type Importer, type ImportJob } from './importer.js';
import { envelopeSchema, type Inbox } from './inbox.js';

const importBody = z.strictObject({ repo: z.string().min(3).max(201) });
const jobParams = z.object({ jobId: z.uuid() });

function requirePlatformAdmin(req: { principal: { isPlatformAdmin: boolean } | null }) {
  if (!req.principal?.isPlatformAdmin) throw new HttpError(403, 'forbidden', 'Platform admin role required');
}

/** Import and event-intake endpoints: platform admins only, audited by the job/inbox records. */
export async function ingestRoutes(app: FastifyInstance, opts: { importer: Importer; inbox: Inbox }) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', async (req) => requirePlatformAdmin(req));

  app.post('/imports', async (req, reply) => {
    const { repo } = parse(importBody, req.body);
    let job: ImportJob;
    try {
      job = await opts.importer.createJob(repo);
    } catch (e) {
      if (e instanceof GitHubError) throw new HttpError(400, 'invalid_request', e.message);
      throw e;
    }
    // Runs in the background; progress is persisted on the job document.
    opts.importer.run(job).catch((err) => req.log.error({ err, job: job.job_id }, 'import failed'));
    return reply.code(202).send({ job_id: job.job_id, kind: job.kind });
  });

  app.get('/imports/:jobId', async (req) => {
    const { jobId } = parse(jobParams, req.params);
    const job = await app.db.collection<ImportJob>('import_jobs').findOne({ job_id: jobId }, { projection: { _id: 0 } });
    if (!job) throw new HttpError(404, 'not_found', 'Import job not found');
    return job;
  });

  app.post('/admin/deliveries', async (req) => {
    const env = parse(envelopeSchema, req.body);
    return opts.inbox.receive(env);
  });
}
