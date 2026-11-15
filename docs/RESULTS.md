# Measured results

All numbers below were **measured** on 15 November 2026 with the scripts in `backend/src/eval/`.
Raw result files (including environment and per-query details) are in [`docs/results/`](results/).
They are single-machine, single-client measurements of a prototype, not production capacity
results. The architecture report's figures (for example p95 metadata lookup < 250 ms, search
freshness < 60 s) remain **design targets**; where a measurement relates to one, it is marked.

## Test environment

| Item | Value |
|---|---|
| Machine | Laptop, Intel Core i7-1355U (12 logical cores), 16 GB RAM, Windows 11 (build 26300) |
| Runtime | Docker Desktop 29.7.2 (WSL 2, 8 GB to Docker), Node.js 24.14.1 |
| Services | MongoDB 8.0.12 single-node replica set; OpenSearch 2.19.2 single node (512 MB heap); Kafka 3.9.1 single broker (KRaft) |
| Topology | All on one machine; API logic called in-process by the scripts (no HTTP layer) |

## Dataset

| Part | Content |
|---|---|
| Git scenario (`npm run seed`) | `acme/tls-proxy`: real Git history (15 commits; merge, squash, rebase, verified and edited backports), 5 releases, 4 PRs, issues, reviews, 3 revisions of `docs/tls.md`; private `acme/billing` |
| Scale data (`npm run seed:scale`) | 100 generated repositories (10 private), 1,800 issues (opened, edited, closed), 5,400 comments, 200 documents with 4 revisions each |
| Real import | `sindresorhus/is-docker` (public GitHub repository) |
| Totals at measurement | 104 repositories, 1,861 issues, 5,448 comments, 829 document revisions, **16,596 chunks**, **11,922 events** |

The brief's optional prototype dataset is 100 repositories, 2,000 issues/docs, 10,000 chunks and
25,000 events. This dataset matches it for repositories and issues/docs, exceeds it for chunks,
and has about half the events.

## 1. Retrieval evaluation (`npm run eval`)

12 hand-labelled queries (`eval/queries.json`) about the Git scenario, run while the 16,000
generated chunks were also indexed (as distractors), plus 3 leak probes and 3 security questions.

| Metric | Result |
|---|---|
| Recall@10 | **1.00** (12/12 queries found every judged-relevant item in the top 10) |
| MRR | **0.822** |
| Citation validity | **83 / 83** citations re-derived from stored source revisions |
| Unauthorized results (3 leak probes as a non-member) | **0** |
| Stale security advice (3 security answers) | **0** superseded or historical citations presented as current |

Per query, the first relevant result was at rank 1 for 9 queries, rank 2 for q10, rank 4 for q09
(maintenance-branch release notes rank below current guidance) and rank 9 for q02 ("TLS setting
regression"): the bug report #81 is marked historical by the conservative security-epoch rule and
current guidance is boosted above it. This is a known trade-off, not tuned away.

Security answers: s01 and s02 resolved the effective release v2.4.1 and cited only current
guidance; s03 (private repository without releases) withheld a configuration recommendation.

Limitations: 12 queries on a synthetic scenario show that the pipeline is correct (permissions,
citations, current-vs-historical), not that relevance generalises to real repositories.

## 2. Latency (`npm run bench -- --iterations 200 --index-samples 20`)

Sequential calls after 20 warm-up requests; one client, no concurrency.

| Operation | Samples | p50 | p95 | p99 |
|---|---|---|---|---|
| Search (pre-filter, OpenSearch, post-verify, final ACL re-check) | 200 | 102.7 ms | 110.7 ms | 115.1 ms |
| Answer (search + citation checks + release resolution + re-checks) | 40 | 340 ms | 365 ms | 442 ms |

Search stages (p50): access pre-check 2.3 ms, OpenSearch query 5.8 ms, verification against
MongoDB 12.3 ms, **final linearizable access re-check 80.9 ms**. The final re-check dominates: a
linearizable read on a single-node replica set waits for the journal commit interval (100 ms by
default). It is the price of the report's "re-check access before responding" rule.

**Optimisation found by measurement.** The first run checked access with two linearizable reads per
repository and again for every citation: search p50 208 ms / p95 623 ms, answer p50 2,018 ms
(`results/bench-before-acl-fence.json`). The final check now uses one linearizable "fence" read
per request followed by causally consistent majority reads, which still guarantees that a
revocation acknowledged before the request is observed. Evaluation results were identical.

## 3. Indexing delay (same run)

Canonical write in MongoDB until the chunk is countable in OpenSearch, through the outbox relay,
Kafka and the search projector (20 sequential writes while the worker was idle).

| Samples | p50 | p95 | max |
|---|---|---|---|
| 20 | 1,015 ms | 1,046 ms | 1,073 ms |

The OpenSearch refresh interval (1 s) dominates. Design target "search freshness < 60 s in healthy
conditions": met on this setup.

## 4. Projection of an event backlog (`npm run bench:drain`)

The 11,600 events of the scale data were written with the worker stopped, then the worker was
started (one consumer per group; 6 partitions).

| Stage | Time to catch up | Throughput |
|---|---|---|
| Outbox → Kafka relay | 4.2 s | ≈ 2,780 events/s |
| Activity projector | 194 s | ≈ 60 events/s |
| Search projector | 250 s | ≈ 47 events/s (index matched MongoDB afterwards) |
| Graph projector (first version) | did not finish in 30 min | ≈ 3 events/s |
| Graph projector (incremental, after fix) | remaining 7,687 events in 331 s | ≈ 23 events/s |

The first graph projector re-classified the whole repository's guidance for every issue or comment
event. It now re-classifies only the affected thread for those events (whole repository only for
documentation and release events); a test checks that the incremental and full passes agree.
During the backlog, canonical writes and permission checks were unaffected; only projections
lagged, as the design intends.

## What was not measured

Concurrency and throughput under load, multi-node behaviour, failover times, very large commit
histories, real webhook traffic, and memory/CPU profiles. These remain design analysis in the
report.
