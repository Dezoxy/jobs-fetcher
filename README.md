# jobs-fetcher

The code behind a private job-search dashboard at `jobs.toomhorvath.com`: the refresh engine that collects and judges job ads, the Cloudflare Worker that serves them, and the Terraform and workflows that deploy both. The product and its cloud resources keep the name `jobs-dashboard`.

This repository is public and holds code only. Job data lives in D1/KV, secrets in Azure Key Vault, and the owner's facts in the private `employee-cv` repository (`profile/judge-profile.md`, read at run time). **Nothing from `employee-cv/private/` or `employee-cv/profile/` belongs here.** It replaces the private `jobs-dashboard` repository, which stays as the archive ([ADR 9](docs/architecture/decisions/0009-public-jobs-fetcher-repository.md)).

## Architecture

Architecture model, views, ADRs and threat model: [docs/architecture/](docs/architecture/README.md).

The refresh pipeline runs in Azure Container Apps Jobs in West Europe at
**0.5 vCPU / 1 GiB**, using the same Claude subscription, Opus 5.5 and xhigh effort.
An optional [Claude API fallback](docs/azure-migration.md#claude-api-fallback)
uses workload identity federation and prepaid API credits after a failed merge.
It is disabled until all five federation identifiers are configured.
The [cutover record](docs/azure-cutover-2026-10-09.md) captures live verification;
the [migration plan](docs/azure-migration-plan.md) records cost and sizing, and the
[operator runbook](docs/azure-migration.md) covers release and recovery.

```text
Azure Container Apps Job: jobs-refresh (daily at 13:00 UTC)
  fetch three employee-cv inputs (read-only deploy key)
  scripts/v2/run.mjs: load state from D1 jobs-data
    Profession + NFJ + LinkedIn + Indeed collection, LinkedIn alert-email candidates
    liveness checks → prefetch ad text → Claude judge (JSON schema, no tools) → merge → validate
    commit to D1 (one runs row per 13:00 slot) → put the snapshot into KV → Telegram diff
                         │
                         ▼
               Worker: /data/* from SNAPSHOT KV, /api/tracker on D1 jobs-tracker,
                       email() → LinkedIn alert candidates
                         ▼
               Cloudflare Access → jobs.toomhorvath.com

jobs-backup (04:15 UTC) → both D1 databases → separate Azure backup account
```

GitHub holds code only: merging releases an image, and Renovate's pin deploys it
([ADR 8](docs/architecture/decisions/0008-release-by-tag-deploy-by-renovate-pin.md)).
The v1 pipeline (Blob state, git-published `public/data`, the homelab timer) was
retired on 2026-11-25. LinkedIn has used sessionless HTTP collection since
2026-08-29. Nothing runs on the MacBook.

The Worker serves files plus a deliberately small server side (`src/worker.js`, v2 per [docs/architecture-v2.md](docs/architecture-v2.md)): `GET /data/jobs.json` and `/data/last-run.json` from the `SNAPSHOT` KV, `GET/PUT /api/tracker` on the D1 `jobs-tracker` database, and an `email()` handler that turns LinkedIn alert e-mails into candidate ids. Access decides who gets in; the Worker re-checks the Access JWT itself (see [Access control](#access-control)). Keep the surface this small.

## Ownership boundary — read this before touching Terraform

Deployment is driven by **Cloudflare Workers Builds** watching `main` in this repo.

| Owned by Workers Builds (this repo) | Owned by Terraform (the cloudflare repo) |
| --- | --- |
| the `jobs-dashboard` Worker script and its assets | DNS record for `jobs.toomhorvath.com` |
| the `TRACKER` KV namespace binding (namespace `51cd47b0…`, created by hand with wrangler 2026-08-07; v1, kept read-only until cutover + 30 days), the `SNAPSHOT` KV and the `JOBS_DB`/`TRACKER_DB` D1 bindings, the vars and the two Worker secrets | the Worker custom-domain binding |
| | the Access application and its policy (including the service-token policy for the refresh pipeline) |

Terraform must **not** declare a `cloudflare_workers_script` for `jobs-dashboard`. If it did, every `terraform apply` would overwrite whatever Workers Builds last deployed, and the two systems would fight over the same resource. A custom-domain resource that *references* the script by name is fine — that only binds a route, it does not manage the script body.

## Access control

The list reveals where the user is applying while employed. It must never be publicly reachable.

Cloudflare Access sits in front of the hostname, managed in the Terraform repo. It is the primary control: the static UI (`/`, `app.js`, …) is served by the assets layer without running the Worker, so for those files Access is the *only* control.

Since v2 the Worker adds a second lock for everything it serves (`run_worker_first: ["/data/*", "/api/*"]`, which covers the job list, the run note and the tracker). On every such request `src/access.js`:

1. verifies the `Cf-Access-Jwt-Assertion` header: RS256 signature against `https://<ACCESS_TEAM>/cdn-cgi/access/certs` (cached per isolate for 1 h; an unknown `kid` refetches, at most every 30 s; a failed refresh keeps the previous keys), `iss` = `https://<ACCESS_TEAM>`, `aud` contains `ACCESS_AUD`, `exp`/`nbf` with 60 s skew;
2. allowlists the identity: the browser needs an `email` listed in the `OWNER_EMAILS` secret (compared ASCII-only: `A-Z` lower-cased, any non-ASCII address never matches); the refresh runner (Access service token) needs `common_name` equal to the `RUNNER_CLIENT_ID` secret and may only `GET /data/*` and `GET /api/tracker`;
3. on failure logs one JSON line (`{"event":"access_denied","mode",…,"reason","principal","method","path"}`: never the token or the e-mail) and then either continues (`ACCESS_ENFORCE=log`, the first-deploy setting) or returns 403 (`enforce`; any value other than exactly `log` enforces).

`PUT /api/tracker` additionally requires `Content-Type: application/json`, at most 512 KB of body in bytes (checked on `Content-Length` before reading, then while reading) and, when the browser sends an `Origin`, exactly `https://jobs.toomhorvath.com`. Consequence: `wrangler dev` on localhost cannot PUT.

Plain vars in `wrangler.jsonc`: `ACCESS_TEAM`, `ACCESS_AUD`, `ACCESS_ENFORCE` (`log` | `enforce`). Secrets, set once and never committed:

```bash
npx wrangler secret put OWNER_EMAILS      # comma-separated owner address(es)
npx wrangler secret put RUNNER_CLIENT_ID  # the runner's service-token Client ID, e.g. "<id>.access"
```

With either secret unset, nobody matches that allowlist: harmless in `log` mode, a lockout in `enforce` mode. Check the `access_denied` lines in Workers Logs after a `log` deploy before switching to `enforce`.

The refresh pipeline reads the same endpoints with an Access **service token** (`CF-Access-Client-Id`/`-Secret` headers): the token is created in Zero Trust and the Access application needs a Service Auth policy admitting it — both live on the Terraform side of the boundary.

Access protects only the custom hostname. `wrangler.jsonc` sets `workers_dev: false` and `preview_urls: false` because the default `*.workers.dev` and preview URLs reach the Worker without Access; until 2026-11-24 they served the job list and the tracker publicly. Never re-enable them.

`_headers` adds defence in depth: a strict CSP with no external origins, `noindex`, `frame-ancestors 'none'`, and `no-referrer`.

## Telegram notification

> **Historical (v1, retired 2026-11-25).** This section describes the v1 pipeline: `refresh-run.sh`, `publish.sh`, `notify-telegram.sh` and git-published `public/data`. That code is gone from `main`. The refresh now runs `scripts/v2/run.mjs` on D1; see [architecture v2](docs/architecture-v2.md) and the [architecture docs](docs/architecture/README.md).

The digest diffs `jobs.json` against the previous commit and sends a Telegram message — **but only when something actually changed**. A refresh that only bumps `lastSeen` dates sends nothing. `scripts/notify-diff.mjs` builds the message and is shared by the cloud and retained VM senders; only the transport differs.

There are two retained sender paths, and **exactly one may be live at a time** — both means every refresh notifies twice:

| Sender | Trigger | Status |
| --- | --- | --- |
| `scripts/cloud-run.mjs` in Azure | confirmed publication with relevant changes | **live** — durable delivery checkpoint before Telegram |
| `scripts/notify-telegram.sh`, retained on the VM | `publish.sh` created a commit | paused — VM timer disabled; recovery copy retained |

The message contains:

- new jobs, priority ones first (⭐ = DevOps, Architecture, Security or AI category, or a ceiling at 2.0M+), each with company, category, salary and a link
- jobs whose status flipped to `Mentett` since the last run
- jobs that crossed the 14-day archive threshold
- a one-line count of dead ads the run cleaned up on purpose (`cleanedDeadIds`), and a loud, itemised warning for any row that vanished *without* being on that list
- the refresh task's own written assessment, from `last-run.json`
- any warnings the task recorded

Two design points worth knowing:

**The narrative is not generated in CI.** The refresh task already forms a judgement about what it found; it writes that to `last-run.json`, which `publish.sh` commits alongside `jobs.json`. The sender just relays it. That avoids paying for a second LLM call and avoids two systems forming different opinions about the same data.

**Everything from the data is HTML-escaped** before it reaches Telegram. Job titles and company names come from scraped web pages — untrusted input by definition. The validator additionally rejects a `summary` containing `<`.

### Why a direct sender exists

The former GitHub workflow put a metered, externally-owned dependency in front of a message the VM already held every input for. On 2026-08-19 and 2026-08-20 five digests were lost outright: the jobs were refused before a runner ever picked them up — *"recent account payments have failed or your spending limit needs to be increased"*. The data published normally each time, so nothing downstream noticed; the dashboard was current and the notification simply never arrived. Sending from the VM removes GitHub from the path entirely.

The trade-off is the Actions run log, which was a free audit trail. `scripts/notify-telegram.sh` logs the full Telegram API response instead, so the VM's run journal becomes the record.

A digest that fails to send from the VM exits `9` — the run itself succeeded and the data is live, but `systemd`'s `OnFailure=` is the container's only alerting channel, and a silently-lost digest is the exact failure this path exists to prevent. Same shape as the exit `8` browser-degradation alert.

### Credentials and recovery

Telegram credentials are held in Azure Key Vault `kv-toom-jobs-weu` as
`jobs-telegram-bot-token` and `jobs-telegram-chat-id`. The scheduled refresh job
resolves them through its managed identity. The old manually dispatched GitHub
notification workflow and its duplicate repository secrets were removed after
Azure became the active sender. GitHub Actions needs no saved Telegram token.

The retained VM recovery configuration reads its credentials from the homelab
Key Vault. Resuming it requires pausing Azure schedules, draining active runs,
transferring the newest cloud state and reconciling durable delivery before
enabling the VM sender. Its retained cache is stale after cutover. Follow the
[Azure recovery runbook](docs/azure-migration.md); keep one publisher and sender
active at a time.

### Privacy note

The message names the companies you are looking at. Telegram cloud chats are not end-to-end encrypted, so this content sits on Telegram's servers — a weaker boundary than the Cloudflare Access protected dashboard. That is an accepted trade-off for push convenience; if it stops being acceptable, the sender can post to a self-hosted endpoint instead.

## Data model

`/data/jobs.json`, served by the Worker from the `SNAPSHOT` KV namespace that each v2 run writes (no longer in git since 2026-11-25; an anonymized copy (same structure, synthetic titles, companies, ids and text) is the test fixture `tests/fixtures/jobs-2026-11-25.json`):

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-28T12:08:15.037Z",
  "jobs": [
    {
      "id": "li-4441024544",        // li-<n> | pr-<n> | nfj-<slug> | in-<Indeed job key>, stable across refreshes
      "role": "Lead AI Engineer",
      "company": "Mastercard",
      "source": "LinkedIn",          // LinkedIn | Profession | NoFluff | Indeed (v2)
      "category": "Artificial Intelligence",
      "type": "Employee",            // Employee (gross) | Contract (net, B2B)
      "description": "…",
      "salaryLo": 1900000,
      "salaryHi": 2600000,
      "salaryPosted": false,         // true only when the ad states the figure
      "benchmark": "AI Senior + lead prémium",
      "url": "https://…",
      "status": "Mentett",           // Mentett | Értesítő | NFJ keresés | Indeed (v2)
      "firstSeen": "2026-07-27",
      "lastSeen": "2026-07-28"
      // optional: "closed": "YYYY-MM-DD"; "repostOf": "<id>" (v2, a repost of an ad you ignored, shown flagged)
    }
  ]
}
```

`lastSeen` drives archiving: a job not seen in any source for more than 14 days is shown as archived and hidden by default. `firstSeen` drives the "ÚJ" badge (7 days).

`/data/last-run.json` carries the refresh task's own note:

```jsonc
{
  "ranAt": "2026-07-28T16:30:00+02:00",
  "summary": "plain Hungarian text, max ~1200 chars — no HTML, no Markdown",
  "warnings": ["optional, one string per problem"],
  "cleanedDeadIds": ["pr-2936905", "…ids the run deleted on purpose, or omit"]
}
```

`cleanedDeadIds` exists so the notifier can tell a deliberate deletion from data loss. The task deletes confirmed-dead `Értesítő`/`NFJ keresés` rows (see `scripts/check-liveness.mjs`); everything else is supposed to stay put and age into the archive. The diff subtracts these ids from the rows that vanished and reports the rest as unexpected — so the "eltűnt a fájlból" warning only fires when something genuinely went missing.

It is committed together with `jobs.json` so the narrative always matches the numbers it describes. Both files are validated by `npm run check`.

Salary figures with `salaryPosted: false` are estimates from the NFJ Fizetési Iránytű 2026 H1 bands with an employer-type adjustment. They are a screening aid, not a negotiating position.

### Client-side state (localStorage)

The UI keeps two pieces of state in the browser only — they never touch the repo or the pipeline:

- `jobs:lastVisit` — ISO timestamp of the previous visit; drives the "friss" (new since your last visit) highlight. Day-granular comparison, inclusive of the visit day, because `firstSeen` has no time component; the refresh runs daily.
- `jobs:tracker` — `{ [jobId]: { st, at } }` with `st` ∈ `saved | applied | interview | offer | rejected | ignored`; drives the "Saját státusz" column, the applied/ignored filters and the row tints. `saved` was added 2026-08-07 when the three portal saved-jobs lists were retired: it is the only neutral-positive status (everything else is application progress or a rejection), and it is where bookmarking a job for later now happens instead of on the portals. The one-off `scripts/mentett-to-tracker.mjs` (removed 2026-11-25; see git history) exported the legacy `Mentett` rows into this format, but importing it was **optional** — those rows keep `status: "Mentett"` in `jobs.json` (git-backed and permanent), and `survivesArchiveHide` in `public/app.js` treats that status as a marker in its own right, so they stay visible with no action. The import only changes what the "Saját státusz" dropdown shows for them.

**Since 2026-08-07 the tracker syncs across devices** via `GET/PUT /api/tracker` (`src/worker.js`; one KV blob in v1, the D1 `jobs-tracker` table since v2 with the same JSON contract, behind the same Access policy as the site plus the Worker's JWT check): the page pulls and merges on load (per id, newer `at` wins; new writes stamp full ISO timestamps, legacy entries carry day-only dates and compare correctly), pushes debounced on every change, and shows a small ☁ indicator in the header (moved there 2026-08-08 so it's visible on mobile without scrolling; was in the footer before). localStorage is thereby demoted to an offline cache, so Safari's 7-day ITP eviction stops being data loss. The `jobs:lastSync` key records when this browser last merged with the server — it is what distinguishes "edited locally while offline" from "deleted on another device". Filter state is not stored; it lives in the URL hash (never sent to the server, so search terms stay out of Cloudflare logs) — including the `inbox` key added 2026-08-08 for the "Feldolgozandó" triage-mode toggle (rows with no tracker status yet, not archived). Triage mode is the **default** since later that day — only the off state serializes (`inbox=0`), so a bare URL opens the to-do view and "Összes" is the explicit choice.

**Tracker storage (v2).** One row per id in D1 `jobs-tracker` (`migrations/tracker/`, with `CHECK`s mirroring the shape check). `GET` lets SQLite build the `{ [id]: {st, at} }` document (`json_group_object`), so the Worker never parses it; `PUT` keeps the v1 shape check and 512 KB cap and replaces the table in one atomic batch (`DELETE`, then `INSERT … SELECT … FROM json_each(?1)` with the map as the single parameter). The tracker lives in its own database so restoring job data never rewinds these clicks. Both routes answer **503** until the import has written the `meta` row `tracker_imported` (and on any D1 error): an empty or half-imported table would otherwise read as "deleted on another device" to every browser that has synced before. On the client side, `public/app.js` never PUTs before it has merged with a successful GET in the same page load, so a 503 or an offline GET never shrinks the server copy or the local one. The v1 `TRACKER` KV stays bound and untouched as the recovery copy until cutover + 30 days.

**Desktop keyboard shortcuts** (added 2026-08-08, see the footer hint line): `j`/`k` move a row cursor, `x` sets "Nem érdekel" (with the same undo snackbar as the row's ✕ button), `s` sets "Elmentve", `Enter` opens the cursor row's ad in a new tab. Ignored while a form field has focus.

The footer export/import buttons remain as backup and as the escape hatch if the API is ever down. `scripts/tracker-to-rejected.mjs <export.json>` merges a tracker JSON's `ignored`/`rejected` ids into `.cache/rejected-ids.json`, so a "Nem érdekel" click reaches the fetcher and the fit filter instead of dying in the browser (measured before the fix: 519 negative verdicts, 5 in the ledger). The refresh pipeline now runs this automatically each cycle against the sync endpoint (see `scripts/refresh-run.sh` step 2b — gated on `JOBS_TRACKER_SYNC_URL` + `JOBS_TRACKER_CLIENT_ID`/`_SECRET`, an Access service token); the manual path still works and is idempotent. It also works in reverse (since 2026-09-15): a positive status (`saved`/`applied`/`interview`/`offer`) releases that id's earlier `tracker:` verdict, so un-hiding a job restores its `lastSeen` refresh; `dead:`/`dedupe:`/`fit:` verdicts are never released (see `planRelease` in `scripts/ledger.mjs`). Ledgered rows stop being refreshed and age into the archive on their own — see `docs/refresh-task.md` ("3. Merge") for the pipeline-side rules this relies on.

Lookups go through `ledgerLookup()` (added 2026-08-24), not a bare `id in ledger`: NFJ re-slugs a re-published ad as `<slug>-1`, `<slug>-2`, … so an exact-id ledger leaks a rejected ad back into the feed every time the employer reposts it. Observed on the Citi *Intelligence Senior Analyst* ad, ledgered since July and arriving as a fresh `…-citi-budapest-1` candidate. The fallback strips one trailing `-<n>` and is scoped to `nfj-` ids only — `pr-` and `li-` ids *end* in their numeric key, so the same normalisation would collapse them to `pr-`/`li-` and suppress both corpora wholesale. A fallback hit records `"<reason> (slug variant of <id>)"` in `droppedRows`, so a reused verdict never reads as an exact one.

Two category rules are intentionally duplicated in `public/app.js` and `scripts/notify-diff.mjs` — change both or neither:

- ⭐ priority: category ∈ DevOps/Architecture/Security/AI, or `salaryHi` ≥ 2.0M.
- demoted: category = Business Analyst (83% "Nem érdekel" rate measured 2026-08-07, but the kept 17% was real — so the family sorts last in the UI and is counted but never enumerated in the Telegram digest, instead of being dropped).

## Local development

```bash
npm install
npm run check     # validate jobs.json — run this before every commit
npm run dev       # wrangler dev, serves ./public
```

`npm run check` fails on: invalid JSON, missing fields, duplicate ids or URLs, non-https URLs, inverted or absurd salary ranges, malformed dates. Workers Builds deploys whatever is on `main`, so this is the only gate between a bad refresh and a broken live site.

## Deployment

Push to `main`. Workers Builds does the rest. There is no build step — the assets are served as-is.

Manual fallback if Workers Builds is unavailable: `npx wrangler deploy` with a Cloudflare API token that has Workers Scripts:Edit.

## Git identity

GitHub blocks pushes that would publish a private email address. Commits here must use the account's noreply address:

```bash
git config user.email "176568786+Dezoxy@users.noreply.github.com"
git config user.name "toom"
```

This matches the `employee-cv` convention, so no real address ever reaches a remote.

## Refresh pipeline

> **Historical (v1, retired 2026-11-25).** This section describes the v1 pipeline: `refresh-run.sh`, `publish.sh`, `notify-telegram.sh` and git-published `public/data`. That code is gone from `main`. The refresh now runs `scripts/v2/run.mjs` on D1; see [architecture v2](docs/architecture-v2.md) and the [architecture docs](docs/architecture/README.md).

The Azure `jobs-refresh` job runs once daily at **13:00 UTC** (`0 13 * * *`): 14:00 in Hungary during winter and 15:00 during summer. Terraform owns the schedule in `infra/azure/main.tf`. The former systemd timer on `01-myapps-vm` is retired; see the [cutover record](docs/azure-cutover-2026-10-09.md).

The collection sources are Profession.hu and No Fluff Jobs (`npm run fetch`), plus sessionless LinkedIn guest search (`scripts/fetch-linkedin.mjs`). LinkedIn discovery covers **26 hours**, giving daily runs two hours of overlap; results are deduplicated by job ID. Existing ads are checked separately by the liveness sweep. Query failures and result caps remain visible as degraded collection; the wider window does not guarantee complete LinkedIn coverage or recover a missed day. Indeed Hungary (`scripts/fetch-indeed.py` via JobSpy, filtered by `scripts/filter-indeed.mjs`) is collected by the v2 runner only, not by `refresh-run.sh`; see [architecture v2](docs/architecture-v2.md#indeed-scriptsfetch-indeedpy-jobspy).

The refresh script merges into `public/data/jobs.json`, preserves `firstSeen` and validates. The Azure parent owns durable checkpoints, commits, publication and Telegram delivery; the merge process receives neither publish credentials nor responsibility for those effects. The legacy VM publisher is described below for recovery/reference. The dashboard marks data stale after 26 hours, matching the monitoring grace period. For the daily schedule's freshness threshold, counter transition and operator apply, see [daily refresh configuration](docs/azure-migration.md#daily-refresh-configuration).

`publish.sh` pushes whenever `main` is ahead of `origin/main`, independently of whether it just committed. That matters when a push fails (VM offline, expired key): the commit stays local and goes out on the next scheduled run instead of sitting there forever, since `jobs.json` no longer looks "changed" by then.

Exit codes: `0` success or nothing to do, `1` not a repository, `2` live git lock, `3` push failed (commit stays local, retried next run), `4` preflight write-probe failed — check filesystem permissions/mount, `5` could not take the run lock, `6` `origin/main` has commits we do not have.

### `scripts/refresh-run.sh` and the publish gate

In Azure, `scripts/cloud-run.mjs` prepares verified checkouts and invokes `scripts/refresh-run.sh` with publishing and notifications disabled. The refresh script imports tracker verdicts, fetches machine feeds, collects and filters LinkedIn, runs the liveness sweep, invokes Claude to merge according to `docs/refresh-task.md`, then validates. Failed validation cannot reach publication. The cloud parent owns the subsequent durable publication and notification checkpoints. On the legacy VM path, the refresh script can instead call `scripts/publish.sh` behind its own flags.

Since 2026-08-29 Claude is used only for the merge workflow. The Azure path can retry that workflow through the optional [API fallback](docs/azure-migration.md#claude-api-fallback). The separate Sonnet call driving a Playwright MCP server against a logged-in Chromium, whose only job was the session-bound LinkedIn feed, was retired when that feed stopped needing a session; `scripts/fetch-linkedin.mjs` does the same collection over LinkedIn's guest endpoints. The retired block is kept commented in `scripts/refresh-run.sh` step 4 for one release.

`bypassPermissions` is scoped to what this container actually mounts — the repo, the employee-cv checkout, the Claude config dir, and read-only SSH keys — so the blast radius of skipping prompts is the container itself; `--add-dir` is what makes `/data/employee-cv` (outside the repo working tree) reachable at all. Neither flag belongs on a host that isn't this narrowly sandboxed.

**A `claude` run can exit `0` while doing nothing** — e.g. every write denied — which would otherwise validate the unchanged data, pass, and report success: a run that looks healthy and produced nothing. `public/data/last-run.json` is written unconditionally on every real run (even a no-op one), so the script hashes it before and after the Claude call; an unchanged hash means the merge produced nothing.

**A first no-op is retried, not paged (added 2026-08-22).** Twice in the eleven days to 2026-08-22 the cause was transient — the agent narrating work it still intended to do and then returning anyway — and a hand re-trigger on identical inputs succeeded. So the script restores the data files from git, appends a note to the prompt saying this is a retry and that scratch files from the previous attempt may still be in `.cache/`, and tries again; `JOBS_REFRESH_MERGE_ATTEMPTS` (default 2) bounds it, and `1` restores the old page-on-first-no-op behaviour. Reaching the failure means two consecutive no-ops, which is evidence of something structural rather than a flaky return — that is exit `10`, **not** `6`; see the exit-code table for why the distinction matters.

**Between the fetch and merge steps, an optional browser-collection step (Phase 2b) can run.** When `JOBS_REFRESH_BROWSER_ENABLED` is exactly `true`, the script invokes the Claude CLI a second time (`claude --print … --model "$JOBS_REFRESH_BROWSE_MODEL" --effort "$JOBS_REFRESH_BROWSE_EFFORT" --mcp-config "$JOBS_REFRESH_MCP_CONFIG" --strict-mcp-config --permission-mode bypassPermissions`) against a Playwright MCP server attached to a logged-in Chromium, to collect the one remaining session-bound source (the LinkedIn alerts feed) into `.cache/browser-latest.json` — see `docs/refresh-task.md`'s "Browser collection (Phase 2b)" section for the file's shape. This step never merges, never writes `public/data/`, and never runs git; the existing merge step consumes its output alongside `.cache/sources-latest.json`, the same way it already consumes the machine feeds. It runs on a separate, cheaper model (`JOBS_REFRESH_BROWSE_MODEL`, default `sonnet`) than the merge step's `ANTHROPIC_MODEL` (Opus) — DOM extraction is mechanical, while the fit-filtering/salary/summary judgement stays on Opus in the merge step. Unset or not exactly `true` skips the step entirely and the merge sees only `npm run fetch`'s output. It is set to `true` on the VM; the gate exists so a broken browser stack can be switched off without stopping the machine feeds.

**The two Claude invocations run at different effort levels, deliberately.** `JOBS_REFRESH_BROWSE_EFFORT` (default `high`) governs the browse step, `JOBS_REFRESH_MERGE_EFFORT` (default `xhigh`) governs the merge step. The browse step is mechanical DOM extraction against documented selectors and is already the long pole of the run (12-16 minutes observed); the merge step is where the actual judgement happens (fit filtering, salary estimation, the Hungarian summary) and is the shorter of the two (~4-9 minutes), so it gets the higher effort level. Both fall back to those defaults when the env var is absent, same pattern as `JOBS_REFRESH_BROWSE_MODEL`.

**The browser step checks the LinkedIn session is genuinely authenticated before scraping, and the three possible outcomes are handled differently on purpose.** A stale session doesn't error when scraped — it returns an empty result list, indistinguishable from "the alert feed is quiet today" — so a whole discovery cycle would silently report zero new jobs with nothing in `warnings` saying why. The check exists to catch that loudly. (Before the saved-jobs lists were retired the stakes were worse still: unbumped `lastSeen` on already-curated rows, archived 14 days later.) The result lands in `.cache/browser-latest.json`'s `auth` object as one of three states:

- **`logged_out`** — positive evidence of a signed-out session (a login redirect, or a visible sign-in prompt). There is a human action here (sign back in), and nothing useful will come from that portal until they do, so this **blocks the run outright**: `refresh-run.sh` aborts immediately, before the merge ever runs (exit `7`), the same all-or-nothing failure semantics the script already applies to every earlier collection step (`npm run fetch` failing already blocks the merge too, for the same reason). The abort message names the portal and its reason. **Unreachable since 2026-08-29**: `scripts/fetch-linkedin.mjs` has no session to lose, so it never emits this state, and the `chrome.toomhorvath.com` browser this used to point at was retired with the browse step.
- **`undetermined`** — the check was inconclusive because the page itself didn't render (empty body, near-empty accessibility snapshot, a burst of console errors). This is evidence the check couldn't complete, not evidence of a bad session, and there is no human action to take — so it does **not** block. A first live run collapsed this into `logged_out` by mistake (a broken No Fluff Jobs render, not a bad session) and discarded 387 good rows already collected from the other two portals; that is exactly what this state prevents. Now that LinkedIn is the only portal, this state means no browser rows at all — but it still must not block, because the sessionless machine feeds (280 of 768 rows, 36% of the corpus on 2026-08-24) are unaffected and worth publishing.
- **`unreported`** — the portal is missing from the auth object, or carries a value that isn't one of the two above. Also no human action, so it does not block either — but it signals a bug in the browse step itself, not a flaky portal, and is reported with that distinction rather than being folded into `undetermined`.

**Separately from the auth tri-state, the script counts what was actually collected (added 2026-08-07).** A paging or DOM regression is invisible to the auth check — the session is fine, the page renders, but only the first results page (or none) gets scraped; the 2026-07-29 LinkedIn DOM change would have looked exactly like this. So fewer than `JOBS_REFRESH_BROWSE_MIN_ROWS` collected rows (default **15** since 2026-08-31) is treated like `undetermined`: no block, publish proceeds, exit `8` raises the alert after. The threshold and its purpose were both re-derived when collection moved to a 24-hour window: LinkedIn publishes 16–47 matching ads a day, so a healthy run brings 40–70 on a weekday and can dip toward 25 on a weekend, while six queries returning page 1 only would still yield ~45 — above anything a quiet weekend permits. Volume can no longer tell those apart, so this is now a **collapse** check (endpoint moved, egress blocked, all but one query failing) and paging regression is detected exactly, in `scripts/fetch-linkedin.mjs`, from the response shape. The window halved to 12 hours on 2026-09-11 after architect queries capped at 24h. Daily refresh restores a 26-hour window with overlap; 15 remains a conservative collapse threshold, while caps and partial HTTP failures raise degraded collection independently of the row count. This check replaced the unseen-streak warning for LinkedIn rows, which the 7-day feed window had reduced to a permanent 138-row false alarm — see `docs/refresh-task.md`'s "3. Merge".

**A non-blocking portal (`undetermined`/`unreported`) still needs to reach a human, without discarding a good run to do it.** `systemd`'s `OnFailure=` only fires on a non-zero exit, and `last-run.json`'s `warnings` only reach the owner through the Telegram digest, which is gated on `jobs.json` actually changing (that gate is the same whichever sender is live — see "Telegram notification") — so silently continuing with exit `0` could mean a quiet cycle plus a broken portal goes completely unnoticed. So the run continues through merge (which records the affected portal and its reason in this run's `warnings`), `npm run check`, and the gated publish exactly as normal — and only *after* publish has completed (or been intentionally skipped) does the script exit non-zero (exit `8`) purely to trigger the alert. The exit message is explicit that the run succeeded and the data is good; the non-zero status exists only to get a human's attention, not to report a failure. A publish failure is unaffected by this and still surfaces as its own earlier, distinct error, since `scripts/publish.sh` runs as a plain unguarded command under `set -e` — this step is only ever reached once publish has actually finished.

**Exit codes — and the collision that shaped them.** `scripts/publish.sh` runs as an unguarded child of `refresh-run.sh` under `set -e`, so *its* exit codes surface as this service's exit code and shadow this script's one for one. `myapps-notify` keys its advisories on the unit's exit status, so an overlap is not cosmetic: the no-op-merge guard originally held `6`, the notifier's `6` was later written against `publish.sh`'s "`origin/main` diverged", and the 2026-08-22 19:00 no-op run paged as an ACTION REQUIRED divergence that did not exist. The guard moved to `10` on 2026-08-22 — codes `10` and above are this script's alone and cannot collide.

The same reasoning applied a second time on 2026-08-25. Exit `8` had come to mean two opposite things: a `filter-browser` failure that **blocks** the run before the merge, and a post-publish alert on a run that **succeeded**. The notifier could not tell them apart, so a cycle that published nothing would be reported as one that published fine. The blocking case is now exit `11`.

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | a precondition failed — not a repo, `npm` missing, `employee-cv` not checked out |
| `2` | dependency install failed |
| `3` | `npm run fetch` failed — nothing was collected, and there is no HTTP fallback for the machine feeds |
| `4` | the Claude CLI merge run failed (non-zero exit) |
| `5` | `npm run check` failed after the merge — `jobs.json` and `last-run.json` were restored from git |
| `6` | **not used by this script** — left clear because `publish.sh`'s `6` (`origin/main` has commits we do not have) propagates through it |
| `7` | the LinkedIn collection failed and **blocked the run before the merge** — every guest-search query errored (endpoint moved, or this egress is blocked), `scripts/fetch-linkedin.mjs` exited `0` without (re)writing `.cache/browser-latest.json`, or that file was unreadable. The `logged_out` case that used to live here is gone with the browser: since 2026-08-29 there is no session to expire |
| `8` | the run **succeeded** and the data is live, but the LinkedIn collection was degraded and needs a human to look — the source came back `undetermined`/`unreported`, it collected fewer than `JOBS_REFRESH_BROWSE_MIN_ROWS` rows (default 15, retained as a conservative collapse check for daily collection), rows arrived with no `title`, a query failed partially, or a query hit the guest endpoint's 100-result ceiling and dropped ads inside the search window. Raised after publish, never before |
| `9` | the run **succeeded** and the data is live, but the Telegram digest was not delivered |
| `10` | Claude exited `0` but never rewrote `last-run.json`, on every attempt (`JOBS_REFRESH_MERGE_ATTEMPTS`, default 2) — treated as a failed, silent no-op rather than a successful one |
| `11` | `npm run filter-browser` failed and **blocked the run before the merge** — merging unfiltered rows would re-admit ledgered ads and bump their `lastSeen` so they never archive. Nothing was published (added 2026-08-25; was `8`) |

**The split that matters for alerting:** `8` and `9` are alerts on a run that *succeeded* — the merge, validation and publish all completed, the data is live, and the exit message says so explicitly. Every other non-zero code is a genuine failure that published nothing. Since 2026-08-25 no code straddles that line, so a notifier can key on the exit status alone to decide whether the dashboard is current.

**Running and publishing are separate steps, gated independently.** `refresh-run.sh` only calls `scripts/publish.sh` when the environment variable `JOBS_REFRESH_PUBLISH` is exactly `true`; anything else — unset, empty, `false`, a typo — is treated as "do not publish" (fail safe), logs that plainly, and exits 0 leaving the refreshed files uncommitted in the working tree. That makes it possible to run a refresh and inspect the diff by hand before anything reaches git, without touching the publish path at all.

### History

This used to run on a MacBook, split into two components across a trust boundary, because of two macOS-specific limits that don't exist on Linux:

- Connected folders were mounted into the Cowork sandbox with **unlink denied** (create and rename worked, delete did not), so the refresh agent — which parses attacker-controllable LinkedIn/No Fluff Jobs pages — could only write `jobs.json` and was never allowed to run git itself.
- A separate `launchd` agent (`com.toomhorvath.jobs-dashboard-publish`) held the only git credential and watched `jobs.json` for changes to publish it, because `~/Documents` is TCC-protected and a LaunchAgent has no UI session to clear that prompt — hence the repo lived in `~/Projects` instead.

Neither limit applies inside a Linux container, so the split no longer earns its complexity: on the VM, one script fetches, collects, merges, validates, commits and pushes in one run. The browser-bound source was the last thing still tied to the Mac, and it moved on 2026-07-30 as well — the logged-in Chromium runs on the VM now, and the browse step reaches it over CDP through a Playwright MCP server. Nothing here is split across two machines any more.

### Troubleshooting

Run `scripts/publish.sh` by hand to reproduce a failure; each step logs to stdout with a timestamp.

Push fails with `Host key verification failed` or an auth error: there is no terminal to answer a prompt, so `publish.sh` sets `GIT_TERMINAL_PROMPT=0` to fail fast instead of hanging. Make sure `github.com` is in the container's `~/.ssh/known_hosts` and the deploy key loads without a passphrase prompt.
