# API reference

Base URL in development: `http://127.0.0.1:4000` (the web app reaches it as `/api/...`).
All bodies are JSON. Every route except `GET /health` and `POST /auth/login` requires the
`ri_session` cookie returned by `POST /auth/login` (httpOnly, SameSite=Strict).

## Conventions

| Topic | Behaviour |
|---|---|
| Errors | `{"error": {"code", "message"}}`; never stack traces or submitted values. 500s add `request_id`. |
| 400 | Invalid input. Unknown query parameters are rejected. Messages name fields only. |
| 401 | No or expired session. |
| 403 | Authenticated but not allowed (e.g. not a repository admin). |
| 404 | Not found **or** not readable: a private repository you cannot read is indistinguishable from one that does not exist. |
| 429 | Rate limited (300/min per IP; login 10/min). |
| 503 | `authorization_unavailable` (access could not be verified: fail closed), `search_unavailable`, `release_unavailable`. |
| Caching | All responses: `Cache-Control: no-store`. |
| Pagination | Keyset cursors (`next_cursor`); no totals are returned. |

## Authentication

| Method and path | Body | Result |
|---|---|---|
| `POST /auth/login` | `{username, password}` | `{user}` and session cookie (8 h) |
| `POST /auth/logout` | – | Deletes the server-side session |
| `GET /auth/me` | – | `{user}` |

## Repositories, issues and documents

| Method and path | Result |
|---|---|
| `GET /repos` | Readable repositories (public + current memberships) |
| `GET /repos/:repoId` | Repository with `your_role` |
| `GET /repos/:repoId/issues?label=&state=&limit=&cursor=` | Issues, newest update first, with `fixed_in_release` / `fixed_in_status` |
| `GET /repos/:repoId/issues/:number` | Issue detail |
| `GET /repos/:repoId/issues/:number/comments` | Comments |
| `GET /repos/:repoId/issues/:number/revisions` | Revision history; `late: true` marks older updates that arrived after newer ones |
| `GET /repos/:repoId/documents` | Documentation and release-note sources with latest revision |
| `GET /repos/:repoId/document?source_id=&revision=` | Revision text, section map (lines, marker, releases), revision list with releases |
| `GET /repos/:repoId/activity?label=` | Daily issue activity: `items`, `as_of` watermark, `last_event_lag_seconds`, `unpublished_events` |

## Tracing (issue → PR → commit → release)

| Method and path | Result |
|---|---|
| `GET /repos/:repoId/issues/:number/trace` | Fix PRs with link provenance, merged commit, inferred merge strategy, head commits (context only), and per release `status` = `verified` / `unverified` / `not_included` / `unknown` with `via` and `evidence`; `fixed_in`; `notes` |
| `GET /repos/:repoId/releases` | Releases with `target_sha` and `prev_release_id` |
| `GET /repos/:repoId/releases/:tag/issues` | Fixes first shipped in the release range, `verified` and `unverified` lists |

Example (abridged):

```json
{
  "fixed_in": { "release_id": "v2.4.1", "status": "verified", "via": "merged_commit" },
  "fixes": [{
    "pr": { "number": 95 }, "provenance": "closing_keyword_in_merged_pr", "confidence": "verified",
    "merge": { "merged_sha": "55f86a6…", "strategy": "squash", "head_commits": ["b7b0426…", "1b3710d…"] },
    "releases": [
      { "release_id": "v2.4.0", "status": "not_included" },
      { "release_id": "v2.4.1", "status": "verified", "via": "merged_commit", "evidence": { "method": "commit_dag_ancestry" } },
      { "release_id": "v2.3.5", "status": "verified", "via": "backport", "evidence": { "provenance": "cherry_pick_trailer" } },
      { "release_id": "v2.2.9", "status": "unverified", "via": "candidate_backport" }
    ]
  }]
}
```

## Search, citations, guidance and answers

| Method and path | Result |
|---|---|
| `GET /search?q=&repo=&label=&release=&type=&status=all\|current&limit=` | `{query_id, items}`; each item is a citation (`cite`, `source_id`, `revision`, `section_anchor`, `line_start`, `line_end`, `text_digest`) with `marker` = `current` / `superseded` / `historical` / `possibly_outdated` / `unknown`, `superseded_by`, `release_ids`, `snippet` |
| `POST /citations/verify` `{repo_id, chunk_id}` | `{valid, reason, citation, text}`: re-derived from the stored source revision |
| `GET /repos/:repoId/guidance/compare?topic=&from=&to=` | `effective_release`, `current`, `historical`, `why_changed` (all verified citations) |
| `POST /answer` `{repo_id, query, release?}` | Extractive answer: `effective_release`, `answer` text, `current`, `supporting`, `historical`, `warnings` |
| `GET /analytics/queries?days=` | Query-log aggregates (platform admins) |

`type` accepts a comma list of `doc,release_notes,issue,pr,comment`. Query text is matched as plain
text (no query-string syntax). Search never returns hit totals.

## Access management

| Method and path | Who | Result |
|---|---|---|
| `GET /repos/:repoId/permissions` | repository admin, platform admin | Members |
| `POST /repos/:repoId/permissions` `{username, role}` | same | Grant (`read` / `write` / `admin`) |
| `DELETE /repos/:repoId/permissions/:username` | same | Revoke; committed (majority) before the response |
| `PATCH /repos/:repoId/visibility` `{visibility}` | same | Public / private |

## Ingestion (platform admins)

| Method and path | Result |
|---|---|
| `POST /imports` `{repo: "owner/name"}` | 202 `{job_id, kind}`; initial or incremental import of a public GitHub repository |
| `GET /imports/:jobId` | Job status with per-step progress and errors |
| `POST /admin/deliveries` `{provider, delivery_id, event}` | Event intake; `event.type` is one of `issue.opened`, `issue.closed`, `issue.edited`, `comment.added`, `document.changed`, `release.published`, `access.granted`, `access.revoked`. Returns `applied` / `duplicate` / `stale` / `ignored` |

## Kafka topics (internal)

| Topic | Key | Producer → consumers |
|---|---|---|
| `ri.changes` (6 partitions) | `repo_id:entity_type:entity_id` | Outbox relay → search, activity and graph projectors |
| `ri.permissions` (3) | `repo_id` | Outbox relay → search projector (visibility/epoch refresh) |
| `ri.changes.dlq` (1) | original key | Consumers (poison or persistently failing events, with diagnostic headers) |
