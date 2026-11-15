import type { Db, MongoClient } from 'mongodb';
import { audit } from '../audit.js';
import { AclUnavailableError, HttpError, repoNotFound } from '../errors.js';
import type {
  OutboxDoc,
  PermissionDoc,
  Principal,
  RepositoryDoc,
  Role,
  UserDoc,
  Visibility,
} from '../types.js';

export interface RepoAccess {
  repoId: string;
  visibility: Visibility;
  role: Role | null; // null = public read without a membership
  aclEpoch: number;
}

interface CacheEntry {
  role: Role | null;
  aclEpoch: number;
  at: number;
}

export interface AclOptions {
  timeoutMs: number;
  cacheTtlMs: number;
}

/**
 * Authoritative access control (report Sections 5.4 and 9.1).
 * - MongoDB permissions + repositories.acl_epoch are the only source of truth.
 * - A cached membership is used only while its acl_epoch equals the repository's current epoch,
 *   so any grant, revoke or visibility change invalidates it immediately.
 * - `final: true` performs a linearizable re-check before protected data leaves the server.
 * - Any failure to verify throws AclUnavailableError: callers deny (fail closed).
 */
export class AclService {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private db: Db,
    private client: MongoClient,
    private opts: AclOptions = { timeoutMs: 500, cacheTtlMs: 30_000 },
  ) {}

  private repos(level: 'majority' | 'linearizable') {
    return this.db.collection<RepositoryDoc>('repositories', { readConcern: { level } });
  }

  private perms(level: 'majority' | 'linearizable') {
    return this.db.collection<PermissionDoc>('permissions', { readConcern: { level } });
  }

  /** Returns the caller's access, or null when the repository is missing or not readable. */
  async resolve(p: Principal, repoId: string, { final = false } = {}): Promise<RepoAccess | null> {
    const level = final ? 'linearizable' : 'majority';
    try {
      const repo = await this.repos(level).findOne(
        { repo_id: repoId },
        { projection: { _id: 0, repo_id: 1, visibility: 1, acl_epoch: 1 }, maxTimeMS: this.opts.timeoutMs },
      );
      if (!repo) return null;

      const key = `${p.userId}\u0000${repoId}`;
      const cached = this.cache.get(key);
      let role: Role | null;
      if (!final && cached && cached.aclEpoch === repo.acl_epoch && Date.now() - cached.at < this.opts.cacheTtlMs) {
        role = cached.role;
      } else {
        const perm = await this.perms(level).findOne(
          { repo_id: repoId, principal_id: p.userId },
          { projection: { _id: 0, role: 1 }, maxTimeMS: this.opts.timeoutMs },
        );
        role = perm?.role ?? null;
        this.cache.set(key, { role, aclEpoch: repo.acl_epoch, at: Date.now() });
      }

      if (repo.visibility !== 'public' && !role) return null;
      return { repoId, visibility: repo.visibility, role, aclEpoch: repo.acl_epoch };
    } catch {
      throw new AclUnavailableError();
    }
  }

  /** Throws the uniform 404 unless the caller can read the repository. */
  async requireRead(p: Principal, repoId: string, opts: { final?: boolean } = {}): Promise<RepoAccess> {
    const access = await this.resolve(p, repoId, opts);
    if (!access) throw repoNotFound();
    return access;
  }

  /**
   * Runs `fn` only after an access check and re-checks (linearizable) before returning,
   * so a revocation committed while `fn` ran is still honoured.
   */
  async withRead<T>(p: Principal, repoId: string, fn: (a: RepoAccess) => Promise<T>): Promise<T> {
    const access = await this.requireRead(p, repoId);
    const result = await fn(access);
    await this.requireRead(p, repoId, { final: true });
    return result;
  }

  /** Repository admins and platform admins may manage access. Others get 403 (or 404 if unreadable). */
  async requireManage(p: Principal, repoId: string): Promise<void> {
    if (p.isPlatformAdmin) {
      const exists = await this.db.collection('repositories').countDocuments({ repo_id: repoId }, { limit: 1 });
      if (!exists) throw repoNotFound();
      return;
    }
    const access = await this.requireRead(p, repoId, { final: true });
    if (access.role !== 'admin') throw new HttpError(403, 'forbidden', 'Repository admin role required');
  }

  /** Repository ids the caller may read through membership (authoritative, not a projection). */
  async memberRepoIds(p: Principal): Promise<string[]> {
    try {
      const rows = await this.perms('majority')
        .find({ principal_id: p.userId, role: { $ne: null } }, { projection: { _id: 0, repo_id: 1 }, maxTimeMS: this.opts.timeoutMs })
        .toArray();
      return rows.map((r) => r.repo_id);
    } catch {
      throw new AclUnavailableError();
    }
  }

  /**
   * Grants (role) or revokes (null) access. One majority-committed transaction updates the
   * permission, increments acl_epoch, writes an outbox event and an audit record. The request is
   * acknowledged only after commit, so revocation is effective before the caller sees success.
   */
  async setPermission(actor: Principal, repoId: string, username: string, role: Role | null, ip?: string) {
    const user = await this.db.collection<UserDoc>('users').findOne({ username });
    if (!user) throw new HttpError(400, 'unknown_user', 'Unknown user');
    const res = await this.writePermission(actor.userId, repoId, user.user_id, role, Date.now(), 'direct', ip);
    return { repo_id: repoId, principal_id: user.user_id, role, acl_epoch: res.acl_epoch, changed: res.changed };
  }

  /**
   * Permission change from the provider event stream. `seq` is the provider's sequence for this
   * (repo, principal); a change older than the stored one (e.g. a grant arriving after a newer
   * revoke) is ignored, as in report 6.3.
   */
  async applyProviderPermission(repoId: string, principalId: string, role: Role | null, seq: number) {
    return this.writePermission('system:provider', repoId, principalId, role, seq, 'provider');
  }

  private async writePermission(
    actorId: string,
    repoId: string,
    principalId: string,
    role: Role | null,
    seq: number,
    source: PermissionDoc['source'],
    ip?: string,
  ): Promise<{ acl_epoch: number; changed: boolean; ignored: boolean }> {
    const type = role ? 'access.granted' : 'access.revoked';
    let epoch = 0;
    let changed = true;
    let ignored = false;

    const session = this.client.startSession();
    try {
      await session.withTransaction(
        async () => {
          changed = true;
          ignored = false;
          const perms = this.db.collection<PermissionDoc>('permissions');
          const cur = await perms.findOne({ repo_id: repoId, principal_id: principalId }, { session });
          if (cur && cur.seq >= seq) {
            ignored = true;
            const repo = await this.db.collection<RepositoryDoc>('repositories').findOne({ repo_id: repoId }, { session });
            epoch = repo?.acl_epoch ?? 0;
            await audit(this.db, { actor_id: actorId, action: type, repo_id: repoId, target: principalId, outcome: 'denied', details: { reason: 'stale_sequence', seq, stored_seq: cur.seq } }, session);
            return;
          }
          const repo = await this.db
            .collection<RepositoryDoc>('repositories')
            .findOneAndUpdate(
              { repo_id: repoId },
              { $inc: { acl_epoch: 1 }, $set: { updated_at: new Date() } },
              { session, returnDocument: 'after' },
            );
          if (!repo) throw repoNotFound();
          epoch = repo.acl_epoch;
          changed = (cur?.role ?? null) !== role;
          // Revocation is a tombstone (role: null) so later, older grants can be recognised as stale.
          await perms.updateOne(
            { repo_id: repoId, principal_id: principalId },
            { $set: { role, source, seq, acl_epoch: epoch, updated_at: new Date() } },
            { upsert: true, session },
          );
          await this.db.collection<OutboxDoc>('outbox').insertOne(
            {
              event_id: `${repoId}:acl:${epoch}`,
              topic: 'ri.permissions',
              key: repoId,
              type,
              payload: { repo_id: repoId, principal_id: principalId, role, acl_epoch: epoch },
              created_at: new Date(),
              published_at: null,
              attempts: 0,
            },
            { session },
          );
          await audit(
            this.db,
            { actor_id: actorId, action: type, repo_id: repoId, target: principalId, outcome: 'success', details: { role, acl_epoch: epoch, changed, source }, ip },
            session,
          );
        },
        { writeConcern: { w: 'majority' }, readConcern: { level: 'snapshot' } },
      );
    } finally {
      await session.endSession();
    }
    this.invalidateRepo(repoId);
    return { acl_epoch: epoch, changed, ignored };
  }

  /** Public <-> private. Same transactional pattern; increments acl_epoch. */
  async setVisibility(actor: Principal, repoId: string, visibility: Visibility, ip?: string) {
    let epoch = 0;
    const session = this.client.startSession();
    try {
      await session.withTransaction(
        async () => {
          const repo = await this.db
            .collection<RepositoryDoc>('repositories')
            .findOneAndUpdate(
              { repo_id: repoId },
              { $set: { visibility, updated_at: new Date() }, $inc: { acl_epoch: 1 } },
              { session, returnDocument: 'after' },
            );
          if (!repo) throw repoNotFound();
          epoch = repo.acl_epoch;
          await this.db.collection<OutboxDoc>('outbox').insertOne(
            {
              event_id: `${repoId}:acl:${epoch}`,
              topic: 'ri.permissions',
              key: repoId,
              type: 'repo.visibility_changed',
              payload: { repo_id: repoId, visibility, acl_epoch: epoch },
              created_at: new Date(),
              published_at: null,
              attempts: 0,
            },
            { session },
          );
          await audit(
            this.db,
            { actor_id: actor.userId, action: 'repo.visibility_changed', repo_id: repoId, outcome: 'success', details: { visibility, acl_epoch: epoch }, ip },
            session,
          );
        },
        { writeConcern: { w: 'majority' }, readConcern: { level: 'snapshot' } },
      );
    } finally {
      await session.endSession();
    }
    this.invalidateRepo(repoId);
    return { repo_id: repoId, visibility, acl_epoch: epoch };
  }

  // Epoch validation already rejects stale entries; dropping them just frees memory early.
  private invalidateRepo(repoId: string) {
    for (const key of this.cache.keys()) if (key.endsWith(`\u0000${repoId}`)) this.cache.delete(key);
  }
}
