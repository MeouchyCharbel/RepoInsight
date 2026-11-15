import type { ClientSession, Db } from 'mongodb';
import type { AuditDoc } from './types.js';

export async function audit(db: Db, entry: Omit<AuditDoc, 'at'>, session?: ClientSession) {
  await db.collection<AuditDoc>('audit_log').insertOne({ at: new Date(), ...entry }, { session });
}
