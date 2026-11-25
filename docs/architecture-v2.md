# Architecture v2: Cloudflare D1 data plane, code-only GitHub

Model, views, ADRs and threat model for this contract: [architecture/](architecture/README.md).

Status: in build (decided 2026-11-24). This file is the contract between the
v2 work streams. Change it in the same PR as any code that changes a contract.

## Why

v1 keeps the job list in git (`public/data/jobs.json`), run state in an Azure
Blob lease/bundle state machine, and lets a Claude agent with shell access edit
the 1.4 MB file. That produced "remote history diverged" stalls, "merge is
deploy" breakage, silent no-op merges, a prompt-injection surface and manual
backfills. v2 makes GitHub code-only, D1 the single data store, merge rules
deterministic code, and Claude a tool-less, schema-constrained judge.

## Owner decisions (2026-11-24)

- Jobs, verdicts (ledger), streaks, runs and e-mail candidates in D1
  `jobs-data`. The tracker in a **separate** D1 `jobs-tracker`, so restoring job
  data never rewinds the owner's clicks. Both are EU jurisdiction, Free plan
  (7-day Time Travel), plus a nightly export to the Azure backup account.
- LinkedIn alert e-mails are ingested via Email Routing on a subdomain address.
- A repost of an ad the owner ignored is **shown and flagged**, not hidden.
- A positive tracker status (saved/applied/interview/offer) releases
  `tracker:` **and** `fit:` verdicts for that id. `dead:` and `dedupe:` stay.
- A dead ad the owner touched (any tracker status, or `Mentett`) is **closed**
  (`closed` set once), kept, status unchanged, no `dead:` verdict. Only an
  untouched feed row is deleted and ledgered `dead:liveness`.
- Claude: subscription CLI first, federated API fallback, no tools, JSON schema.
- Indeed Hungary (via JobSpy) is a live source from cutover.
- Cutover without a side-by-side comparison. After cutover `public/data` is
  deleted from `main`; git history is kept.

## Resources

| Resource | Id | Binding |
| --- | --- | --- |
| D1 `jobs-data` (eu) | `5f419f86-7d5d-4985-b5aa-b238c97325b2` | `JOBS_DB` |
| D1 `jobs-tracker` (eu) | `f0e46999-c933-4b19-abf1-6df633f77b50` | `TRACKER_DB` |
| KV `jobs-snapshot` | `584f970c1e8f47bdbb036612d2024183` | `SNAPSHOT` |
| KV `TRACKER` (v1, kept read-only until cutover + 30 days) | `51cd47b0a08e457abadcad48db9e7895` | `TRACKER` |
| Access team | `toomhorvath.cloudflareaccess.com` | var `ACCESS_TEAM` |
| Access application AUD | `3465d4c316d7df67cfe34bc677103b9437517b3d094d5caf7746a419d6774d0e` | var `ACCESS_AUD` |

## Who does what

```text
Azure Container Apps Job jobs-refresh (13:00 UTC, parallelism 1, stateless)
  scripts/v2/run.mjs
    1. load state       D1 REST API (jobs, verdicts, streaks, email_candidates, tracker)
    2. tracker verdicts tracker → tracker: verdicts; positive status releases tracker:/fit:
    3. collect          fetch-sources (Profession, NFJ), fetch-linkedin, fetch-indeed.py,
                        email candidate ids → LinkedIn guest detail
    4. filter           vetoes.mjs + ledgerLookup (existing)
    5. liveness         check-liveness.mjs (existing, on a materialised jobs.json)
    6. prefetch         ad text for NEW candidates only (scripts/v2/prefetch.mjs)
    7. judge            scripts/v2/judge.mjs → Claude, no tools, JSON schema, batches
    8. merge            scripts/v2/merge.mjs (pure, deterministic, tested)
    9. validate         validate.mjs on the materialised result
   10. commit           one D1 batch (idempotent per slot) + SNAPSHOT KV put
   11. notify           notify-diff.mjs (previous vs new snapshot) → Telegram
                        (assume-delivered policy unchanged)

Cloudflare Worker jobs-dashboard (behind Access; workers.dev and previews disabled)
  run_worker_first: /data/*, /api/*
  every request: verify Cf-Access-Jwt-Assertion (RS256, iss, aud, exp)
  GET /data/jobs.json, /data/last-run.json   SNAPSHOT KV
                                             (missing key → 503, logs snapshot_missing)
  GET/PUT /api/tracker                       TRACKER_DB, same JSON contract as v1
  email()                                    LinkedIn alert → JOBS_DB.email_candidates
```

The runner talks to D1 and KV through the Cloudflare REST API with one API
token (Account D1 Edit + Workers KV Storage Edit), stored in Key Vault as
`jobs-cloudflare-api-token`. The Worker never parses the 1.5 MB list: Free-plan
CPU is 10 ms per request, so it only streams the snapshot.

## D1 `jobs-data` schema (`migrations/jobs/0001_init.sql`)

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,                 -- li-<n> | pr-<n> | nfj-<slug> | in-<jobkey>
  role TEXT NOT NULL, company TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('LinkedIn','Profession','NoFluff','Indeed')),
  category TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('Employee','Contract')),
  description TEXT NOT NULL,
  salary_lo INTEGER NOT NULL, salary_hi INTEGER NOT NULL,
  salary_posted INTEGER NOT NULL CHECK (salary_posted IN (0,1)),
  benchmark TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,                -- Mentett | Értesítő | NFJ keresés | Indeed
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,   -- YYYY-MM-DD
  closed TEXT,                         -- YYYY-MM-DD, set once
  repost_of TEXT                       -- id of an owner-ignored twin, shown flagged
);
CREATE TABLE verdicts (                -- the rejection ledger
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,                -- fit:… | tracker:… | dead:… | dedupe:… | legacy
  judge_version TEXT,                  -- set for fit: verdicts written by v2
  at TEXT NOT NULL                     -- ISO timestamp
);
CREATE TABLE streaks (id TEXT PRIMARY KEY, count INTEGER NOT NULL CHECK (count >= 0));
CREATE TABLE runs (
  slot TEXT PRIMARY KEY,               -- 2026-11-25T13:00:00.000Z
  payload_sha256 TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  run_note TEXT NOT NULL,              -- the last-run.json document
  diff TEXT NOT NULL                   -- {added:[ids], removed:[ids], updated:n}
);
CREATE TABLE email_candidates (
  id TEXT PRIMARY KEY,                 -- li-<n>
  received_at TEXT NOT NULL,
  consumed_slot TEXT                   -- set when a run has evaluated it
);
```

Rules for writes: never more than 100 bound parameters per statement; pass id
lists as one JSON string and expand with `json_each(?)`. A run's writes are one
`batch` request (atomic). Snapshot KV keys: `jobs.json`, `last-run.json`.

## D1 `jobs-tracker` schema (`migrations/tracker/`)

```sql
-- 0001_init.sql
CREATE TABLE tracker (
  id TEXT PRIMARY KEY CHECK (length(id) <= 200),
  st TEXT NOT NULL CHECK (st IN ('saved','applied','interview','offer','rejected','ignored')),
  at TEXT NOT NULL CHECK (length(at) <= 40)
);
-- 0002_meta.sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

**Initialised sentinel.** The one-off v1 → D1 import (`scripts/v2/import.mjs`)
writes `INSERT INTO meta (key, value) VALUES ('tracker_imported', <ISO timestamp>)`
as its **last** step, after the tracker rows. Until that row exists, `GET` and
`PUT /api/tracker` answer **503** (`no-store`); any D1 error (e.g. a missing
table) is also a 503. So an empty or half-imported table is never served as the
truth: a browser reading `{}` would treat every older local entry as deleted on
another device. The v1 KV blob stays bound and untouched as the recovery copy.

`GET /api/tracker` returns `{ [id]: {st, at} }` (built by SQLite with
`json_group_object` in the same query that reads the sentinel; an empty but
initialised table is `{}`). `PUT` replaces the whole map (same shape check as v1)
in one D1 `batch`: `DELETE FROM tracker`, then `INSERT … SELECT … FROM
json_each(?1)` with the sanitised map as its only bound parameter. `PUT`
additionally requires:

- `Content-Type: application/json` (else 415);
- when an `Origin` header is present, exactly `https://jobs.toomhorvath.com` (else 403);
- at most 512 KB **in bytes** (v1 counted characters): a `Content-Length` above the
  cap is refused before the body is read, and the body is read with a byte cap so
  a chunked or mis-declared body cannot exceed it either (413).

The sanitised map has a null prototype, so an id such as `__proto__` is stored
like any other instead of vanishing.

**Client rule (`public/app.js`).** A `PUT` replaces the server's whole map, so a
browser only PUTs after it has merged with the server copy in the current page
load. Before that, a local change re-attempts the `GET` (which pushes the merged
map itself). A non-200 `GET` (503, offline, expired Access session) never deletes
local entries and never leads to a PUT.

## Access identity

The Worker verifies the `Cf-Access-Jwt-Assertion` header against
`https://<ACCESS_TEAM>/cdn-cgi/access/certs` (cached in module scope), checking
signature, `iss`, `aud` contains `ACCESS_AUD`, and `exp`/`nbf`. It then allowlists:
browser routes need `email` in secret `OWNER_EMAILS` (comma-separated); the runner
needs `common_name` equal to secret `RUNNER_CLIENT_ID` (the service token's
Client ID, including its `.access` suffix) and may only `GET /data/*` and
`GET /api/tracker`. `ACCESS_ENFORCE=log` only logs a failure (first deploy);
`enforce` returns 403; any value other than exactly `log` enforces. A failure is
logged as one JSON line `{event:"access_denied", mode, reason, principal, method,
path}` where `principal` is a category (`owner|runner|user|service|unknown`):
never the token, the e-mail or any claim value. Clock skew tolerance is 60 s.
E-mails compare ASCII-only: `A-Z` is lower-cased, nothing else is folded, and an
address with any character outside printable ASCII never matches (Unicode
folding maps e.g. the Kelvin sign onto `k`).

Key set: an unknown `kid` refetches the certs (rate-limited to once per 30 s after
the first successful load), which is how Access key rotation is picked up. The
cached set also expires after **1 hour**. If that refresh fails, the previous set
stays in use (stale-on-error) and the refresh is retried at most every 30 s, so a
blip on the certs endpoint does not 403 the owner. The owner e-mail is a secret,
never committed.

## Alert e-mail ingestion (`email()`)

1. **Sender.** The header `From` must be a single address at `linkedin.com` or a
   subdomain (ASCII-only lower-casing). Otherwise `setReject`. The envelope sender
   is not checked: LinkedIn uses a bounce subdomain and a forward rewrites it.
2. **Verification.** Email Routing prepends its own `Authentication-Results`
   before invoking the Worker. Only the **first** `Authentication-Results` is
   read, and only if its authserv-id is exactly `mx.cloudflare.net`.
   `message.headers.get()` joins repeats with `, `, so only the text before the
   first comma is used. That header is refused outright if it contains `"`, `\`,
   unbalanced parentheses, or a `;` or `=` inside a `(comment)`. Its values and
   comments can echo sender-controlled text (e.g. `smtp.mailfrom`, the SPF
   comment), and the resinfo split runs before comments are removed, so
   `(x; dmarc=pass header.from=linkedin.com)` must never parse as a result. The
   cost of failing closed: an SRS envelope sender (`SRS0=…`, i.e. a forward) in
   the SPF comment makes the message unverified.
   The deciding check is **DMARC**: at least one `dmarc` result, and every one is
   `pass` with a `header.from` property that is **present** and is `linkedin.com`
   or a subdomain. A bare `dkim=pass` is not enough (any domain can sign for
   itself). `ARC-*` headers are ignored.
3. **Unverified LinkedIn mail is dropped, not rejected.** It gets one log line
   `{event:"email_unverified", reason, verdicts}` (`reason` ∈ `missing |
   not_cloudflare | unsafe | dmarc`; `verdicts` = `method=result` tokens only, no
   property values or addresses). No bounce: a reject would tell a spoofer what
   passes, and bouncing real alerts after a header-format change could get the
   address disabled by LinkedIn.
4. **Extraction.** The raw MIME is read up to 512 KB (rest dropped, logged as
   `truncated`). Quoted-printable and base64 parts are decoded in one linear pass,
   and only `https://(*.)linkedin.com/(comm/)jobs/view/<digits>` links count, at
   most 200 ids.
5. **Store.** One statement: `INSERT OR IGNORE INTO email_candidates (id,
   received_at) SELECT 'li-' || value, ?1 FROM json_each(?2)`. If it fails (e.g.
   missing table), the Worker logs `email_store_failed` and drops the message.
   It never throws, because a throw would bounce the alert.

A LinkedIn mail without job links is not ingested. The body is never stored or
replied to. When the `FORWARD_TO` Worker secret is set, every verified LinkedIn mail
is then forwarded untouched to the owner's inbox ([ADR 6](architecture/decisions/0006-ingest-linkedin-alert-emails.md), step 5).

## Judge contract (`scripts/v2/judge.mjs`)

```js
judge(candidates, context) → Promise<{ verdicts, model, judgeVersion, unjudged }>
// candidates: [{ id, source, role, company, location, url, postedAt?, adText,
//                salary?: {lo, hi, type, visible}, possibleTwins: [{id, role, company, status, tracker}] }]
// context: { ownerProfile: string, targetRoles: string, salaryBenchmarks: string, today: 'YYYY-MM-DD' }
// verdicts: [{ id, keep: boolean, reason: 'fit:<slug>' | null, category, type,
//              salaryLo, salaryHi, salaryPosted, benchmark, description, duplicateOf: id | null }]
// unjudged: [id]   no valid verdict this run; retry next run, never keep by default
// model: comma-joined model id(s) that produced the verdicts, null if no call succeeded
summarize(stats, kept, warnings) → Promise<{ summary, warnings }>   // Hungarian, plain text, ≤1200 chars
```

The judge sees ad text as data only: no tools, no MCP, `--json-schema`, batches of
at most 20 candidates. An invalid or missing answer for a candidate leaves it
unjudged (retried next run), never kept by default.

Details (`scripts/v2/judge.mjs`, prompts in `docs/judge-prompt.md`):

- One `claude --print` per batch with `--system-prompt <judge prompt> --json-schema
  <schema> --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --permission-mode default --no-session-persistence --output-format json`, in an
  empty temp cwd. Context and candidates go on **stdin**, candidates as one
  `<candidates_json>` block with `<`/`>` JSON-escaped. Flags verified against CLI
  2.1.328 (`--help`) and the pinned 2.1.284 binary.
- Env: `ANTHROPIC_MODEL` (required), `JOBS_REFRESH_JUDGE_EFFORT` (else
  `JOBS_REFRESH_MERGE_EFFORT`, else `high`), `CLAUDE_CONFIG_DIR` (required). Auth
  and fallback are `scripts/claude-cli.mjs` (shared with the v1 merge):
  subscription first, then each `JOBS_REFRESH_FALLBACK_MODELS` model via
  federation; only CLI failures fall back, an unparseable answer does not. When
  every leg fails for a batch, the remaining batches are not attempted (unjudged).
- Code validation per verdict: id from the batch and answered once, `category` in
  the jobs.json vocabulary (`CATEGORIES`), `type` Employee|Contract, integer
  salaries 100000–10000000 with lo ≤ hi, `reason` null iff keep, else
  `fit:[a-z0-9][a-z0-9:._-]*`, `benchmark`/`description` non-empty without `<`,
  `duplicateOf` null or one of that candidate's `possibleTwins`. A portal-posted
  band (`salary.visible`) overrides the model's salary fields verbatim.
- `judgeVersion` = first 12 hex of sha256(judge prompt + JSON schema).
- `summarize` never throws: on failure it returns a fixed Hungarian line and
  appends a warning. `<` in the model's text is replaced, over-long text cut.

## Prefetch (`scripts/v2/prefetch.mjs`)

```js
fetchAdText(candidate) → Promise<{ adText: string, error: null } | { adText: null, error }>  // never throws
prefetchAll(candidates) → Promise<[{ ...candidate, adText, adTextError? }]>  // input order kept
```

LinkedIn guest `jobPosting/<id>`, Profession ad page (job-description section +
JSON-LD facts), NFJ `/api/posting/<slug>`, Indeed: a non-empty `candidate.adText`
(JobSpy description) is used without a request, else the ad page on an
`indeed.com` host. Plain text, capped at 12 KiB, `scripts/http.mjs`, 4 workers
with a 250 ms pause, LinkedIn 429/999 backoff as in `check-liveness.mjs`. Errors:
`http-<status>`, `timeout`, `network`, `parse`, `empty`, `bad-id`, `bad-url`,
`unsupported-source`.

## Candidate row (collectors → run.mjs)

```js
{ id, source: 'LinkedIn'|'Profession'|'NoFluff'|'Indeed', role, company, location,
  url, postedAt?, salary?: {lo, hi, type: 'permanent'|'b2b', visible}, adText? }
```

`company` is `null` when the portal omits it (LinkedIn and Indeed both can).
`adText` is set by collectors that already hold the ad body (Indeed: plain text,
at most 12 KB of UTF-8); prefetch skips candidates that carry it.

### Indeed (`scripts/fetch-indeed.py`, JobSpy)

Run as `/opt/indeed/bin/python -I scripts/fetch-indeed.py [-o FILE]` (venv from
`runtime/requirements-indeed.txt`, python-jobspy 1.5.0, every wheel hash-pinned).
It writes `.cache/indeed-latest.json`:

```js
{ collectedAt, state: 'ok'|'undetermined', reason?, lookbackHours,
  queries: [{q, got, fresh, capped}], truncatedQueries: [q], queryFailures: [string],
  rows: [candidate] }
```

- Queries are `LINKEDIN_QUERIES` verbatim (a test fails on drift); location
  `Budapest`, radius 25 miles, `country_indeed='hungary'`, `hours_old` **72**,
  `results_wanted` 100 per query (a query returning 100 is listed as truncated).
  72 h, not LinkedIn's 26: Indeed's keyword index lags its date filter. On
  2026-11-24 `devops` and `architect` returned 0 rows at 26 h while a broader
  query returned a same-day "DevOps Engineer" ad and `devops` without a window
  returned 59. The overlap is free: ids de-duplicate in the run and the store
  upserts.
- Row: `id` `in-<Indeed job key>` (the `jk` of JobSpy's `job_url`, which is also
  JobSpy's `id`; `[A-Za-z0-9]+`), `source` `'Indeed'`, `url`
  `https://hu.indeed.com/viewjob?jk=<key>` (no tracking parameters), `postedAt`
  `YYYY-MM-DD`, `location` `"<city>, <admin1 code>, Hungary"`.
- `salary` only when the currency is HUF, converted to HUF/month. JobSpy falls
  back to Indeed's own salary estimate and cannot say so in its output, so the
  collector removes the estimate first: a salary present is the employer's,
  `visible: true`. `type` is `'b2b'` when Indeed's job type includes contract.
- Any exception, block (JobSpy records it instead of raising), unavailable JobSpy
  or zero rows: `state: 'undetermined'` with a short `reason`, rows collected so
  far kept, exit 0. Degraded collection (warning), never a failed run.

Filter (`scripts/filter-indeed.mjs`, step 4; the runner calls the export):

```js
filterIndeed(rows, ledgerReason)   // ledgerReason = ledgerLookup(readLedger(…)): id → reason | null
  → { kept: [candidate], dropped: {language, title, company, location, ledger, veto},
      droppedRows: [{id, source: 'Indeed', role, company, url, location, reason}],
      titled, located, malformed }
```

Order per row: ledger (`ledger:<reason>`), then `judgeLinkedIn` (Indeed's
location has LinkedIn's city-first, country-last shape; reasons
`language:|company:|title:|location:`), then `veto:indeed-offtopic` when the
title hits neither `CORE_ANCHOR` nor `INDEED_ROLE_FAMILY` (the query families
plus IT-qualified analyst/consultant and a literal "IT"; an empty title is never
vetoed). Indeed's OR matching is loose: the first live run returned Kitchen
Helper and Host/Hostess for `(site reliability OR sre)`. Vetoes are
re-evaluated every run and never ledgered; ids failing `in-[A-Za-z0-9]+` are
counted in `malformed` and skipped. The CLI (`node scripts/filter-indeed.mjs
[in] [-o out]`) writes `.cache/indeed-filtered.json`: `{collectedAt, filteredAt,
state, reason?, truncatedQueries, queryFailures, rows: kept, dropped,
droppedRows, titled, located}`, carrying the collector's state through.

### Materialised `jobs.json`

Indeed rows carry `source: 'Indeed'`, `status: 'Indeed'`. A repost of an
owner-ignored ad carries `repostOf: '<twin id>'` (the D1 column is `repost_of`;
the store maps the two names). `null` and absent are equivalent; when set it must
be another job's id, never the row's own, and `repost_of` itself is rejected in
`jobs.json`. Rendered as an "újrafeladás" tag on the dashboard
and a "↻ újrafeladás" marker in the Telegram digest.

## Runner (`scripts/v2/run.mjs`)

Azure entry: `cloud-run.mjs refresh` with `JOBS_DATA_PLANE=d1` fetches the two
employee-cv files (CV deploy key) into `JOBS_EMPLOYEE_CV_ROOT`, then runs
`scripts/v2/run.mjs` with an allowlisted env (D1/KV, Telegram, collector switches,
the judge's Claude settings; never the deploy keys, v1 tracker credentials or Blob
configuration) and exits with its code. No Blob lease, no clone of this repo, no
`verifyCode`. Without `JOBS_DATA_PLANE=d1` the v1 refresh is unchanged.

Snapshot field names stay camelCase: column `repost_of` is `repostOf` in
`jobs.json` (omitted when null, like `closed`).

Order: one consistent read per database (a read-only `batch` is one
transaction; no paging); fail unless the tracker's `meta.tracker_imported`
exists and `jobs` is non-empty; **re-put the last committed snapshot to KV**
(every run, so a commit whose KV put failed heals on the next invocation); a
`runs` row for this slot (the latest 13:00 UTC) means `already_completed`, exit
0. Collectors are the v1 scripts on a temp copy with a materialised
`public/data/jobs.json` and `.cache/rejected-ids.json` and no secrets; Indeed is
`fetch-indeed.py` → `filter-indeed.mjs`. Then prefetch (`prefetchAll`) and judge
NEW candidates only, merge, guards, validate, commit, KV, notify.

Ledger for new candidates: exact id first, then the NFJ slug-variant fallback,
except that a variant of an id the owner **ignored** is a repost (shown,
`repostOf` = that id) — so the collectors' ledger omits owner-ignored NFJ ids.
Existing rows use exact verdicts only (a slug sibling's verdict never freezes
`lastSeen`). A `fit:` verdict is ledgered only with a `judgeVersion`; without
one the candidate stays unjudged. A kept candidate whose portal omitted the
company is stored with `company: 'Ismeretlen cég'`.

Commit: one `batch`, `runs` INSERT **first**, so a second commit for the slot
rolls back whole. If the batch errors and the slot's `runs` row exists: with our
`payload_sha256` (slot + loaded state + candidates + judge output + liveness) it
was our own batch whose response was lost — publish and notify once, exit as
usual; with another hash, another run owns the slot — publish its result, no
notification, exit 0. KV order: `last-run.json`, then `jobs.json`.

Guards (exit 70, nothing written): the run may remove — and liveness may mark
dead — at most `max(5, 20% of probed rows)`, probed = rows with `lastSeen` within
20 days (what `check-liveness.mjs` probes); validate.mjs runs on the
materialised snapshot and note. E-mail candidates are consumed once decided
(ledgered, gone, vetoed, or judged) or after 7 days.

| Exit | Meaning |
| --- | --- |
| 0 | committed and published, or `already_completed` |
| 8 | committed and published, but a collector, liveness, prefetch or the judge was incomplete (warnings in the note) |
| 70 | failed; nothing committed (or the commit landed and the KV put failed: the next invocation heals) |

Env: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `JOBS_D1_ID`,
`TRACKER_D1_ID`, `SNAPSHOT_KV_ID`; `JOBS_EMPLOYEE_CV_ROOT` (default
`/data/employee-cv`); `JOBS_REFRESH_LINKEDIN_ENABLED` (default `true`);
`JOBS_INDEED_PYTHON` (default `/opt/indeed/bin/python`, else `python3`);
`JOBS_REFRESH_NOTIFY_ENABLED=true` + `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
to notify; the judge's variables (see "Judge contract").

Import (`scripts/v2/import.mjs`): `(--state FILE | --jobs FILE)
(--ledger FILE | --no-ledger) (--streaks FILE | --no-streaks)
(--tracker FILE | --no-tracker) [--dry-run]` (`--state` supplies the files it
holds). jobs-data (jobs + verdicts + streaks) is one atomic batch into empty
tables; any existing row refuses the whole import before a write. The tracker
part is skipped when `meta.tracker_imported` exists; otherwise tracker rows plus
the marker are one batch, run before the jobs batch — so a failed import is
simply re-run.

Export (`scripts/v2/export-json.mjs <out-dir>`, v1 rollback): `jobs.json`,
`last-run.json` (v1 `public/data/`), `rejected-ids.json`,
`unseen-streaks.json` (v1 `.cache/`), from one consistent read.

Backup: `cloud-run.mjs backup` with `JOBS_DATA_PLANE=d1` uploads
`{ schema: 2, exportedAt, databases: { 'jobs-data': {table: rows}, 'jobs-tracker': {tracker, meta} } }`
to the same backup container, write-once and checksum-verified (`scripts/v2/backup.mjs`).

## Cutover (owner approval required)

1. Import: v1 Blob state export + `jobs.json` + KV tracker → D1 (`scripts/v2/import.mjs`);
   the tracker import writes `meta.tracker_imported` last.
2. Worker with `DATA_SOURCE=static`, `ACCESS_ENFORCE=log` deployed and verified.
   Azure inputs (`AZURE_TERRAFORM_VARS_JSON`, operator apply): `secret_names`
   gains `CLOUDFLARE_API_TOKEN = jobs-cloudflare-api-token` (refresh and backup
   jobs); `app_env` gains `CLOUDFLARE_ACCOUNT_ID`, `JOBS_D1_ID`, `TRACKER_D1_ID`,
   `SNAPSHOT_KV_ID` and, at the switch, `JOBS_DATA_PLANE = d1` (both jobs: the
   refresh runs v2, the backup exports D1).
3. **Owner approves the switch** (approved 2026-11-24, done the same night):
   `JOBS_DATA_PLANE=d1` on both jobs (the 13:00 schedule now runs v2; there is
   no separate v1 schedule), import into D1, `DATA_SOURCE=d1` and
   `ACCESS_ENFORCE=enforce`. Until the first v2 run writes the snapshot, the
   Worker serves the static files.
4. After a week of good runs: delete `public/data`, `cloud-state.mjs`, the
   publish half of `cloud-run.mjs`, `publish.sh`, `notify-telegram.sh`, the deploy
   key and the Azure state container. The owner brought this forward to
   2026-11-25: the v1 runner, its scripts and the deploy key went first (jobs-dashboard #70);
   `public/data` and the Worker's static fallback followed once the first v2
   run had written the KV snapshot; the Azure state account was deleted after a
   private archive (jobs-dashboard #72).

Rollback before step 4: `scripts/v2/export-json.mjs` writes `jobs.json` from D1,
re-enable the v1 schedule, set `DATA_SOURCE=static`.
