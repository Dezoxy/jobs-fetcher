## Architecture Overview

### Purpose

jobs-dashboard is a private job-search dashboard for one person. Once a day it
collects job ads from four portals, has Claude judge the new ones against the
owner's target roles, merges the result into one list and tells the owner
what changed. The owner reads the list and records a status per job in the
dashboard. The list shows where the owner is applying while employed, so it
must never be public.

This describes the system after the v2 switch on 2026-11-24. The binding
contract, with every schema and rule, is
[architecture-v2.md](../../architecture-v2.md).

### Context

The owner signs in through Cloudflare Access and reads the dashboard; a
Telegram digest arrives after each run that changed the list. The runner
collects from the job portals, reads the owner's target roles and salary
benchmarks from the private `employee-cv` repository and asks Claude for a
verdict on each new ad.

![System context: what jobs-dashboard depends on, and who uses it](embed:SystemContext)

### What runs

Two halves, in two clouds. On Cloudflare: the static UI, the Worker that serves
data and the tracker, two D1 databases (`jobs-data`, `jobs-tracker`) and the
`SNAPSHOT` KV namespace. On Azure: two scheduled Container Apps Jobs (the
refresh runner at 13:00 UTC, the backup at 04:15 UTC), Key Vault and a
separate backup storage account.

The runner is the only writer of jobs and verdicts; the Worker only adds job
ids from alert e-mails. The runner commits each run to D1 and then
puts a rendered snapshot into KV; the Worker streams that snapshot unparsed and
never builds the list itself. The tracker is the owner's own data and lives in
its own database, so restoring job data never rewinds it
([ADR 3](../decisions/0003-tracker-in-its-own-d1-database.md)). GitHub holds
code only ([ADR 2](../decisions/0002-d1-data-plane-github-code-only.md)).

![Container view: what runs, and which stores each part reads and writes](embed:Containers)

### One refresh run

`cloud-run.mjs refresh`, with `JOBS_DATA_PLANE=d1`, first fetches the two
`employee-cv` files with the CV deploy key, then starts `scripts/v2/run.mjs`
with an allowlisted environment. The run:

1. reads both databases in one consistent batch each, and fails unless the
   tracker import sentinel exists and `jobs` is not empty;
2. re-puts the last committed snapshot to KV, which heals a run whose KV write
   failed, and stops with `already_completed` if this 13:00 UTC slot already
   has a `runs` row;
3. turns tracker statuses into verdicts; a positive status releases `tracker:`
   and `fit:` verdicts for that job;
4. collects from Profession, No Fluff Jobs, LinkedIn guest search, Indeed
   Hungary (JobSpy) and the LinkedIn ids from alert e-mails, filters them
   through the ledger and vetoes, and checks the liveness of recent rows;
5. fetches ad text for new candidates only and has Claude judge them
   ([ADR 4](../decisions/0004-tool-less-json-schema-judge.md));
6. merges in code, applies the removal guard (at most `max(5, 20%)` of the
   probed rows) and validates the materialised snapshot;
7. commits everything in one D1 batch whose first statement inserts the `runs`
   row, then puts `last-run.json` and `jobs.json` into KV;
8. sends the Telegram digest if the list changed, and treats it as delivered.

Exit 0 is success, 8 is success with an incomplete collector, liveness sweep,
prefetch or judge, and 70 is a failure with nothing committed.

![Dynamic view: one daily refresh run](embed:RefreshRun)

### Who can reach the data

Access in front of the hostname is the primary control. The Worker checks the
Access assertion again on every data route and lets through only the owner's
address, or the runner's service token for reads
([ADR 5](../decisions/0005-verify-access-jwt-in-worker.md)). The `workers.dev`
and preview URLs, which bypassed Access until 2026-11-24, are disabled.

The second way in is e-mail. LinkedIn alert e-mails reach the Worker's
`email()` handler through Cloudflare Email Routing; only mail with a passing
LinkedIn DMARC verdict counts, and only job ids are kept
([ADR 6](../decisions/0006-ingest-linkedin-alert-emails.md)).

![Access view: who can reach the Worker, and where each caller is checked](embed:Access)

### Where the credentials come from

Each job resolves its secrets from Key Vault by name at start, through its own
managed identity. The runner and the backup job share one Cloudflare API token
with D1 and KV edit rights for the whole account. The Claude subscription
token is the judge's first path; the API fallback authenticates with a token
from Entra ID through workload identity federation, so no API key is stored.
The [threat model](02-threat-model.md) lists what each credential exposes.

![Secrets view: where the jobs' credentials come from, and what each unlocks](embed:Secrets)

### How a change ships

Two paths. The Worker and the UI deploy through Cloudflare Workers Builds on
every push to `main`. The refresh image is released by tag and deployed by a
pin bump: a merge that changes the image's inputs gets the next CalVer tag
([ADR 7](../decisions/0007-calendar-versioning.md)) and an image in private
GHCR; Renovate then proposes the pin, which automerges after CI, and the push
to `main` triggers a deploy whose guard accepts only an image change to both
jobs and waits until neither is running
([ADR 8](../decisions/0008-release-by-tag-deploy-by-renovate-pin.md)).
Infrastructure changes go through the reviewed operator plan and apply.

![Delivery view: how a merged change reaches the jobs and the Worker](embed:Delivery)

### Where it runs, and what fails together

The Worker, D1 and KV share Cloudflare: an outage there stops the dashboard
and the runner's reads and writes alike. The two jobs share one Container Apps
environment and Key Vault in Azure West Europe. Job data survives a bad run
through D1 Time Travel (7 days on the Free plan) and the nightly export to the
separate backup account (30 days). No restore from the export is recorded as
exercised.

D1 is in the EU jurisdiction. Workers KV has no jurisdiction setting, so the
snapshot of the job list is not held to the EU. Ad text, target roles and
salary benchmarks are processed by Anthropic, and the digest sits in Telegram's
cloud.

![Deployment view: where it runs, and what fails together](embed:Deployment)

### Observability

The jobs log to a Log Analytics workspace in West Europe (30-day retention).
Two alert rules e-mail the owner: failures in the last 30 minutes, and a job
with no success line for 26 hours. The Worker logs structured lines
(`access_denied`, `snapshot_missing`, `email_unverified`, `email_ingested`) to
Workers Logs.

The alert queries ([monitoring.tf](../../../infra/azure/monitoring.tf)) match
both the v1 lines and the v2 refresh exit line
`cloud_job event=v2_refresh_exit job=refresh code=N` from
`scripts/cloud-run.mjs`. Code 0 or 8 counts as fresh, and any non-zero code
counts as a failure, so exit 8 (partial collection) does both, as v1's
`collection_exit=8` did. The v2 backup still writes `cloud_job event=success`.
Fixed in jobs-dashboard PR #69 on 2026-11-25.

### Status

v2 is live since 2026-11-24. Cutover step 4 started on 2026-11-25: the v1
runner (Blob state machine, git publishing, `refresh-run.sh`) and the
repository deploy key are removed, then `public/data` and the Worker's static
fallback, and the Azure Blob state account (jobs-dashboard #72). The
release flow in [ADR 8](../decisions/0008-release-by-tag-deploy-by-renovate-pin.md)
is live since 2026-11-25.
