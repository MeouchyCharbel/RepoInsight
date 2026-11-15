# RepoInsight — Project 19 prototype

Prototype of the *Repository, Issue and Documentation Assistant* described in the Project 19
architecture report. MongoDB is the authoritative store; OpenSearch and other views are derived
from it through a transactional outbox and Kafka.

> Status: **Phase 1 (core backend, sign-in, access control)**. See [PROGRESS.md](PROGRESS.md) for what is implemented,
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
All demo data is synthetic.

## Everyday commands

| Command | Effect |
|---|---|
| `npm test` | Backend tests (needs the infrastructure running; uses the separate `repoinsight_test` database) |
| `npm run typecheck` | TypeScript check |
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
| `GET /repos/:repoId/permissions` | Members (repository admins) |
| `POST /repos/:repoId/permissions` `{username, role}` | Grant access |
| `DELETE /repos/:repoId/permissions/:username` | Revoke access (effective before the response) |
| `PATCH /repos/:repoId/visibility` `{visibility}` | Public or private |

A private repository the caller cannot read returns the same 404 as one that does not exist.
If access cannot be verified, private and public data alike are refused with 503.

## Security notes

- Secrets live only in `.env` (git-ignored). The backend connects to MongoDB as a least-privilege
  user limited to `readWrite` on the application database.
- OpenSearch runs with its security plugin enabled using bundled development certificates.
- These settings are for local development only; see PROGRESS.md for known limitations.

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
