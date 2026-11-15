# RepoInsight — Project 19 prototype

Working prototype of the *Repository, Issue and Documentation Assistant* from the Project 19
architecture report: import repositories, search documentation and discussions with exact,
versioned citations, trace a bug report to the release that fixed it, and never present
superseded security guidance or private content to the wrong reader.

| Document | Content |
|---|---|
| [docs/DEMO.md](docs/DEMO.md) | 10-minute demonstration script |
| [docs/API.md](docs/API.md) | API reference |
| [docs/RESULTS.md](docs/RESULTS.md) | Measured evaluation and benchmark results (methodology, environment) |
| [docs/PROTOTYPE-SCOPE.md](docs/PROTOTYPE-SCOPE.md) | What is implemented vs production design only |
| [docs/CHECKLIST.md](docs/CHECKLIST.md) | Feature-completion checklist with evidence |
| [docs/REPORT-ADDENDUM.md](docs/REPORT-ADDENDUM.md) | Draft addendum for the architecture report |
| [PROGRESS.md](PROGRESS.md) | Phase log, decisions and known limitations |

## Architecture in one paragraph

MongoDB is the single source of truth (repositories, issues, PRs, comments, releases, commits,
document revisions, chunks, permissions, relationship edges). Every canonical change is written in
one majority transaction with an outbox event; a relay publishes the outbox to Kafka (KRaft), and
idempotent projectors maintain the OpenSearch index, the issue-activity dashboard and the
relationship graph. OpenSearch is derived data: every result is re-checked against MongoDB before
it is shown, and the index can be rebuilt from MongoDB at any time.

```
GitHub API / Git clone / event intake
        │
        ▼
MongoDB (canonical + outbox, one transaction) ──► relay ──► Kafka ──► search projector ──► OpenSearch
        ▲                                                       ├──► activity projector ──► daily counters
        │                                                       └──► graph projector ───► edges, release ranges, guidance status
API (Fastify) ◄── pre-filter + post-verify + final ACL re-check ──┘
        ▲
React web app
```

## Stack

| Component | Role | Local setup |
|---|---|---|
| MongoDB 8.0 | Source of truth | Single-node replica set `rs0`, auth + keyfile, least-privilege app user |
| OpenSearch 2.19 | Full-text retrieval (derived) | Single node, security plugin on, app user limited to `ri-*` |
| Kafka 3.9 (KRaft) | Change events | Single broker, no ZooKeeper, SASL/PLAIN, topics `ri.changes`, `ri.permissions`, `ri.changes.dlq` |
| Node.js + TypeScript | API (Fastify) and worker | `backend/`, API on 127.0.0.1:4000 |
| React + TypeScript | Web app (Vite) | `frontend/`, 127.0.0.1:5173, proxies `/api` |

All services bind to 127.0.0.1. The stack uses about 3 GB of RAM.

## Setup

Requirements: Docker Desktop (WSL 2) with Compose v2, Node.js 20.12 or later.

```bash
npm run env:init
```

Creates `.env` with random local secrets (never overwrites; never committed). Optionally add a
read-only `GITHUB_TOKEN` for imports.

```bash
npm install
```

```bash
npm run infra:up
```

```bash
npm run search:setup
```

Creates the least-privilege OpenSearch user (uses the admin password from `.env` only here).

```bash
npm run seed
```

Synthetic demo users and repositories plus a real Git scenario (merge, squash, rebase, verified and
edited backports; the TLS security-regression story). Optional larger data set:

```bash
npm run seed:scale
```

```bash
npm run search:rebuild
```

Then run each of these in its own terminal and open http://127.0.0.1:5173:

```bash
npm run worker
```

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Demo users `alice` (admin of private `acme/billing`), `bob` (reader), `carol` (no private access)
and `ops` (platform admin) share `DEMO_USER_PASSWORD` from `.env`. All demo data is synthetic.

## Commands

| Command | Effect |
|---|---|
| `npm test` | Backend test suite (needs the infrastructure; uses the separate `repoinsight_test` database) |
| `npm run typecheck` / `npm run build:web` | Type checks / production web build |
| `npm run import -- owner/name` | Initial or incremental import of a public GitHub repository |
| `npm run worker` | Outbox relay and the search, activity and graph projectors |
| `npm run search:rebuild` | Rebuild OpenSearch from MongoDB into a new index and swap the alias |
| `npm run activity:recompute [-- --all]` | Repair dashboard counters from canonical data |
| `npm run eval` | Retrieval evaluation (Recall@10, MRR, citation validity, leak probes, stale advice) |
| `npm run bench -- --iterations 200 --index-samples 20` | Latency and indexing delay (worker running) |
| `npm run bench:drain` | Time for the running worker to project an event backlog |
| `npm run infra:status` / `infra:logs` / `infra:down` | Container status / logs / stop (data kept) |
| `npm run infra:reset` | Stop containers and **delete all local data volumes** |

## Security model

- Server-side sessions: random token in an httpOnly SameSite=Strict cookie; only its hash is stored.
  Passwords hashed with scrypt. Login rate-limited; logins and access changes are audited.
- MongoDB is the only authority for access: membership cache valid only while the repository's
  `acl_epoch` is unchanged; revocations commit with majority write concern before they are
  acknowledged; every response is re-checked with a linearizable read; unverifiable access fails
  closed (503).
- Search: pre-filter by public visibility or MongoDB membership, post-verify every hit (access,
  canonical chunk, content digest), snippets from MongoDB, no hit totals. A private repository you
  cannot read is indistinguishable from one that does not exist.
- Strict input validation (unknown parameters rejected), `Cache-Control: no-store`, generic errors,
  secrets redacted from logs, pseudonymised query logs without raw query text.
- Untrusted repository text is rendered without raw HTML or images.
- Development-only settings: OpenSearch demo TLS certificates; Kafka SASL without TLS on loopback;
  session cookie without `Secure` until served over HTTPS (`COOKIE_SECURE=true`).

## Recovery

| Failure | Effect | Recovery |
|---|---|---|
| Kafka down | Canonical writes continue; outbox grows; search and dashboards lag | Relay retries with backoff and publishes the backlog in order |
| Worker crash | Projections lag | Consumers resume from committed offsets; re-applied events are idempotent |
| OpenSearch down | Search returns 503; issue, document and trace pages still work | Events are redelivered when it returns; or `npm run search:rebuild` |
| MongoDB unreachable for access checks | Requests that need access return 503 (fail closed) | Automatic once MongoDB is reachable |
| Poison event | Sent to `ri.changes.dlq` with diagnostics after bounded retries | Inspect, fix, replay |
| Late or missed events | Dashboard buckets marked dirty; reconciliation via re-import | `npm run activity:recompute`; `npm run import -- owner/name` |

## Known limitations

See [PROGRESS.md](PROGRESS.md#known-limitations) and [docs/PROTOTYPE-SCOPE.md](docs/PROTOTYPE-SCOPE.md).
In short: single-node infrastructure (no sharding or failover), no code search, no vector
retrieval, extractive answers instead of an LLM, direct permissions only (no team expansion),
the security-epoch rule deliberately over-labels older evidence as historical, KafkaJS is
unmaintained, and there are no automated frontend tests.

## Troubleshooting

**Docker Desktop: "rename … .sock … .stale: The file cannot be accessed by the system".**
On some Windows builds Docker Desktop leaves socket files behind that it cannot reuse. Start it
with the helper, which moves the two socket folders aside (nothing is deleted):

```bash
powershell -ExecutionPolicy Bypass -File scripts/docker-start.ps1
```

If image pulls hang at "Pulling from …", Docker Desktop's internal proxy is stuck: restart it with
the same helper.
