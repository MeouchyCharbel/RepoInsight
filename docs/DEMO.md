# Demonstration script (about 10 minutes)

Prerequisites: Docker Desktop running (`scripts/docker-start.ps1` on this Windows build),
`npm install`, `.env` created with `npm run env:init`.

## 0. Start everything (before the presentation)

```bash
npm run infra:up
```

```bash
npm run search:setup
```

```bash
npm run seed
```

```bash
npm run search:rebuild
```

Then, each in its own terminal:

```bash
npm run worker
```

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open http://127.0.0.1:5173. Demo users share `DEMO_USER_PASSWORD` from `.env`:
alice (admin of private `acme/billing`), bob (reader of it), carol (no private access), ops (platform admin).

## 1. Permissions (security invariant)

1. Sign in as **carol** → Repositories lists only public repositories.
2. Open `http://127.0.0.1:5173/repos/acme-billing` → "Not found, or you don't have access" (same
   answer as for a repository that does not exist).
3. Search for `payments gateway mutual TLS` → no private results.
4. Sign in as **bob** in a private window → the same search shows `acme/billing` results.
5. Sign in as **alice** → `acme/billing` → Members → **Revoke** bob.
6. Back in bob's window, repeat the search → private results are gone immediately, although the
   search index was not touched (results are re-checked against MongoDB).
7. Alice grants bob `read` again.

## 2. Bug report → fix → release (main design focus)

1. As carol: `acme/tls-proxy` → Issues → **#81 TLS setting regression**.
2. Scroll to **Trace**:
   - PR #95, linked by a closing keyword in a merged PR (verified), **squash** merge;
     PR head commits are shown as context only.
   - v2.4.0 *not included*, **v2.4.1 verified** (merged commit is an ancestor of the release tag),
     v2.3.5 *verified via backport* (cherry-pick trailer), **v2.2.9 unverified** (edited backport,
     different patch, no trailer).
3. Releases tab → v2.4.1 → *Fixes in this release* lists #81 (from materialised range edges).

## 3. Current vs superseded security guidance (key design situation)

1. **Ask**: repository `acme/tls-proxy`, "What should tls.min_version be set to?".
2. Show: effective release **v2.4.1** (newest stable on the default branch, chosen by policy),
   the warning that older guidance was superseded by a security change, current guidance `"1.2"`
   first, and the issue #12 advice `"1.0"` listed under *Historical or superseded (do not apply)*.
3. Click **Verify citation** on [1] → "Lines … match revision 3"; **Open source** → the document
   viewer highlights the cited lines.
4. Repository → **Guidance** tab, key `tls.min_version` → current (docs rev 3), historical (rev 1/2,
   issue #12) and *why it changed* (v2.4.1 notes, PR #95 and its review).
5. As bob, Ask on `acme/billing`: "Which TLS version does the payments gateway require?" → no
   release can be verified, so no configuration is recommended.

## 4. Revisions and out-of-order events

1. Documentation → `docs/tls.md` → revision list: rev 1 is in v1.0.0, v2.2.9 and v2.3.5 (maintenance
   branches never got the new docs), rev 3 in v2.4.1.
2. Send a late, older issue update through the event intake (ops), e.g. with the API, and show the
   issue keeps its newer state while the revision history marks the late update "out of order".

## 5. Streaming and recovery

1. Repository → Activity: counters with the "as of" watermark and lag.
2. Stop the worker; create an event (e.g. a delivery) → the API still accepts writes, the
   outbox grows (`unpublished_events` on the Activity tab). Restart the worker → it catches up.
3. `npm run search:rebuild` → new index version, alias swapped, old index kept.

## 6. Evidence

`npm test` (backend suite), `npm run eval`, and docs/RESULTS.md for measured results.
