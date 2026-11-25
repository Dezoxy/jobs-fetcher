# Azure jobs-dashboard migration plan

Schedule update (2026-10-11): the desired refresh cadence is now daily at
13:00 UTC, with a 26-hour freshness limit and discovery lookback. The four-run
schedule below records the original migration proposal. See the current
[daily configuration and rollout](azure-migration.md#daily-refresh-configuration).

Date: 2026-10-09. Owner: Toom.

Status: cutover authorized and executed on 2026-10-09. Credentials are copied
into the dedicated vault and the homelab timer is disabled. The immutable v1.0.0
release passed an isolated Azure refresh at **0.5 vCPU / 1 GiB** in 8m33s, with a
454.8 MiB maximum among eight one-minute memory samples. See the
[cutover record](azure-cutover-2026-10-09.md) for production, backup and schedule
verification and remaining observation limits.

The [foundation record](azure-foundation-2026-10-09.md) records live resources and
verification. The [operator runbook](azure-migration.md) describes commands and
gates for the remaining migration stages.

## Target and scope

Move the scheduled refresh pipeline from `01-myapps-vm` to Azure Container Apps
Jobs in West Europe, following the [digest migration](https://github.com/Dezoxy/notification-digest/blob/main/docs/azure-migration.md)
and its [hosting decision](https://github.com/Dezoxy/notification-digest/blob/main/docs/architecture/decisions/0007-run-digest-as-azure-jobs.md)
and [state/secrets decision](https://github.com/Dezoxy/notification-digest/blob/main/docs/architecture/decisions/0008-isolate-digest-azure-state-and-secrets.md).

This is a small, short-lived container allocation, not an always-running Azure
VM. Use the existing Azure subscription, selected by ID, with jobs-dashboard-owned
resources and identities. Do not give this application access to digest state or
its vault. Separate resource groups isolate ownership; they do not create a
separate subscription or administrative recovery boundary.

Keep the dashboard Worker, Cloudflare Access, KV tracker, source selection,
fit/dedupe rules, salaries, history and Telegram destination. Preserve Claude
subscription OAuth, the explicitly configured model and merge effort. API billing
is a separate decision. No browser service, managed database, Azure Files, NAT
gateway or Dedicated workload profile is required by the current pipeline.

| Setting | Planned value |
|---|---|
| Compute | Consumption Container Apps Jobs, 0.5 vCPU / 1 GiB |
| Refresh schedule | `0 1,7,13,19 * * *` UTC, preserving the VM's one-hour offset from digest's main slots |
| Parallelism / completion count | 1 / 1; a renewable Blob lease also excludes overlapping executions |
| Platform retries | 0; recover external effects explicitly rather than replaying the whole pipeline |
| Execution timeout | 3,000 seconds, matching digest; up to 10 minutes lease wait, 35 minutes active work, 5 minutes finalization |
| Independent backup | A second job at the same size, once daily at a non-conflicting UTC slot |
| Image | Private GHCR release built from merged code and pinned by immutable digest |
| Runtime user | Non-root, matching the current image |
| State | Private Hot LRS Blob account, managed-identity access, integrity-checked bundles |
| Infrastructure state | Separate backend account/resource group and private container; Entra authentication and Blob locking |
| Credentials | Dedicated Standard Key Vault, RBAC, purge protection; values never managed by Terraform |
| Recovery copies | Separate backup account/resource group, backup-writer identity, 30-day copy retention |
| Logs / alerts | Private EU logs, 30-day retention, failure and freshness alerts every 15 minutes |
| Cost budget | €5/month notification across runtime, backend and backup resources, confirmed in the subscription billing currency; a notification is not a spending cap |

The 35-minute active-work limit is a proposed change from the VM's 60-minute
outer timeout. The pilot must validate it at the requested compute size. An
out-of-memory failure or repeated timeout blocks activation; do not automatically
increase resources or silently reduce collection/model behavior.

## Evidence and assumptions

Evidence inspected on 2026-10-09:

- Refresh orchestration (`scripts/refresh-run.sh`, removed 2026-11-25) fetches Profession and No
  Fluff Jobs, runs sessionless [LinkedIn collection](../scripts/fetch-linkedin.mjs),
  filters, merges, validates, publishes and optionally sends Telegram.
- The publisher (`scripts/publish.sh`, removed 2026-11-25) commits only job data and the run summary.
  A failed push currently leaves a local commit for a subsequent VM execution.
- The notifier (`scripts/notify-telegram.sh`, removed 2026-11-25) follows publication; its outcome
  is not currently recorded durably across ephemeral executions.
- The homelab defaults (private homelab repository)
  and host overrides (private homelab repository)
  declare four runs daily, publishing enabled, tracker import and Telegram enabled.
- A read-only VM sample covered 56 executions over 14 days. Successful executions
  averaged 8.25 minutes, with a maximum of 14.63 minutes. Sixteen executions
  reported collection degradation (exit 8), and one reported a merge failure
  (exit 4). Degradation can occur after successful publication.
- Essential cache state was 260,369 bytes of rejection ledger and 77 bytes of
  unseen counters. The entire cache was approximately 187 MB. These are snapshots,
  not permanent sizing guarantees.

Assumptions to validate: Azure egress is accepted by every source; subscription
OAuth works in the release image; the new cloud runner and release fit within
1 GiB without relying on swap; half a vCPU completes within the active-work
deadline; private GHCR pulls and Cloudflare Workers Builds remain available.

### Historical container memory sizing

A subsequent read-only measurement at 06:24 Budapest time on 2026-10-09 queried
the retained Prometheus/cAdvisor history for `jobs-refresh` on
`01-myapps-vm.home.arpa:18080`. It identified **60 distinct one-shot containers**,
started between 2026-09-24 09:03 and 2026-10-09 03:02 Budapest time. The
[per-run evidence](measurements/jobs-refresh-memory-2026-10-09.csv) records memory
in bytes, image versions, sample counts and journal-matched outcomes/durations.

| Measurement across those runs | MiB |
|---|---:|
| Median recorded per-run total-memory peak | 380.7 |
| 95th percentile of recorded per-run total-memory peaks (nearest rank) | 575.8 |
| Highest recorded total-memory peak | **627.8** |
| Highest sampled working set | 509.8 |
| Highest sampled total usage | 587.7 |
| Highest sampled RSS | 185.0 |
| Highest sampled swap use | 13.5 |
| Largest per-run recorded peak plus sampled swap peak (conservative sum) | **641.3** |

The highest recorded total-memory peak was **658,259,968 bytes** on the successful
2026-10-07 15:07 Budapest run (`jobs-refresh:2.1.284`), also the longest retained
journal-matched execution at **14.63 minutes**. Adding its separately measured
swap peak conservatively leaves **382.75 MiB (37.4%)** below a 1 GiB allocation.
The peaks need not have occurred at the same instant. **Keep 1 GiB**: 512 MiB
offers almost no margin above the measured working set, and 17 of 60 recorded
total-memory peaks exceeded 512 MiB; 2 GiB is not justified by this baseline.

Method: `max_over_time(<metric>{job="cadvisor",instance="01-myapps-vm.home.arpa:18080",container_label_com_docker_compose_service="jobs-refresh"}[15d])`,
evaluated at the measurement time, retaining each distinct container ID. Metrics
were `container_memory_max_usage_bytes`, `container_memory_working_set_bytes`,
`container_memory_usage_bytes`, `container_memory_rss`, `container_memory_swap`
and `container_oom_events_total`; start-time, sample-count and last-seen metrics
were used to check coverage. The peak metric is the exporter-recorded cgroup
high-water mark, not the largest instantaneous usage sample. The VM uses cgroup v2.
See the [cAdvisor metric definitions](https://github.com/google/cadvisor/blob/master/docs/storage/prometheus.md).

Coverage: 1,916 working-set samples, 6-61 per container; the configured scrape
interval is 15 seconds, and this target's scrape-success fraction was 99.986%
over the lookback. Fifty-seven container starts matched completed systemd runs
within one second; three older containers had no matching retained lifecycle
records, so their durations/outcomes are explicitly unknown in the CSV. The
memory evidence still exists for all 60. All sampled OOM counters were zero;
five containers showed swap use. Historical limits were reported as zero
(no configured container memory cap), so absence of OOM alone does not prove a
hard 1 GiB cap. Monitoring can miss a peak after its final sample.

These runs used CLI image versions 2.1.280, 2.1.282 and 2.1.284. The migration
image, Blob checkpoint work, clean-checkout behavior and a no-swap cloud limit
still need pilot verification. The historical data supports the selected memory
allocation; it does not measure the new cloud image or prove 0.5-vCPU performance.

The README now describes the current sessionless producer. The executable
operator procedure is in [azure-migration.md](azure-migration.md); preparation
does not establish a production cloud deployment.

## Durable state and external effects

| State | Authority and treatment |
|---|---|
| `public/data/jobs.json`, `public/data/last-run.json` after push | GitHub main; fetch and verify the actual remote commit |
| Saved/applied/interview history | Cloudflare KV tracker; retain Access and service-token authentication, export for recovery |
| `.cache/rejected-ids.json` | Blob bundle between runs; preserve all reasons and canonical/dedupe relationships |
| `.cache/unseen-streaks.json` | Same bundle; preserve counters across runs |
| Pending publication | Validated candidate data, base/target commit IDs, and Git bundle for unpushed commits |
| Pending Telegram notification | Commit range, one prepared bounded message and durable delivery status |
| Freshly fetched source/liveness data | Regenerate each run; do not restore stale feed verdicts as current observations |
| Credentials and SSH private keys | Key Vault; temporary private files where a tool requires them, never Blob state or image layers |
| employee-cv inputs | Fetch only the two required files with the read-only deploy key; do not add CV material to dashboard data or images |

Retain a private final export of the complete VM cache at handoff for historical
investigation. Runtime bundles carry an explicit allowlist of essential state and
pending work; they do not accumulate every scratch file or backup of old data.

Implement a small cloud runner and narrow checkpoint hooks around the existing
scripts. Preserve the VM path while preparation is in progress. Borrow digest's
lease/manifest contracts, not its collector, database or delivery schema, and do
not introduce a shared framework just for two applications.

Required behavior:

1. Acquire and renew an exclusive Blob lease before restoring mutable state.
   Stop the process group on lease loss or deadline expiry. A local `mkdir` lock
   and `parallelism=1` do not exclude independent Azure executions.
2. Restore a checksum-verified, schema-validated bundle. Missing or corrupt
   production state fails closed; never silently treat an empty ledger as a new
   installation. Initial seeding is an explicit operator operation.
3. Fetch remote data, restore any pending Git bundle, and resolve pending work
   before starting another merge. Refuse divergence for operator resolution;
   do not force-push, reset away unpublished work or automatically rebase it.
4. Checkpoint validated candidate data and cache state before publication, and
   persist the new commit/Git bundle before pushing. A slot record distinguishes
   ready, published and completed work, so a recovered execution does not repeat
   unseen-counter updates or duplicate commits.
5. After an ambiguous push, fetch the remote ref to determine whether the target
   commit was accepted. Checkpoint confirmed publication and its pending
   notification. GitHub acceptance and Cloudflare deployment are separate facts.
6. Persist the Telegram message's prepared/send-in-progress status before
   sending and acknowledgement after a confirmed response. An ambiguous outcome
   blocks that notification for explicit reconciliation; a known unsent message may
   be retried. Exactly-once Telegram delivery is not promised.
7. Persist useful state even for the existing post-publication degraded exit or
   notification failure. Emit separate collection, publication, notification and
  job outcomes; a nonzero exit must not imply published data should be rolled back.
8. Upload immutable bundles and update the canonical manifest conditionally under
   the lease. A crash must leave either the previous valid checkpoint or a verified
  new one. Shutdown traps alone are insufficient to protect state.

Preserve the deliberate one-hour UTC offset from digest and avoid sharing its
main Claude slots. Record completed schedule slots and alert when no refresh has
published for eight hours. Do not assume Azure cron provides the VM timer's
`Persistent=true` catch-up behavior: after a missed slot, the next regular run
collects current sources; an operator can request one bounded recovery run.
Do not replay a backlog of merges, counter increments or notifications blindly.

Daily backups must read a consistent manifest/bundle generation and verify size
and checksums after copying. Ordinary refresh executions cannot write or prune
the independent backup account. This protects against routine runtime damage,
not a compromised subscription administrator. Test a restore from this account.
Snapshot the KV tracker separately with its API service token as part of recovery
coverage; a Blob ledger backup does not preserve application history in KV.

## Implementation packages and gates

### 1. Application preparation: no production changes

Prepare one application PR in this repository:

- App-owned Dockerfile/bootstrap and a private GHCR release workflow. Centralize
  new runtime/tool pins in one application version source rather than scattering
  literals across workflow and build files. Copy no secret-bearing VM directories.
- Cloud runner, state import/export, checkpoint hooks, backup/restore and explicit
  notification reconciliation commands. Keep the current non-cloud path working.
- Application source in the release image, with a separate mutable data checkout.
  Adapt script root handling narrowly; do not let cloning latest main silently
  replace the executable code pinned by the image. Detect incompatible source
  changes and require a reviewed release update.
- `infra/azure/` with explicit subscription, dedicated resources, managed
  identities, scoped roles, disabled-job defaults, budget and monitoring.
- Credential-free CI for existing tests, meaningful cloud failure-path tests,
  Linux image build, Terraform validation and documentation consistency.
- Reviewed runtime-secret-name manifest, backend/nonsecret configuration examples,
  and an executable migration/recovery runbook. Ignore plans, state exports and
  private local configuration. Protect saved plans because they can contain
  provider-computed sensitive values.
- Correct the README's runtime description and link all operator entry points.

Exit gate: the PR is reviewed and merged; offline checks and the deployment-
platform image build pass; the exact image digest is available. A release is not
an Azure deployment. Infrastructure and code changes use PRs; the existing
runtime data publisher's narrowly scoped data commits remain its established path.

### 2. Azure foundation: zero jobs

After explicit authorization to create billed resources:

1. Verify the selected subscription and existing inventory. Bootstrap the separate
   Terraform backend; verify private access, disabled Shared Key, versioning,
   deletion protection and Entra data-plane access. Initialize no parallel empty
   state if an existing deployment already owns resources.
2. Review and apply a saved foundation plan that creates storage, backup storage,
   vault, identities, Consumption environment and logs, with **zero job resources**.
3. Verify access boundaries, all three resource groups' cost scope, retention and
   intended protection. Keep schedules and alert freshness evaluation disabled.

For this private repository, do not assume GitHub required-reviewer environments
are available. The default is an operator-reviewed saved local Terraform plan and
explicit apply from merged code, using the remote backend and Entra credentials.
Plan generation can use GitHub OIDC when the account supports the required setup.
Use gated OIDC apply only after its protection is actually verified; an unprotected
manual workflow dispatch is not a substitute for the reviewed-plan approval.

### 3. Credentials and Manual jobs

Copy and verify only the reviewed application credentials into its dedicated
vault, preserving source values and metadata. Copying is not rotation. Include
the jobs-specific Claude OAuth token, write-capable dashboard deploy key,
read-only employee-cv key, Access service token, Telegram credentials, registry
pull credential and any separately required failure-alert credential. Keep the
homelab's credentials while it still runs this job or serves other applications.

Never supply application secret values to Terraform, repository variables,
release artifacts or logs. Treat Terraform state/plans as sensitive regardless
of this rule because providers can return computed credentials. Preserve pinned
GitHub SSH host keys and strict checking. Limit employee-cv
material to `profile/target-roles.md` and `research/market/salary-benchmarks.md`;
sparse checkout alone is not an authorization boundary. Scope each Azure identity
to the state container/vault it needs and keep backend access off the runner.

Create refresh and backup jobs as **Manual**, at **0.5 vCPU / 1 GiB**, using the
verified release digest. This creation follows secret verification because job
creation can resolve Key Vault references even with schedules off.

Exit gate: image pull, secret resolution and least-privilege access work. Nothing
has become an additional production publisher or Telegram sender.

### 4. Isolated pilot at the requested size

Use a separate test state namespace/container and identity without production-state
access. The dashboard deploy credential grants read-only GitHub access.
Publishing and notifications are disabled; delivery tests use explicit test
destinations. The fixture includes representative
ledger/counters and job data. Never let a pilot mutate the production KV tracker.

Verify full collection and merge using the preserved configuration; capture real
container peak RAM, elapsed time, cold-start cost and degraded-source outcomes.
Measure at least three complete representative runs, including the largest sampled
input set. Passing requires no OOM, completion within 35 minutes, validated data
and preserved saved-job/history/firstSeen semantics. Do not resize without the
owner's decision if this size fails.

Also test interruption after commit, after push and during notification delivery;
lease contention/loss; corrupt/missing state; clone/key/portal failure; and restore
from the independent backup account. Confirm failure and stale-run alerts using
the actual log schema. Subscription-authenticated testing still consumes the same
account allowance; coordinate it with digest rather than assuming another host
removes contention.

### 5. Explicit production handoff

After authorization to change the production scheduler:

1. Verify all preparation code and homelab changes are on main. Keep Azure jobs
   Manual. Pause the VM timer and wait for its container and publisher to exit.
   Verify no alternative desktop schedule or GitHub sender is enabled.
2. Resolve pending local commits and notification outcomes. Export final essential
   state, remote/local commit identities, complete historical cache and KV tracker;
   record hashes and record the last completed schedule slot.
3. Seed and validate the production Blob namespace. Compare ledger reasons,
   counters, canonical relationships, saved history and firstSeen values.
4. Execute one Manual cloud refresh as the sole writer. Verify remote publication,
   actual Workers Builds deployment, live job data, tracker preservation and the
   Telegram result. Verify an independent backup and restore before scheduling.
5. Apply the reviewed schedule-activation plan and enable freshness/failure alerts.
   Verify no VM timer was restarted. Trigger-type changes may replace job
   resources, so inspect that plan and drain executions before applying it.

If a gate fails, leave cloud schedules off and use the last verified state to
repair the cloud deployment. Any temporary return to the VM needs an explicit
decision, drained cloud executions and restoration of the newest cloud state;
never restart the VM against its stale cache or run both publishers. Whether a
temporary VM fallback is permitted is an operator decision before handoff, not
inherited from digest's app-specific no-return decision.

### 6. Observe and retire homelab ownership

Observe seven days (approximately 28 refreshes), retaining separate records of
collection quality, publication, delivery, missed slots, memory and costs. Require
working alerts, an independent restore, intact history and no unresolved cloud
publication/delivery state before retirement. Investigate source degradation
without automatically changing global fit rules.

Then prepare a focused homelab PR disabling/removing only jobs-refresh scheduling,
bootstrap/build, mounts, backup entries and obsolete observability membership.
Preserve every remaining application and shared alert credential. Run the homelab
docs-sync audit, `make ci` and `make deploy-check TARGET=01-myapps-vm`; merge, then
use an explicitly authorized **MODE=config** deploy and verify the retired timer
stays disabled while remaining services work. Do not delete the VM or its disks.

Keep the final handoff export for a defined recovery period. Credential revocation,
secret deletion and local-state removal are later reviewed operations. Cloud-only
recovery after retirement uses the selected image, GitHub, Blob backups and KV
export; document and exercise it before removing the temporary recovery material.

## Cost and acceptance record

The earlier assessment in this session used 20 execution hours/month. At the
selected size that is 36,000 vCPU-seconds and 72,000 GiB-seconds. With digest's
documented 17.86-hour baseline, the combined use is 68,148 vCPU-seconds and
136,296 GiB-seconds, within the monthly shared grants if other applications have
not consumed them. Even 40 jobs execution hours still fits with that baseline.
Include backup execution and startup/lease waits in measured monthly usage.

The 2026-10-09 West Europe active rates retrieved for the earlier assessment were
$0.000034/vCPU-second and $0.000004/GiB-second: 20 hours at this size would cost
**$1.51 compute without grants**, or **$3.02 at 40 hours**. Allow approximately
**$1-3/month additional hosting** with available grants and use a **$5/month budget
notification**. Existing Claude subscription, API/fallback charges if introduced,
tax, domain renewal and existing account-level Cloudflare fees are separate.
The smaller CPU may extend runtime; pricing is an estimate, not a cloud invoice.

Record subscription ID, all resource groups, image/source revision, actual memory
and elapsed time, state generation/hashes, publication/delivery evidence, restore
evidence and measured bill at each gate. Recheck prices and quotas before apply.
Keep state, secrets, logs and copies in West Europe; external Claude, GitHub,
Cloudflare and Telegram processing remains outside that Azure residency claim.
Azure identity/lease/scheduling contracts add provider coupling, while JSON state
and the release container remain portable.

## References

- [Current refresh instructions](refresh-task.md) and [existing deployment boundary](../README.md#ownership-boundary--read-this-before-touching-terraform).
- [Azure Container Apps jobs and UTC schedules](https://learn.microsoft.com/en-us/azure/container-apps/jobs).
- [Azure compute grants and job billing](https://azure.microsoft.com/en-us/pricing/details/container-apps/).
- [Microsoft regional retail-price API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices).
- [GitHub private-repository deployment-review availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments).
