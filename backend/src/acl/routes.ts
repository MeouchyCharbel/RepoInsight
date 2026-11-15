import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/routes.js';
import { parse } from '../errors.js';
import type { PermissionDoc, UserDoc } from '../types.js';
import { repoIdSchema } from '../validation.js';

const repoParams = z.object({ repoId: repoIdSchema });
const userParams = z.object({ repoId: repoIdSchema, username: z.string().min(1).max(64) });
const grantBody = z.object({
  username: z.string().min(1).max(64),
  role: z.enum(['read', 'write', 'admin']),
});
const visibilityBody = z.object({ visibility: z.enum(['public', 'private']) });

export async function aclRoutes(app: FastifyInstance) {
  const { db, acl } = app;
  app.addHook('preHandler', requireAuth);

  app.get('/repos/:repoId/permissions', async (req) => {
    const { repoId } = parse(repoParams, req.params);
    await acl.requireManage(req.principal!, repoId);
    const perms = await db.collection<PermissionDoc>('permissions').find({ repo_id: repoId }).toArray();
    const users = await db
      .collection<UserDoc>('users')
      .find({ user_id: { $in: perms.map((p) => p.principal_id) } }, { projection: { user_id: 1, username: 1 } })
      .toArray();
    const names = new Map(users.map((u) => [u.user_id, u.username]));
    return {
      items: perms.map((p) => ({ username: names.get(p.principal_id) ?? null, role: p.role, source: p.source })),
    };
  });

  app.post('/repos/:repoId/permissions', async (req) => {
    const { repoId } = parse(repoParams, req.params);
    const { username, role } = parse(grantBody, req.body);
    await acl.requireManage(req.principal!, repoId);
    return acl.setPermission(req.principal!, repoId, username, role, req.ip);
  });

  app.delete('/repos/:repoId/permissions/:username', async (req) => {
    const { repoId, username } = parse(userParams, req.params);
    await acl.requireManage(req.principal!, repoId);
    return acl.setPermission(req.principal!, repoId, username, null, req.ip);
  });

  app.patch('/repos/:repoId/visibility', async (req) => {
    const { repoId } = parse(repoParams, req.params);
    const { visibility } = parse(visibilityBody, req.body);
    await acl.requireManage(req.principal!, repoId);
    return acl.setVisibility(req.principal!, repoId, visibility, req.ip);
  });
}
