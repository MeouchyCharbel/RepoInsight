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
| 2 Ingestion | done (2026-11-15) |
| 3 Streaming / projections | done (2026-11-15) |
| 4 Release tracing | done (2026-11-15) |
| 5 Search, citations, guidance, eval | done (2026-11-15) |
| 6 Frontend | done (2026-11-15) |
| 7 Docs, benchmarks, demo | done (2026-11-15) |

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

## Phase 2 summary (2026-11-15)
- `ingest/store.ts`: canonical writes, each one majority transaction with its outbox event. Ordering
  by compare-and-set on the provider `updated_at` + content digest: applied / duplicate / stale
  (older revision kept as history only). Event ids `repo:entity:revision`, keys `repo:type:id`.
- Documents: revision n = n-th commit touching the file (real Git history); latest pointer moves
  only forward; content-addressed `blobs`; chunks per report 4.2 with exact line ranges,
  deterministic ids, `config_keys`, `is_latest` and `guidance_status` (old revisions historical).
- Issues (+ `issue_revisions` history), PRs (`merged_sha` only when merged; head commits kept for
  context), comments, reviews, review comments, releases (target from the Git tag; notes stored as
  versioned documents), branches, contributors, commits (blobless clone; generation numbers;
  cherry-pick trailers).
- GitHub client: Link pagination (api.github.com only), rate-limit wait or pause, Retry-After,
  bounded backoff with jitter, no retry on 4xx. Token never logged or stored.
- Import jobs: per-step progress/errors, dependent steps skipped, `since` cursor with 5-min skew,
  public repositories only. `POST /imports`, `GET /imports/:id`, `npm run import -- owner/name`.
- Durable inbox for the six required events (+ edits): dedupe on (provider, delivery_id),
  record-then-apply, `reprocessPending()` for crash recovery, platform-admin intake route.
- Permissions: revocations are tombstones with `seq`; an older grant arriving after a newer revoke is
  ignored and audited.
- Synthetic Git scenario (`npm run seed`): merge, squash, rebase, verified and edited backports.
- Tests: 60 passing (`npm test`, 2026-11-15): chunker 7, GitHub client 6, store 7, inbox 6,
  import + scenario 5, plus Phase 1 suites.
- Real import check (unauthenticated, 2026-11-15): `sindresorhus/is-docker` initial import used 16
  requests (33 commits, 7 releases, 10 issues, 8 PRs, 45 comments, 8 doc revisions); re-run used 6
  requests and wrote nothing new.

## Phase 3 summary (2026-11-15)
- OpenSearch least-privilege user `ri_app` (`npm run search:setup`): indices `ri-*` only; verified
  403 elsewhere and on the security API. TLS chain verified against the dev root CA (hostname check
  skipped: demo certificate is issued to node-0.example.com).
- Outbox relay: idempotent producer (acks=all), creation order, marked published only after ack;
  Kafka outage leaves rows unpublished (attempts counted) and they publish later.
- Consumers: offsets committed after the projection write (at-least-once); bounded retries; poison
  and persistent failures to `ri.changes.dlq` with headers; TransientError (OpenSearch/Mongo
  unavailable) is redelivered, never dead-lettered. Watermarks in `projection_state`.
- Search projector: re-reads canonical chunks per entity (thread metadata from the current parent);
  external_gte versions (source revision x 1e6 + parent revision) reject stale writes; access events
  refresh `visibility`/`acl_epoch` by update-by-query. Membership is never projected.
- Rebuild: new versioned index, count verification, atomic alias swap, catch-up, old index kept.
- Activity projector: processed-event marker + counters in one transaction; late (> 48 h) events mark
  buckets dirty; `recomputeDay` repairs from canonical data. `GET /repos/:id/activity` with watermark.
- `occurred_at` added to outbox events (events written before this change are skipped by the
  activity projector; the dev database was repaired with `npm run activity:recompute -- --all`).
- Tests: 76 passing (`npm test`, 2026-11-15), incl. real Kafka end-to-end and DLQ, OpenSearch
  projection, stale-write rejection, rebuild, replay idempotency.
- Manual run (dev data): worker projected all 150 chunks (OpenSearch count = MongoDB count), outbox
  drained; a live inbox delivery appeared in search and the dashboard; rebuild of 151 docs to
  `ri-chunks-v2` with v1 kept.

## Phase 4 summary (2026-11-15)
- `trace/graph.ts`: ancestry over MongoDB `commits` with generation-number pruning (immediate "no"
  when gen(target) <= gen(fix)); `prev..target` ranges by two-colour painting; node/time budgets
  return "unknown" instead of guessing; missing history also yields "unknown".
- `trace/builder.ts`: edges ISSUE_FIXED_BY_PR (closing keyword; verified only when merged),
  ISSUE_MENTIONS_PR (weak, never proof), PR_MERGED_AS_COMMIT, PR_CONTAINS_COMMIT (context only),
  RELEASE_CONTAINS_COMMIT (materialised per range), COMMIT_BACKPORT_OF (trailer / backport PR link /
  identical patch-id = verified; same files + "backport" message = unverified candidate).
  Pending placeholders resolve when the entity arrives; vanished edges are invalidated, not deleted.
- Merge strategy (merge commit / squash / rebase / fast-forward) shown as "inferred"; inclusion
  never depends on it. Tag moves recompute the range.
- Documentation revisions tagged with the releases that contain them (`chunks.release_ids`),
  published as `release.tagged` so search re-projects them. Issue `fixed_in_release/status` derived.
- APIs: issue trace, releases, fixes per release. Graph projector in the worker; import has a
  `graph` step; `npm run seed` builds the graph.
- Tests: 87 passing (`npm test`, 2026-11-15); 11 tracing tests on the real Git scenario: ancestry
  (squash head commits and pre-rebase commits excluded), budget, merge strategies, verified vs
  unverified backports, ranges, issue #81 evidence per release, no claim without a closing link,
  doc release tags, pending edges, tag move, API + access control.

## Phase 5 summary (2026-11-15)
- Effective release resolver (requested > newest stable on default branch by ancestry > latest
  stable); security_epoch = security releases contained in it. Effective flag stored on releases.
- Guidance classification (recomputed, only downgrades): newer revision supersedes older (verified);
  security-epoch rule marks evidence mentioning a key changed by a later security release
  historical; config-key match flags older discussion "possibly outdated" (candidate);
  GUIDANCE_SUPERSEDES edges; `in_effective_release` marker; re-projected via `guidance.updated`.
- Search: pre-filter (public OR MongoDB membership), post-verify each hit (access, canonical chunk,
  digest, status), linearizable re-check per repository, canonical snippets, no totals. Identifier-
  aware analyzer (`tls.min_version` indexed whole and in parts). Default status=all with markers.
- Citation verification against immutable revisions; guidance compare; extractive answer (no LLM)
  with release-authority and ACL re-checks; withholds security configuration when no release can
  be verified.
- Query logs: HMAC-pseudonymised user, query hash only (raw text off by default), ACL epochs,
  effective release, index alias + watermark, per-stage latency, drops, citation outcome; 30-day TTL;
  admin aggregates.
- Tests: 101 passing (`npm test`, 2026-11-15); 14 new search/guidance tests including stale
  projection after visibility change, immediate revocation, tampered digest, forged citation text.
- Evaluation smoke run (2026-11-15, 12 hand-labelled queries on the synthetic scenario):
  Recall@10 1.0, citations 78/78 valid, 0 unauthorized results in 3 leak probes, stale-security-
  advice rate 0 (3 answers). q02 (bug report #81) ranks 9th because the conservative security-epoch
  rule marks it historical and current guidance is boosted. Benchmark smoke run (50 searches):
  p50 52 ms, answer p50 414 ms, indexing delay p50 1.0 s. Final measurements in Phase 7.

## Phase 6 summary (2026-11-15)
- React 19 + Vite 8 + React Router 7 frontend (`frontend/`), same-origin `/api` proxy (no CORS),
  plain CSS design tokens with light/dark themes, 40 px+ touch targets, visible focus, mobile-first.
- Views: sign-in; repositories; repository tabs (issues with label/state filters and keyset paging,
  documentation, releases with fixes per release, guidance comparison, activity with watermark,
  members for repository admins); issue page (markdown body, comments, revision history with
  out-of-order flags, trace with verified/unverified/not-included per release and evidence);
  document viewer (line numbers, cited-line highlight, revision list with releases, section markers);
  search (repository/type/label/release/status filters, markers, verify-citation, open-source links);
  ask (effective release, warnings, numbered verified citations by section).
- Untrusted text: react-markdown without raw HTML, images dropped, links rel=noopener; snippets as
  plain text. 404 messages never reveal existence; 503 offers retry; 401 returns to sign-in.
- Backend: document/revision/comment read APIs (3 tests); answers keep only current evidence within
  half of the best score (max 3) and snippets prefer body lines over headings.
- Checked in the browser (2026-11-15): sign-in as carol (no private repo listed), issue #81 trace,
  ask flow with citation verification, document viewer at 375 px width. Console: only the expected
  401 from the pre-login session check. Backend tests: 104 passing; frontend type-check and build OK.

## Phase 7 summary (2026-11-15)
- Scale data generator (`npm run seed:scale`): 100 repositories, 1,800 issues, 5,400 comments,
  800 document revisions, 16,400 chunks, 11,600 events, all through the normal store and outbox.
- Measurements (docs/RESULTS.md, raw files in docs/results/): Recall@10 1.0, MRR 0.822, citations
  83/83, 0 unauthorized results, 0 stale security answers; search p50 103 ms / p95 111 ms; answer
  p50 340 ms; write-to-searchable p50 1.0 s; backlog drain: relay 2,780 ev/s, activity 60 ev/s,
  search 47 ev/s, graph 23 ev/s (after fix).
- Fixes found by measurement: graph projector re-classified the whole repository per event
  (~3 ev/s) -> incremental per thread; final ACL re-check used two linearizable reads per
  repository and per citation -> one linearizable fence per request + causally consistent majority
  reads (search p50 208 -> 103 ms, answer 2,018 -> 340 ms). Tests: 105 passing.
- Docs: README rewrite, docs/API.md, DEMO.md, RESULTS.md, PROTOTYPE-SCOPE.md, CHECKLIST.md,
  REPORT-ADDENDUM.md (draft for the author).

## Known limitations
- No automated frontend tests (flows were checked manually in the browser).
- No Content-Security-Policy header in the Vite dev server (would be set by the production web server).
- No PR detail page or import UI (imports use the CLI or API).
- Security-epoch rule over-labels: any older evidence mentioning a changed key (including the bug
  report that asked for the fix) is historical; this demotes it in ranking (report acknowledges this).
- Answers are extractive excerpts; there is no natural-language synthesis.
- Answer latency is dominated by per-citation verification with its own ACL re-checks.
- PR and comment citations can be verified only while the cited revision is the stored one (no
  comment/PR revision history is kept).
- Patch-ids are computed only for fix commits and same-file candidates off the default branch,
  and only when the local clone is available; backport PR links require "backport #N" wording.
- The graph projector rebuilds the whole repository graph on `commits.ingested` (fine at prototype
  scale; production would update incrementally).
- `release.tagged` outbox events are written after the chunk update, not in the same transaction;
  a crash in between is repaired by the next rebuild.
- KafkaJS 2.2.4 is unmaintained since 2023 (works with Kafka 3.9; prints a harmless
  TimeoutNegativeWarning on Node 24). Production would use a maintained client.
- Comment documents can briefly show older parent labels if two projections of the same thread
  race with equal versions (single consumer per partition makes this unlikely).
- Rebuild catch-up re-projects sources with chunks created during the rebuild; visibility changes
  during a rebuild are covered by the next access event.
- Comments do not bump the parent issue's revision; doc revisions do not follow renames; rewritten
  history can renumber document revisions.
- Release edits are detected by content digest only (the REST API has no release updated_at).
- Per import, details (commits, reviews) are fetched for at most 100 merged PRs; empty reviews skipped.
- `commits.ingested` is emitted after the commit bulk insert (commits are immutable, so it is not
  needed for correctness); branch moves emit no events.
- Imports run inside the API process (no job queue); inbox reprocessing is not yet scheduled (Phase 3).
- Patch-id computation for backport matching is deferred to Phase 4.
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
