// Authoritative MongoDB document shapes (report Section 4). Later phases extend these.

export type Visibility = 'public' | 'private';
export type Role = 'read' | 'write' | 'admin';

export interface UserDoc {
  user_id: string;
  username: string;
  password_hash: string;
  is_platform_admin: boolean; // may manage permissions on any repository (audited); no implicit read access
  disabled: boolean;
  created_at: Date;
}

export interface SessionDoc {
  token_hash: string; // sha256 of the cookie token; the raw token is never stored
  user_id: string;
  created_at: Date;
  expires_at: Date; // TTL index removes expired sessions
}

export interface RepositoryDoc {
  repo_id: string;
  provider_id?: number;
  org_id: string;
  full_name: string;
  description?: string;
  visibility: Visibility;
  default_branch: string;
  acl_epoch: number; // incremented on every permission or visibility change
  created_at: Date;
  updated_at: Date;
}

export interface PermissionDoc {
  repo_id: string;
  principal_id: string;
  role: Role;
  source: 'direct' | 'team' | 'org';
  acl_epoch: number; // repository epoch at which this grant was written
  updated_at: Date;
}

export interface IssueDoc {
  repo_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author_id: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
  fixed_in_release?: string;
  fixed_in_status?: 'verified' | 'unverified';
}

export interface OutboxDoc {
  event_id: string;
  topic: string;
  key: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
  attempts: number;
}

export interface AuditDoc {
  at: Date;
  actor_id: string | null;
  action: string;
  repo_id?: string;
  target?: string;
  outcome: 'success' | 'denied' | 'failure';
  details?: Record<string, unknown>;
  ip?: string;
}

export interface Principal {
  userId: string;
  username: string;
  isPlatformAdmin: boolean;
}
