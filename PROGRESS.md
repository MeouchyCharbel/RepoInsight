# PROGRESS

Working log for the Project 19 prototype. Branch: `dev/prototype` (no `main` until approved). Nothing pushed.

## Decisions (approved 2026-11-15)
- D1 Revision text stored in MongoDB `blobs` (content-addressed) instead of object storage.
- D2 Extractive answers (ranked, verified citations); no LLM.
- D3 Local accounts + seeded demo users (no GitHub OAuth).
- D4 Optional read-only `GITHUB_TOKEN` in `.env` for public imports; private repos are synthetic only.
- D5 Commits use the existing Git identity; no AI attribution trailers.
- D6 Work on `dev/prototype`; `main` created only on approval.
- D7 Code search stays design-only unless added as an optional phase.
- Kafka pinned to 3.9.x (KRaft) for KafkaJS compatibility; 6 partitions instead of the design's 512.
- Release inclusion: blobless `git clone` for commit DAG + patch-id; ancestry computed from MongoDB.

## Phases
| Phase | Status |
|---|---|
| 0 Repo + infrastructure | done (2026-11-15) |
| 1 Core backend, auth, ACL | done (2026-11-15) |
| 2 Ingestion | pending |
| 3 Streaming / projections | pending |
| 4 Release tracing | pending |
| 5 Search, citations, guidance, eval | pending |
| 6 Frontend | pending |
| 7 Docs, benchmarks, demo | pending |

## Phase 0 verification (manual checks, 2026-11-15)
Docker Desktop 29.7.2 (WSL 2, 8 GB / 12 CPUs available to Docker).
- All services healthy via `docker compose up -d --wait`; data persists across `down`/`up`.
- MongoDB: replica set `rs0` primary; multi-document transaction commits; unauthenticated access denied;
  app user cannot read `admin.system.users`, write other databases, or create users.
- OpenSearch: 401 without or with wrong credentials; plain HTTP refused; cluster status yellow (expected, single node).
- Kafka: topics `ri.changes` (6), `ri.permissions` (3), `ri.changes.dlq` (1); SASL login with app
  credentials works, wrong password rejected.
- Ports bound to 127.0.0.1 only. Idle memory: Mongo ~220 MB, Kafka ~340 MB, OpenSearch ~900 MB.
- Automated infrastructure tests arrive with the backend in Phase 1.

## Phase 1 summary (2026-11-15)
- Fastify + TypeScript API (`backend/`), zod validation (strict query params, field names only in errors).
- Sessions instead of JWT: `@fastify/jwt` was dropped because its `fast-jwt` dependency had critical
  advisories. Random 256-bit token in an httpOnly SameSite=Strict cookie; only its SHA-256 is stored;
  8 h TTL index; logout deletes it. Passwords hashed with Node's scrypt.
- ACL per report 5.4/9.1: majority reads, membership cache valid only while `acl_epoch` matches,
  linearizable re-check before every protected response, fail closed (503) if unverifiable.
  Grant/revoke/visibility = one majority transaction: permission + `acl_epoch` + outbox + audit.
- Uniform 404 for unreadable private repos; listings contain only readable repos; no totals returned.
- Rate limits (300/min global, 10/min login), `Cache-Control: no-store`, generic 500s, log redaction.
- All report collections and indexes created (`src/db.ts`); unique keys start with `repo_id`.
- `npm audit`: 0 vulnerabilities (zod 4.6.7, vitest 5.1.0).
- Tests: 29 passing (auth 10, ACL 14, schema 4 + fail-closed 1) - `npm test`, 2026-11-15.

## Known limitations so far
- No teams/orgs expansion: permissions are direct grants only (`source` field reserved).
- Session cookie lacks the Secure flag until served over HTTPS (`COOKIE_SECURE=true`).
- In-process rate limiter and ACL cache (single API instance); production would share them.
- `withRead` re-checks access after the data read; it is a per-request guarantee, not a lock.
- Single-node MongoDB replica set, single OpenSearch node, single Kafka broker: no sharding/replication (production design only).
- OpenSearch uses its bundled demo TLS certificates (development only).
- Kafka client listener uses SASL/PLAIN without TLS; acceptable only because it binds to 127.0.0.1.

## Environment notes
- Windows 11 Insider build 26300: Docker Desktop crashed on leftover AF_UNIX socket files that Windows
  could not rename. Fixed by renaming `%LOCALAPPDATA%\Docker\run` and `%LOCALAPPDATA%\docker-secrets-engine`
  aside (`*.old-<timestamp>`); Docker recreated them. Recurs on every Docker restart, so
  `scripts/docker-start.ps1` automates it. A hung internal pull proxy (http.docker.internal:3128)
  was also cleared by that restart.
