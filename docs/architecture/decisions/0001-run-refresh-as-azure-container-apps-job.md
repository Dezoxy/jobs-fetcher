# 1. Run the refresh as an Azure Container Apps Job

Date: 2026-10-09

## Status

Accepted

Amended by [2. D1 is the data plane and GitHub is code only](0002-d1-data-plane-github-code-only.md):
since 2026-11-24 the refresh job is stateless and writes to Cloudflare D1. The
Azure Blob lease and bundle state machine this record introduced is being
retired (v2 cutover step 4). The hosting decision itself stands.

In production since the cutover on 2026-10-09. The schedule moved from four
runs a day to one, at 13:00 UTC, on 2026-10-11.

## Context

The refresh pipeline (collect, filter, check liveness, merge with Claude,
validate, publish, notify) ran on a timer on a self-hosted container host. The
owner approved moving it to Azure, following the same move of the sibling
notification-digest project (its ADR 7). Beyond following that migration, the
reason for leaving the self-hosted host is not recorded in this repository.

The work is a finite batch run. A read-only sample of 56 runs over 14 days
before the move averaged 8.25 minutes, with a maximum of 14.63 minutes. An
isolated Azure run of the release image at 0.5 vCPU / 1 GiB took 8m33s with a
454.8 MiB memory peak ([migration plan](../../azure-migration-plan.md)).

## Decision drivers

- Pay for minutes of compute, not for an always-running host.
- Credentials resolved through a managed identity from a dedicated vault, not
  files on a host.
- EU region for the workload, its state and its logs.
- The exact image CI tested is the one that runs.

## Considered options

1. Keep the self-hosted timer.
2. An always-running Azure VM.
3. Consumption Container Apps Jobs, one per scheduled mode.

## Decision

Option 3. Two jobs in one Container Apps environment in West Europe, both from
the same private GHCR image, pinned by digest
([main.tf](../../../infra/azure/main.tf)):

- `jobs-refresh`, daily at 13:00 UTC, runs `cloud-run.mjs refresh`;
- `jobs-backup`, daily at 04:15 UTC, runs `cloud-run.mjs backup` and writes to a
  separate backup storage account through its own writer identity
  ([backup.tf](../../../infra/azure/backup.tf)).

Each job gets 0.5 vCPU / 1 GiB, parallelism 1, no platform retries and a
3,000-second timeout. Secrets come from the dedicated Key Vault by name; their
values never enter Terraform. Log Analytics alert rules e-mail the owner on a
failure and when a job has not succeeded for 26 hours. A €5 monthly budget
notification covers the runtime, backup and Terraform-state resource groups.

Option 2 was ruled out in the plan itself: "a small, short-lived container
allocation, not an always-running Azure VM". No reason for preferring option 3
over option 1 is recorded beyond the digest precedent.

## Consequences

Positive:

- No host to patch; the job exists only while it runs.
- Workload, backups and logs stay in West Europe.
- The deploy path can refuse anything but an image change
  ([ADR 8](0008-release-by-tag-deploy-by-renovate-pin.md)).

Negative / accepted trade-offs:

- An ephemeral container keeps nothing between runs. v1 answered with a Blob
  lease and checkpoint state machine; v2 moved all state to D1
  ([ADR 2](0002-d1-data-plane-github-code-only.md)).
- GHCR is private, so each job holds a static registry pull token from Key
  Vault.
- The budget is a notification, not a spending cap.

## Risks

- Azure egress could be refused by a job portal. The plan listed it as an
  assumption to validate. A refused source shows as degraded collection
  (exit 8), not as a failed run.
- The alert rules match log-line text. A runner that changes its log lines
  must change the queries too, as jobs-dashboard PR #69 did for v2. See "Observability" in
  the [overview](../overview/01-jobs-dashboard.md).

## Related

- Architecture views: Containers, Deployment, Secrets.
- Other ADRs: [2](0002-d1-data-plane-github-code-only.md),
  [8](0008-release-by-tag-deploy-by-renovate-pin.md).
