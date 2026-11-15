# RepoInsight — Project 19 prototype

Prototype of the *Repository, Issue and Documentation Assistant* described in the Project 19
architecture report. MongoDB is the authoritative store; OpenSearch and other views are derived
from it through a transactional outbox and Kafka.

> Status: **Phase 0 (infrastructure)**. See [PROGRESS.md](PROGRESS.md) for what is implemented,
> what is tested, and what remains production-design only.

## Stack

| Component | Role | Local setup |
|---|---|---|
| MongoDB 8.0 | Source of truth: repos, revisions, permissions, edges, events | Single-node replica set `rs0`, auth + keyfile |
| OpenSearch 2.19 | Full-text retrieval and filters (derived, rebuildable) | Single node, security plugin on, 512 MB heap |
| Kafka 3.9 (KRaft) | Change events between the outbox and projectors | Single broker, no ZooKeeper, SASL/PLAIN |
| Node.js + TypeScript | Backend API and workers | *Phase 1* |
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

## Everyday commands

| Command | Effect |
|---|---|
| `npm run infra:status` | Container state and health |
| `npm run infra:logs` | Recent logs |
| `npm run infra:down` | Stop containers, **keep** data |
| `npm run infra:reset` | Stop containers and **delete all local data volumes** |

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
