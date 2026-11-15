# Prototype vs proposed production architecture

The architecture report describes a production design for millions of repositories. This prototype
implements the parts needed to demonstrate and test the design's correctness properties on one
laptop. This table states, per design element, what actually runs.

Legend: **Implemented** = built and covered by automated tests; **Partial** = built in simplified
form; **Design only** = described in the report, not built.

## Data and storage

| Report element | Status | Prototype | Production design (not built) |
|---|---|---|---|
| MongoDB as source of truth (entities, revisions, permissions, edges, events) | Implemented | Single-node replica set `rs0`; all collections and indexes of report 7.2/8 (`backend/src/db.ts`) | Sharded replica sets (3 members each) |
| Shard keys starting with `repo_id`, pre-split, zones, hot-key handling | Design only | Indexes use the same compound keys; a test checks every repository-scoped unique key starts with `repo_id` | mongos routing, balancer, pre-splitting, resharding |
| Random, non-monotonic `repo_id` | Implemented | `r` + 64 random bits for imported repositories | – |
| Object storage for immutable text | Partial (approved D1) | Content-addressed `blobs` collection in MongoDB | S3-compatible object store |
| OpenSearch full-text projection | Implemented | One index behind an alias, BM25, identifier-aware analyzer, versioned rebuild with alias swap | Time/size-class index split, replicas, routing by `repo_id` |
| Code search (`code_blobs`, trigram) | Design only (D7) | – | n-gram index of default branch + release tags |
| Vector / semantic retrieval | Design only | – | Optional vector index after permission filtering |
| Cassandra / PostgreSQL / Neo4j | Not used (as in the report's alternatives) | – | – |

## Ingestion and streaming

| Report element | Status | Prototype |
|---|---|---|
| Bootstrap with pagination, rate limits, cursors, reconciliation | Implemented | GitHub REST client + blobless Git clone; per-step job progress; incremental `since` |
| Durable inbox, delivery-id deduplication | Implemented | `inbox` with unique (provider, delivery_id); record-then-apply; crash repair |
| Webhooks from GitHub | Partial | Same event intake via `POST /admin/deliveries`; no public webhook endpoint (not exposed to the internet) |
| Per-entity versioned upserts (compare-and-set) | Implemented | Provider `updated_at` + content digest: applied / duplicate / stale |
| Transactional outbox | Implemented | Each canonical change and its event in one majority transaction |
| Kafka partitioned by `repo_id:entity_type:entity_id` | Implemented | 6 partitions (report: 512); KRaft single broker |
| Separate high-priority permission topic | Implemented | `ri.permissions` |
| Idempotent consumers, retries, DLQ, no exactly-once claim | Implemented | Offsets after projection writes; bounded retries; `ri.changes.dlq` |
| Rebuild projections after interruption | Implemented | Search rebuild with verification + alias swap; activity recompute from canonical data |
| Six required events | Implemented | issue opened/closed, comment added, document changed, release published, access revoked (+ grant, edits) |

## Main design focus: code, issues and dependencies

| Report element | Status | Prototype |
|---|---|---|
| Typed edge vocabulary (report 5.1) | Implemented | All relations except `COMMIT_MODIFIES_FILE`/`AUTHORED_BY` edges, which are embedded fields (`changed_paths`, `author_id`) as in the report |
| Release inclusion by DAG ancestry from `merged_sha` | Implemented | Merge, squash and rebase covered by tests on a real Git scenario |
| Generation-number pruning, bounded traversal, "unknown" on budget | Implemented | `trace/graph.ts` |
| Release ranges `prev..target` materialised | Implemented | Two-colour painting; recomputed when a tag moves |
| Backports: trailer, backport PR link, patch-id; unverified otherwise | Implemented | Patch-ids via `git patch-id --stable` on the local clone |
| Pending edges for not-yet-ingested targets | Implemented | Resolved on arrival |
| Very many commits | Partial | Algorithms are the report's; measured only on small histories |
| Permissions across code search | Design only | No code search; documents, issues and reviews use the same two permission gates |

## Consistency, security and answers

| Report element | Status | Prototype |
|---|---|---|
| Authoritative ACL with `acl_epoch`, epoch-validated cache, fail closed | Implemented | Majority reads; linearizable final re-check; 503 when unverifiable |
| Revocation effective before acknowledgement | Implemented | Majority transaction; tested with a warm cache and a stale index |
| Pre-filter + post-verify search results | Implemented | Membership read from MongoDB at query time (no `user_repo_access` projection needed at this scale) |
| Team / org permission expansion | Design only | Direct grants only |
| Effective-release resolver, security epoch | Implemented | Policy: requested > newest stable on default branch > latest stable |
| Superseded-guidance detection (explicit, config-key, security epoch) | Implemented | Only downgrades; `GUIDANCE_SUPERSEDES` edges |
| LLM answer synthesis | Design only (D2) | Extractive answers from verified excerpts (the report's "LLM unavailable" mode) |
| Query logs, retrieval evaluation, benchmarks | Implemented | Pseudonymised logs; `npm run eval`, `npm run bench`, `npm run bench:drain` |
| CDN, answer caches, request coalescing, autoscaling, load shedding | Design only | – |
| Multi-node failover | Design only | Single nodes; component failures are simulated in tests |

## CAP / PACELC in the prototype

The operations keep the report's choices, but on single nodes there is no real partition to test.
What is tested: access checks and revocation fail closed (503) when the authority is unreachable;
search and dashboards are served from projections that may lag and are labelled with watermarks;
a Kafka outage only delays projections (outbox), and stale projections are never trusted for access.
