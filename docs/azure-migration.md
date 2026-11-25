# Azure migration and recovery

Owner: Toom. Prepared and cut over 2026-10-09. Azure owns production refreshes;
the homelab timer is disabled. See the [cutover record](azure-cutover-2026-10-09.md).
The [migration plan](azure-migration-plan.md) records scope, cost and measured
memory evidence. This runbook describes the implemented operator commands.
Nothing here authorizes billed-resource creation, secret copying or cutover.

> **v1 retired on 2026-11-25 (cutover step 4).** The refresh now runs the v2 runner on D1 ([architecture v2](architecture-v2.md)). Sections below that describe the Blob state machine, git publishing, `seed`/`export`/`reconcile`, `refresh-run.sh`, `claude-merge.mjs` or the dashboard deploy key are historical; that code is gone from `main` and only `refresh` and `backup` remain. The v1 state account `sttoomjobsweu` (container `jobs-state`) was deleted the same day after a private, checksummed archive of its 33 current blobs.

## Prepared application

[Dockerfile](../Dockerfile) builds a non-root Linux/amd64 image through
[`scripts/build-image.sh`](../scripts/build-image.sh). Tool pins live in
[`runtime/versions.env`](../runtime/versions.env); Azure SDK dependencies are
exact versions in package.json/package-lock.json. Claude remains the measured
VM version, 2.1.284, with subscription OAuth, Opus 5.5 and xhigh merge effort.

The [cloud runner](../scripts/cloud-run.mjs) clones dashboard main into a private
session and verifies every executable script, package manifest and refresh
instruction against the image. Data-only commits can advance independently;
code changes require a matching reviewed release. GitHub host keys are pinned.
Only judge-profile.md, target-roles.md and salary-benchmarks.md are exported from employee-cv;
its temporary Git object store is removed before the merge starts.

The existing refresh script performs collection/merge/validation with its own
publication and notification disabled. The parent checkpoints `ready`, commits
only the two data files, checkpoints the Git bundle as `committed`, and confirms
remote acceptance before checkpointing `published`. The prepared Telegram
message is one bounded message from the existing formatter. `sending` is saved
before the API request; a confirmed message ID leads to `completed`. Uncertainty
blocks automatic resend. Completed UTC slots suppress duplicate execution.
An exit 8 still preserves the successful publication and emits a degraded-source
alert. Git acceptance does not prove Cloudflare deployment.

Cloud state (`scripts/cloud-state.mjs`, removed) used a renewable 60-second Blob lease,
immutable checksum-verified JSON bundles, an ETag-conditional manifest update,
and an explicit four-file allowlist plus pending commit/delivery metadata.
Missing/corrupt state fails closed. Bundles are bounded to 32 MiB. A watchdog
kills child process groups on lease loss or the 35-minute active-work deadline.
The platform allows 50 minutes including lease wait and finalization, with no
platform retries. Ordinary refreshes retain the current/previous bundle and
prune other bundles older than seven days under the lease.

The refresh subprocess excludes Git, Telegram, registry and Blob credentials.
Its merge wrapper receives managed identity access for the optional API fallback;
the actual Claude subprocess excludes that access and tracker credentials. This is
environment hygiene, not a separate operating-system security boundary: the
parent and merge run as the same container user.

## Claude API fallback

The primary merge stays on subscription-authenticated Claude Code. When that
call fails, returns an error result, returns empty text, or leaves `last-run.json`
unchanged, `claude-merge.mjs` (removed; the v2 judge uses `scripts/claude-cli.mjs`) could retry the same
prompt and tool workflow with prepaid Claude API credits. The default model
order matches notification-digest: `claude-opus-5-5,claude-sonnet-5-5`.
`JOBS_REFRESH_FALLBACK_MODELS` accepts one or two explicit Claude model IDs.
Both attempts retain `JOBS_REFRESH_MERGE_EFFORT`; there is no second collector,
publisher or Telegram sender. Before each fallback the four allowlisted state
files are restored to their pre-merge bytes. Validation and the cloud parent's
publication/delivery checkpoints remain mandatory. If every leg fails, the
existing failure alert fires and no candidate is published.

Unlike digest's text-only Messages call, this merge needs Claude Code's file
tools. The wrapper therefore obtains an Entra app assertion and lets Claude
Code's built-in federation exchange and refresh its short-lived Anthropic
tokens throughout the tool loop. There is no stored API key. The subscription
process receives only subscription OAuth; the fallback process receives only
the federation identifiers and app assertion. Neither gets the managed identity
endpoint/header, tracker, Git, registry or Telegram credentials. Inherited
API keys, bearer tokens, routing variables and Anthropic profiles are discarded.
The Anthropic profile directory is isolated under the private per-run Claude
directory. These are environment controls, not a new OS isolation boundary.

The whole refresh still has the 35-minute active-work deadline and lease-loss
fencing. A fallback starts only while that execution remains alive: reaching
the hard deadline kills the whole process tree rather than starting another
model. There are at most two API legs per merge attempt, and the existing
`JOBS_REFRESH_MERGE_ATTEMPTS` no-output retry remains. Structured `cloud_merge`
logs record model, fallback status, exit, input/output tokens and the CLI's
reported `cost_usd`; the subscription's reported cost is not an API charge.
Provider error bodies and credentials are not logged.

### Configure and activate

No federation identifiers means the fallback is disabled. A partial or malformed
set fails the refresh before it acquires the state lease. Backup and recovery
commands do not require Claude federation. All five required values belong in
the reviewed nonsecret `app_env` map, never `secret_names`:

```hcl
ANTHROPIC_FEDERATION_RULE_ID   = "fdrl_REPLACE_WITH_RULE_ID"
ANTHROPIC_ORGANIZATION_ID      = "REPLACE_WITH_CONSOLE_ORGANIZATION_UUID"
ANTHROPIC_SERVICE_ACCOUNT_ID   = "svac_REPLACE_WITH_SERVICE_ACCOUNT_ID"
ANTHROPIC_FEDERATION_AUDIENCE  = "api://REPLACE_WITH_AUDIENCE_APP_ID"
ANTHROPIC_FEDERATION_TENANT_ID = "REPLACE_WITH_ENTRA_TENANT_ID"
# Optional when the federation rule is bound to one workspace:
ANTHROPIC_WORKSPACE_ID        = "wrkspc_REPLACE_WITH_WORKSPACE_ID"
```

Use the same two-hop Entra setup as
[notification-digest](https://github.com/Dezoxy/notification-digest/blob/main/docs/azure-migration.md#claude-api-fallback-workload-identity-federation):
managed identity -> audience app -> Anthropic. A direct managed identity
assertion lasts roughly 24 hours and exceeded Anthropic's issuer lifetime
limit during digest setup. The intermediate app assertion lasts about an hour.

1. Configure a dedicated Claude workspace/service account/rule with a monthly
   spend limit, or explicitly approve sharing digest's workspace and cap.
   Sharing also lets this workload consume digest's remaining budget. API
   processing uses Anthropic's configured residency and retention; placing
   Azure resources in West Europe does not guarantee EU inference residency.
2. On the chosen Entra audience app (identifier URI `api://APP_ID`, access token
   version 2), add one federated identity credential with issuer
   `https://login.microsoftonline.com/TENANT_ID/v2.0`, subject equal to the
   **jobs-dashboard-runner principal ID**, and audience
   `api://AzureADTokenExchange`. Do not add the backup identity or a wildcard.
   Anthropic's rule must match the audience app's service principal and its
   bare application-ID audience, as in the digest setup. Adding this trust is
   an explicit access-control change; neither a code merge nor an image deploy
   performs it.
3. After merging/releasing the implementation, prepare an operator Terraform
   plan from main with these `app_env` values. Review it and obtain explicit
   apply authorization. The normal image-only deployment guard deliberately
   rejects environment changes; do not weaken it for this activation. Also
   synchronize the reviewed configuration to `AZURE_TERRAFORM_VARS_JSON` in
   `azure-production` so future image releases see the same desired state.
4. Smoke-test the pinned release's real Claude Code federation in an isolated
   execution with a tiny prompt and file output, subscription OAuth absent,
   no publishing and no notifications. This is a billed API call and requires
   authorization. A successful token exchange alone does not prove the CLI's
   tool workflow. Require valid structured CLI output and expected file bytes.
5. Authorize one production refresh, then verify `cloud_merge fallback=true`,
   validation, completed Blob state, GitHub acceptance, live dashboard data
   and the intended notification outcome. A successful subscription run does
   not exercise fallback. Do not deliberately exhaust the account to test it.

To disable fallback, remove the five identifiers and optional workspace value
through the same reviewed configuration/apply path. Keep subscription OAuth and
the schedules intact. No Anthropic credential needs copying into Key Vault.

## Checks and release

```bash
npm ci --ignore-scripts
npm run check
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
node scripts/check-cloud-docs.mjs
scripts/build-image.sh --tag jobs-dashboard-ci
terraform -chdir=infra/azure init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra/azure validate
terraform -chdir=infra/azure test
```

`azure-application.yml` additionally runs the real Blob SDK against a pinned
local Azurite container. `--skipApiVersionCheck` is confined to that emulator:
the installed SDK uses a newer API header, while these lease/blob operations
are supported. This is no substitute for an Azure pilot.

Preparation verification on 2026-10-09: 33 Node tests including the real Blob
SDK/emulator test, four offline secret-migration tests, four mocked Terraform
gate plans, Terraform validation/formatting, shell/workflow checks and Linux/amd64
image build passed. A non-root image smoke test passed under 0.5 CPU / 1 GiB
with network disabled; it did not run a full AI refresh. The homelab dry run
passed. Its full CI passed in a clean snapshot because the original checkout's
documentation scan descends into pre-existing cached worktrees/dependency docs.
Cloud identity, image pull, actual alert schema and one isolated full refresh
were subsequently verified during cutover; the cutover record records runtime
measurements and production evidence.

After a reviewed application PR is merged, the
[automatic release workflow](../.github/workflows/auto-release.yml) validates it,
creates the next CalVer version (`vYYYY.M.N`) and publishes the private GHCR image;
Renovate then bumps [image.auto.tfvars.json](../infra/azure/image.auto.tfvars.json)
in an automerged PR, which deploys through [GitHub OIDC](azure-image-deployment.md). Only refresh-image
input changes trigger this chain; data, UI, Terraform and general documentation
changes do not create a container release. UI changes deploy through Workers
Builds. Keep `image` out of private Terraform input files so it cannot override
the committed pin. Explicit version tags and manually reviewed digest-pin merges
remain available for operator releases and rollback.

## Foundation: no jobs

The [2026-10-09 foundation record](azure-foundation-2026-10-09.md) tracks the
provisioned resource names and live verification for this deployment.

Select the existing subscription explicitly. Review current Azure inventory
before choosing globally unique names. Runtime, backup and backend use separate
resource groups/accounts in West Europe. The Blob endpoints are publicly
network-reachable but require Entra authentication; anonymous blob access and
Shared Key are disabled. No private endpoint/NAT gateway is added at this scale.
EU resources store job/application history; GitHub, Cloudflare, Claude and
Telegram remain external processors as before.

Bootstrap a separate remote Terraform backend only after explicit authorization.
The reviewed backend must have a private `terraform-state` container, Shared Key
disabled, versioning and deletion retention enabled, a `CanNotDelete` lock, and
operator `Storage Blob Data Contributor` access. Register the necessary resource
providers deliberately; the provider will not auto-register them. The runner
has no backend permissions. Do not initialize a second empty state over an
existing deployment.

Copy [backend.hcl.example](../infra/azure/backend.hcl.example) and
[production.auto.tfvars.example](../infra/azure/production.auto.tfvars.example)
to their ignored private counterparts. Fill in subscription, unique names,
recipient and billing-month start. Keep `jobs_enabled`,
`schedules_enabled`, `migration_release_verified` and
`vm_publisher_paused` false. No secret values belong in either file.

```bash
terraform -chdir=infra/azure init -backend-config=backend.hcl
terraform -chdir=infra/azure plan -out=foundation.tfplan
terraform -chdir=infra/azure show foundation.tfplan
# Explicit authorization is required before the following billed apply.
terraform -chdir=infra/azure apply foundation.tfplan
```

Review a saved local plan from merged code and apply that exact file. Plans are
sensitive and ignored. The stack creates state/backup storage, dedicated vault,
identities, Consumption environment, logs, disabled alerts and a five-unit
monthly budget across the three resource groups. The amount is in subscription
billing currency; the notification does not cap spending. No job resource exists
until explicitly enabled.

## Credentials and historical pilot

Review [secret-migration.json](../infra/azure/secret-migration.json) against current
Key Vault metadata and VM key paths. The dedicated vault receives copied values;
the original source copies were retired after cutover. The copy tool preserves
tags and validity metadata,
preflights conflicts and never prints values:

```bash
python3 scripts/migrate-azure-secrets.py --subscription SUBSCRIPTION_ID --target-vault JOBS_VAULT
# After explicit secret-copy authorization:
python3 scripts/migrate-azure-secrets.py --subscription SUBSCRIPTION_ID --target-vault JOBS_VAULT --apply
python3 scripts/migrate-azure-secrets.py --subscription SUBSCRIPTION_ID --target-vault JOBS_VAULT --verify
```

Import the two existing private SSH keys through protected local files using
`az keyvault secret set --file PRIVATE_FILE --output none`, preserving the
`folder=jobs-refresh` and appropriate `envvar` tags on each version. The image is
public and needs no registry credential (ADR 9). Verify all
referenced secrets before enabling jobs; Manual jobs can resolve secrets during creation.
Never print key/token values or put them in Terraform arguments.

The migration used a Manual pilot with a separate identity, read-only dashboard
key and `jobs-pilot` state container. Its completed validation is recorded in
[azure-cutover-2026-10-09.md](azure-cutover-2026-10-09.md). At the owner's request,
the pilot was retired on 2026-10-09: its job, identity, state container, access
roles, GitHub deploy key and vault secret are removed. Four historical state
blobs were archived privately before container removal. The current Terraform
stack has only production refresh and backup jobs; it has no pilot enable flag.

The original migration validation criteria were:

Complete at least three representative runs at the selected allocation. Capture
real RAM/elapsed time, source egress, OAuth/model behavior, collection degradation
and cold checkout/state overhead. Require no OOM and completion within 35 minutes.
Exercise crash recovery, lease fencing and restore using fixtures and separate
test destinations. Delivery testing uses offline mocks until an explicitly
authorized test destination is prepared. Never use the production chat as a test.

## Production handoff

Follow the homelab handoff runbook (private homelab repository).
Pause future timer firings through a reviewed/merged/deployed configuration
change, then wait for the active refresh to finish. Keep the checkout, cache,
keys and configuration. Resolve unpushed/divergent or uncommitted data first.

Inside the existing VM refresh container, using the newly merged application
scripts and a private export mount:

```bash
node scripts/cloud-export-local.mjs /data/jobs-dashboard /PRIVATE_EXPORT/state.json
```

The export fetches main and requires exact HEAD equality and clean data before
copying the four allowlisted state files. Preserve a separate full-cache export
for historical investigation. Verify GitHub commit, ledger relationships,
counters, firstSeen and saved/application history. Do not log private exports.

Set operator Blob configuration to production container `jobs-state` and namespace
`production`, and seed the final state once. A second seed refuses overwrite.
Enable production jobs as Manual with `jobs_enabled=true`, configure
`JOBS_REFRESH_PUBLISH=true` and `JOBS_REFRESH_NOTIFY_ENABLED=true` in `app_env`,
and attest `vm_publisher_paused=true` and `migration_release_verified=true` after
the pilot/handoff checks. These gates apply to Manual publication too.
Review/apply the saved plan only after explicit authorization.

Run one production refresh and backup. Verify GitHub acceptance, eventual
Cloudflare data propagation, tracker/history integrity and intended Telegram
delivery. Verify backup integrity and an isolated restore. Then authorize a plan
with `schedules_enabled=true`; refresh is `0 13 * * *` UTC, backup
`15 4 * * *` UTC. Verify live cron settings and actual alert schema/KQL.
Observe seven days before the separate homelab retirement PR/deploy.

## Daily refresh configuration

The desired production schedule is one refresh at **13:00 UTC daily** (`0 13 * * *`),
which is 14:00 in Hungary in winter and 15:00 in summer. Backup remains at
`15 4 * * *` UTC. Both freshness limits are **26 hours**, allowing the daily
interval plus two hours for execution and log ingestion. Dashboard stale indicators use the same 26-hour limit. Failure alerts remain
on their existing 15-minute evaluation cycle.

The cloud runner uses the most recent 13:00 UTC slot as its durable completion
key. Runs before 13:00 belong to the previous day's slot; delayed executions and
manual retries after 13:00 reuse that day's slot. Completed slots cannot refresh
again. Existing ready/committed/sending states retain their original slot and
are recovered before a new merge; no state schema or cache reset is required.
A completed old 13:00/19:00 slot also prevents a duplicate refresh of that day.

LinkedIn discovery uses **26 hours** (`f_TPR=r93600`), with job-ID deduplication
across queries and the merge's existing IDs/history preservation. This closes
the systematic gap a 12-hour lookback would leave on daily runs. It does not
recover an entirely missed day and cannot remove LinkedIn's 100-result query
ceiling. Caps, repeated-page regressions and partial query failures retain usable
rows but exit 5, becoming collection exit 8 after validation/publication. Total
query failure exits 4 and blocks the refresh. Saved discovery diagnostics include
`lookbackHours`, `queryFailures` and `truncatedQueries`; the filter preserves them
for the merge to include coverage problems in the run summary. The collapse threshold
remains 15; a larger row count does not override coverage failures.

Missing-source warnings require three daily runs **and** at least three UTC
calendar days since `lastSeen`, preserving the prior approximate three-day
warning period without rewriting legacy counters. The 14-day archive rule,
liveness checks, source selection and merge models stay the same. One daily
merge replaces four scheduled merge opportunities; this reduces scheduled calls
by 75%, not necessarily total tokens/cost by 75%, because each daily run can
contain more candidates and API fallback may retry.

### Roll out the daily schedule

1. Merge the reviewed PR and wait for the release image and tracked digest pin.
   The image-only automatic deployment guard rejects the schedule and alert
   changes in this rollout. Use the operator apply path; do not weaken the guard.
2. From main, create and review a fresh Terraform plan using the current
   production configuration and released image pin. Expected changes are the
   refresh cron, freshness query and new image on both jobs if still pending.
   Backup cron, identities, secret references, resources and federation settings
   must remain unchanged. Obtain explicit authorization before applying.
3. Wait for refresh and backup executions to be idle, then apply the reviewed
   plan together so the runner's daily slot and Azure's schedule agree. Avoid
   an in-flight execution and the next scheduled start. No namespace reseed or
   counter migration is needed. The schedule is defined in code; no new GitHub
   configuration variable is required.
4. Read back the live refresh/backup cron expressions and freshness KQL. At the
   first 13:00 UTC execution verify collection diagnostics, validation, completed
   state, publication and intended notification. Before 26 hours elapse, confirm
   that normal overnight inactivity does not cause a freshness alert. A skipped
   completed slot is not proof that a new refresh succeeded.

## Recovery

Disable cloud schedules before operator recovery and wait for active executions
to finish. Export state to a new private path with
`node scripts/cloud-run.mjs export PRIVATE_OUTPUT --operator-login`. The runner
resumes prepared data or a saved Git bundle before another merge; it refuses
history divergence and never force-pushes or rebases pending work.

Telegram delivery never blocks a refresh and needs no operator (owner
decision 2026-11-22: a missed message is acceptable, the data is on the
dashboard). Each send resolves within its run and the success line reports it:

- `delivery=sent`: Telegram confirmed a message ID.
- `delivery=failed`: the request provably never left the container
  (`cause=` `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `ENETUNREACH`,
  `EHOSTUNREACH`, `UND_ERR_CONNECT_TIMEOUT`) on all three attempts, 30 s apart.
- `delivery=unconfirmed`: any other error (timeout, reset, HTTP error). It may
  have been delivered and is assumed so; it is never resent.

Each failed attempt logs `event=telegram_error` with the error class, cause
code, HTTP status and attempt number. A send interrupted by a crash or kill
leaves `phase=sending`; the next execution logs `event=telegram_assumed`,
records it `unconfirmed` and continues. Between those two points an operator may
still override with
`node scripts/cloud-run.mjs reconcile sent|unsent TARGET_COMMIT --operator-login`;
`unsent` makes the next execution resend instead of collecting.

The backup job reads immutable production state and exports the Access-protected
tracker. Its identity can read runtime blobs and write the independent backup
account, but cannot modify runtime state and receives no Git/OAuth/Telegram
credentials. Each copied bundle is read back and checksum-verified. Recovery
copies expire after 30 days; ordinary refresh cannot access that account.

Download a reviewed backup privately, verify its digest against its blob name,
then extract it offline with
`node scripts/cloud-restore-backup.mjs PRIVATE_BACKUP NEW_PRIVATE_DIRECTORY`.
This produces `state.json` and `tracker.json` without modifying production.
Seed a new isolated state container/namespace and prove restoration there first.
For production replacement, explicitly authorize a configuration change to that
verified recovery container, preserving the damaged original for investigation.
Review tracker history before importing it through the existing authenticated
tracker API; recovery never silently overwrites newer application history.

No VM fallback starts automatically. Keep exactly one publisher and one sender.
