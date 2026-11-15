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
  provider?: 'github' | 'synthetic';
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
  role: Role | null; // null = revoked (tombstone, so an older grant arriving late is ignored)
  source: 'direct' | 'team' | 'org' | 'provider';
  acl_epoch: number; // repository epoch at which this change was written
  seq: number; // source sequence of the change; older changes are ignored
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
  source_updated_at?: Date; // provider updated_at, used for ordering
  content_digest?: string;
  closed_at?: Date | null;
  fixed_in_release?: string;
  fixed_in_status?: 'verified' | 'unverified';
}

export interface PullRequestDoc {
  repo_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author_id: string;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  merged_at: Date | null;
  // Only set when merged. GitHub's merge_commit_sha also exists on unmerged PRs (test merge), so it
  // is never trusted unless merged_at is set.
  merged_sha: string | null;
  closes_issues: number[];
  head_commits: string[]; // PR_CONTAINS_COMMIT: review context only, never proof of release inclusion
  created_at: Date;
  updated_at: Date;
  source_updated_at: Date;
  revision: number;
  content_digest: string;
}

export interface CommentDoc {
  repo_id: string;
  thread_key: string; // issue:81 or pr:95
  comment_id: string;
  kind: 'issue_comment' | 'review_comment' | 'review';
  author_id: string;
  body: string;
  file_path?: string | null;
  diff_line?: number | null;
  review_state?: string | null;
  created_at: Date;
  updated_at: Date;
  source_updated_at: Date;
  revision: number;
  content_digest: string;
}

export interface ReleaseDoc {
  repo_id: string;
  release_id: string; // tag
  name: string;
  body: string;
  target_sha: string | null; // resolved from the Git tag, never from the API's target_commitish
  published_at: Date;
  channel: 'stable' | 'pre';
  effective?: boolean;
  security_epoch?: number;
  prev_release_id?: string | null;
  source_updated_at: Date;
  revision: number;
  content_digest: string;
  updated_at: Date;
}

export interface CommitDoc {
  repo_id: string;
  sha: string;
  parent_shas: string[];
  generation: number; // 1 + max(parent generations)
  author_id: string;
  committed_at: Date;
  message: string;
  changed_paths: string[]; // capped
  changed_paths_truncated: boolean;
  cherry_picked_from: string | null; // from a "(cherry picked from commit <sha>)" trailer
  patch_id?: string | null; // `git patch-id --stable`, computed on demand for backport matching
}

export type Relation =
  | 'ISSUE_FIXED_BY_PR'
  | 'ISSUE_MENTIONS_PR'
  | 'PR_MERGED_AS_COMMIT'
  | 'PR_CONTAINS_COMMIT'
  | 'RELEASE_CONTAINS_COMMIT'
  | 'COMMIT_BACKPORT_OF'
  | 'GUIDANCE_SUPERSEDES';

/** Typed, versioned adjacency record (report 5.1). */
export interface EdgeDoc {
  repo_id: string;
  from: string; // e.g. issue:81, pr:95, commit:<sha>, release:v2.4.1
  relation: Relation;
  to: string;
  provenance: string;
  confidence: 'verified' | 'unverified' | 'weak';
  status: 'active' | 'pending' | 'invalidated'; // pending = target not ingested yet
  created_at: Date;
  updated_at: Date;
}

export interface DocumentRevisionDoc {
  repo_id: string;
  source_id: string;
  revision: number;
  kind: 'doc' | 'release_notes';
  commit_sha: string | null;
  committed_at: Date;
  source_digest: string; // blobs.digest
  created_at: Date;
}

export interface ChunkDoc {
  repo_id: string;
  chunk_id: string;
  source_type: 'doc' | 'release_notes' | 'issue' | 'pr' | 'comment';
  source_id: string;
  revision: number;
  section_anchor: string;
  heading_path: string[];
  ordinal: number;
  line_start: number;
  line_end: number;
  text: string;
  text_digest: string;
  config_keys: string[];
  labels: string[];
  thread_title: string | null;
  is_latest: boolean;
  guidance_status: 'current' | 'historical' | 'unknown';
  superseded_by_revision: number | null;
  release_ids: string[]; // filled by release tracing (Phase 4)
  commit_sha: string | null;
  created_at: Date;
  // Guidance classification (report 9.2); detection only ever downgrades.
  superseded_by?: Supersession | null;
  possibly_outdated?: boolean;
  in_effective_release?: boolean; // part of the effective release's docs or its release notes
}

export interface Supersession {
  kind: 'revision' | 'release';
  ref: string; // e.g. "docs/tls.md@rev3" or "v2.4.1"
  reason: 'newer_revision' | 'security_epoch' | 'config_key_match';
  confidence: 'verified' | 'candidate';
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
