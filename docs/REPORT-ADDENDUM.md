# Draft addendum for the architecture report

The submitted report states that no prototype was built and that no measurements are claimed.
If the prototype is presented, the report should be updated, for example with this addendum
(edit freely; it is a draft for the author).

---

**Addendum: prototype (built after the design was submitted).** A local prototype implements the
design's core on one machine: MongoDB as the source of truth (single-node replica set), a
transactional outbox and Kafka (KRaft) feeding OpenSearch, activity and graph projections, and a
React web interface. It demonstrates the two non-negotiable properties of Section 1: revocation is
enforced before acknowledgement (search results are re-checked against MongoDB, so a stale index
cannot leak private content), and superseded security guidance is not presented as current
(effective-release resolution and the security-epoch rule). Bug-to-release tracing proves release
inclusion from Git commit ancestry and distinguishes merge, squash and rebase merges and verified
from unverified backports.

Production-scale elements remain design only: sharding, multi-node replication and failover, code
search, vector retrieval, LLM answer synthesis (answers are extractive), CDN and answer caching,
and team/organisation permission expansion.

Measured on a laptop with 104 repositories and 16,596 chunks: Recall@10 1.0 and MRR 0.82 on 12
hand-labelled queries, 83/83 citations verified, 0 unauthorized results, 0 stale security answers,
search p50 103 ms (p95 111 ms), answer p50 340 ms, write-to-searchable p50 1.0 s. These are
single-machine prototype measurements, not production results; methodology and limitations are
in docs/RESULTS.md of the prototype repository.
