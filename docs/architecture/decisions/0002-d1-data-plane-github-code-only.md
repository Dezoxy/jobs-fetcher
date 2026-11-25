# 2. D1 is the data plane and GitHub is code only

Date: 2026-11-24

## Status

Accepted

Amends [1. Run the refresh as an Azure Container Apps Job](0001-run-refresh-as-azure-container-apps-job.md)

Decided by the owner on 2026-11-24 and switched on the same night (cutover
step 3 in [architecture v2](../../architecture-v2.md#cutover-owner-approval-required)).
Step 4, deleting `public/data`, the v1 Blob state machine, the publish half of
`cloud-run.mjs` and the repository deploy key, was brought forward by the owner
to 2026-11-25 (see the cutover list for the order).

## Context

v1 kept the job list in git (`public/data/jobs.json`, about 1.4 MB), the run
state in an Azure Blob lease and bundle state machine, and published by pushing
a commit that Cloudflare Workers Builds deployed. A Claude agent with shell
access edited the file. That produced "remote history diverged" stalls,
"merge is deploy" breakage, silent no-op merges, a prompt-injection surface and
manual backfills ([architecture v2, Why](../../architecture-v2.md#why)).

## Decision drivers

- One store of record, written atomically once per run.
- A rerun of the same slot must not commit twice.
- No data commits in the code repository, so a code merge and a data refresh
  cannot interfere.
- EU data residency for the job data and the tracker.
- No new paid service.

## Considered options

1. Keep v1: job list in git, run state in Azure Blob.
2. Cloudflare D1 for all job data, a KV snapshot for the Worker to serve.

No other store is recorded as considered.

## Decision

Option 2. D1 `jobs-data` (EU jurisdiction, Free plan) holds jobs, the verdict
ledger, unseen streaks, one `runs` row per 13:00 UTC slot and e-mail
candidates ([schema](../../architecture-v2.md#d1-jobs-data-schema-migrationsjobs0001_initsql)).
The runner reads and writes it through the Cloudflare REST API. Every run's
writes are one D1 `batch` whose first statement inserts the `runs` row, so a
second commit for the slot rolls back whole.

The runner then puts `last-run.json` and `jobs.json` into the `SNAPSHOT` KV
namespace, and the Worker streams them unparsed: Free-plan
Workers get 10 ms of CPU per request, too little to build a 1.5 MB list from
D1. Each run starts by re-putting the last committed snapshot, so a commit
whose KV write failed heals on the next run. A missing KV key is a 503 and a
`snapshot_missing` log line; the static fallback went with `public/data` in
cutover step 4.

The backup job exports both D1 databases nightly to the Azure backup account.
Until step 4, `scripts/v2/export-json.mjs` can write the v1 files from D1 for a
rollback.

## Consequences

Positive:

- A code merge no longer deploys data, and a refresh no longer needs to push
  to GitHub. After step 4 the runtime holds no write key for this repository.
- Idempotency per slot is a primary key, not a lease.
- The merge became deterministic code ([ADR 4](0004-tool-less-json-schema-judge.md)).

Negative / accepted trade-offs:

- The runner and the backup job share one Cloudflare API token with D1 Edit and
  Workers KV Storage Edit for the whole account, not for these two databases
  only (see the [threat model](../security/threat-model.md)).
- The Free plan keeps 7 days of D1 Time Travel. Older recovery depends on the
  nightly export, which has a 30-day retention.
- Workers KV has no jurisdiction setting, so the snapshot of the job list is
  not held to the EU the way D1 is.
- The history of the list is no longer a git log. The `runs` table keeps each
  run's note and a diff of added and removed ids.

## Risks

- No restore from the nightly export is recorded as exercised.

## Related

- Architecture views: Containers, RefreshRun, Deployment.
- Other ADRs: [1](0001-run-refresh-as-azure-container-apps-job.md),
  [3](0003-tracker-in-its-own-d1-database.md),
  [4](0004-tool-less-json-schema-judge.md).
