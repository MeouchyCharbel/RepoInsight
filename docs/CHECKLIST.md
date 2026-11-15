# Feature-completion checklist

Status: ✅ implemented and tested · 🟡 partial (see note) · ⬜ design only (not built).
Evidence names the automated test file (`backend/test/…`) or the manual check that covers it.

## Assignment (Project 19 brief, section 2)

| Requirement | Status | Evidence |
|---|---|---|
| Import project documentation and release notes | ✅ | `importer.test.ts` (mocked GitHub + real Git), real import of `sindresorhus/is-docker` (PROGRESS.md) |
| Index issue descriptions, comments and review discussions | ✅ | `store.test.ts`, `projectors.test.ts`, `importer.test.ts` |
| Search by repository, label and release | ✅ | `search.test.ts` (filters), UI Search page |
| Answer questions citing exact source sections | ✅ | `search.test.ts` (answer, citation verify), `npm run eval` (citation validity) |
| Track document / issue revisions | ✅ | `store.test.ts` (rev 7 then 6, late issue update), `docs.test.ts` |
| Enforce public / private repository access | ✅ | `acl.test.ts`, `search.test.ts`, `inbox.test.ts`, eval leak probes |
| Compare current guidance with historical decisions | ✅ | `search.test.ts` (compare, classification) |
| Query logs and retrieval benchmarks | ✅ | `search.test.ts` (logs), `npm run eval`, `npm run bench`, docs/RESULTS.md |
| Request flows, data read/changed, freshness | ✅ | docs/API.md, report 1.1; watermarks on derived data |

## Main design focus (brief section 5)

| Requirement | Status | Evidence |
|---|---|---|
| Relate files, commits, PRs, issues, contributors | ✅ | Edges + embedded fields; `trace.test.ts` |
| Trace bug → code change → release | ✅ | `trace.test.ts`, UI issue trace |
| Preserve permissions across code search and docs | 🟡 | Docs/issues/reviews: ✅. Code search not built (D7) |
| Repositories with very many commits | 🟡 | Generation pruning, budgets and ranges implemented; only small histories measured |

## Your development brief

| Item | Status | Evidence / note |
|---|---|---|
| Stack: MongoDB, OpenSearch, Kafka KRaft, Node/TS, React/TS, Docker Compose | ✅ | docker-compose.yml, backend/, frontend/ |
| No extra databases or paid services | ✅ | Only the approved stack |
| Health checks, volumes, loopback ports, memory limits, `.env.example` | ✅ | Phase 0 checks (PROGRESS.md) |
| Security controls kept on (Mongo auth, OpenSearch security plugin, Kafka SASL) | ✅ | Phase 0/3 checks |
| Repository import: metadata, branches, commits, PRs, issues, comments, reviews, releases, docs | ✅ | `importer.test.ts` |
| Pagination, rate limits, transient failures, no duplicates, progress/failure tracking | ✅ | `github.test.ts`, `importer.test.ts` |
| Doc versions, chunks with source references, current vs superseded | ✅ | `chunker.test.ts`, `store.test.ts`, `search.test.ts` |
| Ranked results, precise versioned citations, no fabricated citations | ✅ | `search.test.ts`; citation verification re-derives lines from stored revisions |
| Issue → PR → commit → release; head vs merged commit; merge/squash/rebase | ✅ | `trace.test.ts` |
| Release inclusion from actual Git history; cherry-picks/backports with evidence | ✅ | `trace.test.ts` (trailer verified, edited backport unverified) |
| Repository-level access, revalidation, revocation with stale projections | ✅ | `acl.test.ts`, `search.test.ts`, `inbox.test.ts` |
| Server-side authn/authz; no reliance on UI or index permissions | ✅ | All routes; uniform 404; fail closed |
| No leaks via results, snippets, counts, citations, errors, logs, caches, traversal | ✅ | Tests for each; no totals; `no-store`; canonical snippets; log redaction |
| Input validation, rate limiting, least privilege, secrets out of Git | ✅ | zod strict schemas; rate-limit test; app users for Mongo/OpenSearch/Kafka; secret scan before each commit |
| Safe rendering of untrusted content | ✅ | react-markdown without raw HTML, images dropped |
| Audit logs for security-sensitive operations | ✅ | logins, grants, revocations, visibility changes, stale permission events |
| Event ids, idempotency, duplicates, out-of-order, ordering keys | ✅ | `store.test.ts`, `inbox.test.ts`, `projectors.test.ts` |
| Bounded retries, poison messages, DLQ | ✅ | `consumer.test.ts`, `pipeline.test.ts` (real broker) |
| Transactional outbox; no exactly-once claim | ✅ | `store.ts`; README/PROTOTYPE-SCOPE |
| Rebuild OpenSearch from MongoDB; recovery documented | ✅ | `projectors.test.ts`; README Recovery |
| Sharding implemented | ⬜ | Documented as production design (PROTOTYPE-SCOPE.md) |
| Unit, integration, security, streaming, failure tests | ✅ | 14 backend test files |
| GitHub API failure / rate-limit tests | ✅ | `github.test.ts` |
| Benchmarks with methodology, environment, measured vs targets | ✅ | docs/RESULTS.md |
| Responsive UI: repos, search, filters, citations, history, trace, states | ✅ | Manual browser check (desktop + 375 px), PROGRESS.md Phase 6 |
| Automated frontend tests | ⬜ | Not built (manual checks only) |
| No AI attribution in commits | ✅ | Checked after every commit |
