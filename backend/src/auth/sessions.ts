import { createHash, randomBytes } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Principal, SessionDoc, UserDoc } from '../types.js';

export const SESSION_COOKIE = 'ri_session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Opaque random token; only its hash is stored, so a database leak does not yield sessions. */
export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await db.collection<SessionDoc>('sessions').insertOne({
    token_hash: sha256(token),
    user_id: userId,
    created_at: now,
    expires_at: new Date(now.getTime() + SESSION_TTL_MS),
  });
  return token;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.collection<SessionDoc>('sessions').deleteOne({ token_hash: sha256(token) });
}

/** Resolves a cookie token to an active, enabled user, or null. */
export async function resolveSession(db: Db, token: string | undefined): Promise<Principal | null> {
  if (!token || token.length > 128) return null;
  const session = await db
    .collection<SessionDoc>('sessions')
    .findOne({ token_hash: sha256(token), expires_at: { $gt: new Date() } });
  if (!session) return null;
  const user = await db.collection<UserDoc>('users').findOne({ user_id: session.user_id });
  if (!user || user.disabled) return null;
  return { userId: user.user_id, username: user.username, isPlatformAdmin: user.is_platform_admin };
}
