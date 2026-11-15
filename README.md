# RepoInsight — Project 19 prototype

Prototype of the *Repository, Issue and Documentation Assistant* described in the Project 19
architecture report. MongoDB is the authoritative store; OpenSearch and other views are derived
from it through a transactional outbox and Kafka.

> Status: **Phase 5 (search, citations, current-vs-historical guidance, evaluation)**. See [PROGRESS.md](PROGRESS.md) for what is implemented,
> what is tested, and what remains production-design only.

## Stack

| Component | Role | Local setup |
|---|---|---|
| MongoDB 8.0 | Source of truth: repos, revisions, permissions, edges, events | Single-node replica set `rs0`, auth + keyfile |
| OpenSearch 2.19 | Full-text retrieval and filters (derived, rebuildable) | Single node, security plugin on, 512 MB heap |
| Kafka 3.9 (KRaft) | Change events between the outbox and projectors | Single broker, no ZooKeeper, SASL/PLAIN |
| Node.js + TypeScript | Backend API (Fastify) and workers | `backend/`, listens on 127.0.0.1:4000 |
| React + TypeScript | Frontend | *Phase 6* |

All services bind to `127.0.0.1` only. Expected memory use is about 3 GB.

## Requirements

- Docker Desktop (WSL 2 backend) with Docker Compose v2
- Node.js 20 or later

## Setup

```bash
npm run env:init
```

Creates `.env` from `.env.example` with random secrets. It never overwrites an existing `.env`.
To import public GitHub repositories, put a read-only `GITHUB_TOKEN` in `.env` yourself.

```bash
npm run infra:up
```

Starts MongoDB, OpenSearch and Kafka and waits until all are healthy. Kafka topics
(`ri.changes`, `ri.permissions`, `ri.changes.dlq`) are created by the one-shot `kafka-init` service.

Then install packages, load the synthetic demo data and start the API:

```bash
npm install
```

```bash
npm run seed
```

```bash
npm run dev:api
```

Demo users `alice` (admin of the private repo), `bob` (reader), `carol` (no private access) and
`ops` (platform admin: manages access, no implicit read) all use `DEMO_USER_PASSWORD` from `.env`.
All demo data is synthetic. `npm run seed` builds a real Git repository under
`data/fixtures/acme-tls-proxy` covering a merge commit, a squash merge, a rebase merge, a verified
backport (cherry-pick trailer) and an edited backport, then ingests it with issues, PRs, reviews,
releases and documentation revisions (the TLS security-regression story from the report).

Create the least-privilege OpenSearch user (once; uses the admin password from `.env` only here)
and start the background worker (outbox relay, search and activity projectors):

```bash
npm run search:setup
```

```bash
npm run worker
```

To import a public GitHub repository (optional; add a read-only `GITHUB_TOKEN` to `.env` for more
than 60 requests per hour):

```bash
npm run import -- sindresorhus/is-docker
```

Running it again performs an incremental update.

## Everyday commands

| Command | Effect |
|---|---|
| `npm test` | Backend tests (needs the infrastructure running; uses the separate `repoinsight_test` database) |
| `npm run typecheck` | TypeScript check |
| `npm run worker` | Outbox relay -> Kafka -> search and activity projectors |
| `npm run search:rebuild` | Rebuild OpenSearch from MongoDB into a new index and swap the alias |
| `npm run activity:recompute [-- --all]` | Repair dashboard counters from canonical data |
| `npm run eval` | Retrieval evaluation (Recall@10, MRR, citation validity, leak probes, stale-advice rate) |
| `npm run bench -- --iterations 200 --index-samples 20` | Latency and indexing-delay benchmark (worker must run) |
| `npm run infra:status` | Container state and health |
| `npm run infra:logs` | Recent logs |
| `npm run infra:down` | Stop containers, **keep** data |
| `npm run infra:reset` | Stop containers and **delete all local data volumes** |

## API (Phase 1)

All routes except `/health` and `/auth/login` require a session cookie.

| Method and path | Purpose |
|---|---|
| `POST /auth/login` `{username, password}` | Start a session (httpOnly, SameSite=Strict cookie) |
| `POST /auth/logout`, `GET /auth/me` | End session, current user |
| `GET /repos` | Repositories the caller can read |
| `GET /repos/:repoId` | Repository detail |
| `GET /repos/:repoId/issues?label=&state=&limit=&cursor=` | Issues, newest first, keyset pagination |
| `GET /repos/:repoId/issues/:number` | Issue detail |
| `GET /repos/:repoId/activity?label=` | Daily issue activity (derived; includes `as_of` watermark and lag) |
| `GET /repos/:repoId/issues/:number/trace` | Issue -> PR -> merged commit -> releases, with evidence per release |
| `GET /repos/:repoId/releases` | Releases with target commit and previous release |
| `GET /repos/:repoId/releases/:tag/issues` | Fixes first shipped in this release (verified and unverified listed separately) |

Release inclusion is proven by commit-graph ancestry from the PR's merged commit (merge, squash
and rebase merges all resolve to that commit), never from head commits, dates or tag names.
Backports count only with a cherry-pick trailer, a backport PR link or an identical patch-id;
anything weaker is reported as unverified.
| `GET /repos/:repoId/permissions` | Members (repository admins) |
| `POST /repos/:repoId/permissions` `{username, role}` | Grant access |
| `DELETE /repos/:repoId/permissions/:username` | Revoke access (effective before the response) |
| `PATCH /repos/:repoId/visibility` `{visibility}` | Public or private |

Search, citations and guidance:

| Method and path | Purpose |
|---|---|
| `GET /search?q=&repo=&label=&release=&type=&status=all\|current&limit=` | Ranked, cited chunks; each marked current / superseded / historical / possibly_outdated / unknown |
| `POST /citations/verify` `{repo_id, chunk_id}` | Re-derives the cited lines from the stored source revision and checks the digest |
| `GET /repos/:repoId/guidance/compare?topic=&from=&to=` | Current vs historical guidance for a config key, with the PRs/notes explaining the change |
| `POST /answer` `{repo_id, query, release?}` | Extractive answer: verified current evidence first, superseded evidence separated, warnings |
| `GET /analytics/queries?days=` | Query-log aggregates (platform admins) |

Search pre-filters by public visibility or MongoDB membership, then re-checks every hit against
MongoDB (access, canonical chunk, digest) and re-checks access before responding. Snippets come
from MongoDB, not the index, and no hit totals are returned.

Platform admins only:

| Method and path | Purpose |
|---|---|
| `POST /imports` `{repo: "owner/name"}` | Start an initial or incremental import (202 + job id) |
| `GET /imports/:jobId` | Job status with per-step progress and errors |
| `POST /admin/deliveries` `{provider, delivery_id, event}` | Event intake (issue opened/closed/edited, comment added, document changed, release published, access granted/revoked) |

A private repository the caller cannot read returns the same 404 as one that does not exist.
If access cannot be verified, private and public data alike are refused with 503.

## Security notes

- Secrets live only in `.env` (git-ignored). The backend connects to MongoDB as a least-privilege
  user limited to `readWrite` on the application database.
- OpenSearch runs with its security plugin enabled using bundled development certificates.
- These settings are for local development only; see PROGRESS.md for known limitations.

## Recovery

| Failure | Effect | Recovery |
|---|---|---|
| Kafka down | Canonical writes continue; outbox grows; search/dashboards lag | Relay retries with backoff and publishes the backlog in order |
| Worker crash mid-batch | Projections lag | Consumers resume from the last committed offset; re-applied events are idempotent |
| OpenSearch down | Search lags; events are retried, never dead-lettered | Redelivered when it is back; or `npm run search:rebuild` |
| Poison event | Sent to `ri.changes.dlq` with diagnostics after bounded retries | Inspect, fix, replay |
| Missed/late events | Dashboard buckets marked dirty | `npm run activity:recompute`; import re-run reconciles canonical data |

## Troubleshooting

**Docker Desktop: "rename … .sock … .stale: The file cannot be accessed by the system".**
On some Windows builds Docker Desktop leaves socket files behind that it cannot reuse on the
next start. Start Docker with the helper instead, which moves the two socket folders aside
(nothing is deleted) before launching it:

```bash
powershell -ExecutionPolicy Bypass -File scripts/docker-start.ps1
```

If image pulls hang at "Pulling from …", Docker Desktop's internal proxy is stuck: restart it with
the same helper.
