import type { Db } from 'mongodb';
import { hashPassword } from '../auth/passwords.js';
import type { IssueDoc, PermissionDoc, RepositoryDoc, Role, UserDoc } from '../types.js';

/**
 * Small, fully synthetic demo dataset (no real private data). Idempotent: re-running upserts
 * the same records. Phase 2 adds the larger generated dataset and real public imports.
 *
 * Users:  alice (admin of acme-billing), bob (read on acme-billing), carol (no private access),
 *         ops (platform admin: manages access, no implicit read).
 */
export const DEMO = {
  users: ['alice', 'bob', 'carol', 'ops'] as const,
  publicRepo: 'acme-tls-proxy',
  privateRepo: 'acme-billing',
};

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12));

export async function seedDemo(db: Db, password: string): Promise<void> {
  const hash = await hashPassword(password);
  const users = db.collection<UserDoc>('users');
  for (const name of DEMO.users) {
    await users.updateOne(
      { user_id: `u_${name}` },
      {
        $set: { username: name, password_hash: hash, is_platform_admin: name === 'ops', disabled: false },
        $setOnInsert: { user_id: `u_${name}`, created_at: new Date() },
      },
      { upsert: true },
    );
  }

  const repos: Omit<RepositoryDoc, 'acl_epoch' | 'created_at' | 'updated_at'>[] = [
    { repo_id: DEMO.publicRepo, org_id: 'o_acme', full_name: 'acme/tls-proxy', description: 'Public TLS-terminating proxy (synthetic).', visibility: 'public', default_branch: 'main' },
    { repo_id: DEMO.privateRepo, org_id: 'o_acme', full_name: 'acme/billing', description: 'Private billing service (synthetic).', visibility: 'private', default_branch: 'main' },
  ];
  for (const r of repos) {
    await db.collection<RepositoryDoc>('repositories').updateOne(
      { repo_id: r.repo_id },
      { $set: { ...r, updated_at: new Date() }, $setOnInsert: { acl_epoch: 1, created_at: new Date() } },
      { upsert: true },
    );
  }

  const grants: [string, Role][] = [
    ['u_alice', 'admin'],
    ['u_bob', 'read'],
  ];
  for (const [principal, role] of grants) {
    await db.collection<PermissionDoc>('permissions').updateOne(
      { repo_id: DEMO.privateRepo, principal_id: principal },
      { $set: { role, source: 'direct', acl_epoch: 1, updated_at: new Date() } },
      { upsert: true },
    );
  }

  const issues: Omit<IssueDoc, 'revision' | 'created_at'>[] = [
    { repo_id: DEMO.publicRepo, number: 12, title: 'Allow TLS 1.0 for legacy clients', body: 'Set `tls.min_version: "1.0"` so old clients can connect.', state: 'closed', labels: ['security', 'question'], author_id: 'u_carol', updated_at: day(1) },
    { repo_id: DEMO.publicRepo, number: 81, title: 'TLS setting regression', body: 'v2.4.0 accepts TLS 1.0 by default. The default should be 1.2.', state: 'closed', labels: ['security', 'bug'], author_id: 'u_alice', updated_at: day(10) },
    { repo_id: DEMO.publicRepo, number: 90, title: 'Document cipher suite configuration', body: 'The docs do not list supported cipher suites.', state: 'open', labels: ['docs'], author_id: 'u_bob', updated_at: day(12) },
    { repo_id: DEMO.privateRepo, number: 3, title: 'PRIVATE: rotate payment gateway credentials', body: 'Synthetic private issue used to test that private data never leaks.', state: 'open', labels: ['security'], author_id: 'u_alice', updated_at: day(11) },
    { repo_id: DEMO.privateRepo, number: 4, title: 'PRIVATE: invoice rounding bug', body: 'Synthetic private issue.', state: 'closed', labels: ['bug'], author_id: 'u_bob', updated_at: day(9) },
  ];
  for (const i of issues) {
    await db.collection<IssueDoc>('issues').updateOne(
      { repo_id: i.repo_id, number: i.number },
      { $set: i, $setOnInsert: { revision: 1, created_at: i.updated_at } },
      { upsert: true },
    );
  }
}
