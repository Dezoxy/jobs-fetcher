# Jobs-dashboard Azure foundation — 2026-10-09

Historical foundation snapshot: workloads and credential copying were disabled
at this stage. The later [cutover record](azure-cutover-2026-10-09.md) records
credential copying, workload activation and the homelab handoff.

The owner explicitly authorized foundation creation without any secret copying.
Resources use the existing subscription (ID in the `azure-production` environment variables)
and West Europe. Configuration remains on `codex/azure-jobs-migration`; no cloud
application release or homelab deployment has been performed.

| Purpose | Resource |
| --- | --- |
| Terraform backend resource group | `jobs-dashboard-terraform-westeurope` |
| Remote state | `sttoomjobstfweu` / `terraform-state` / `jobs-dashboard.tfstate` |
| Runtime resource group | `jobs-dashboard-westeurope` |
| Application state and isolated pilot state | `sttoomjobsweu` / `jobs-state`, `jobs-pilot` |
| Backup resource group | `jobs-dashboard-backups-westeurope` |
| Recovery storage | `sttoomjobsbakweu` / `jobs-backups` |
| Dedicated Key Vault | `kv-toom-jobs-weu` |
| Consumption environment | `jobs-dashboard` |
| Logs | `jobs-dashboard-logs` |
| Identities | `jobs-dashboard-runner`, `jobs-dashboard-pilot`, `jobs-dashboard-backup-writer` |
| Disabled operational alerts | `jobs-dashboard-failures`, `jobs-dashboard-freshness` |
| Budget and recipient | `jobs-dashboard-monthly`, €5/month, same recipient as notification-digest |

## Verification

The backend was created separately with Azure CLI. It uses Entra authentication,
Shared Key and anonymous blob access disabled, a private container, versioning,
14-day blob/container soft deletion and a `CanNotDelete` resource-group lock.
Operator Blob Data Contributor access is scoped to the backend container.

The saved Terraform plan contained 23 creates, no updates/deletions, no job
resources and no Key Vault secret resources. All five activation/attestation
flags were false. No credential migration command was run, and no application
state was seeded.

Live checks confirmed zero jobs and zero vault secrets (the metadata response
had no continuation page). All three storage accounts are Standard LRS in West
Europe with TLS 1.2, Shared Key disabled and anonymous blob access disabled.
Application/pilot/backup containers are private. Runtime and backup blob
versioning and 14-day soft deletion are enabled; container recovery is seven
days for runtime and 14 days for backups. Logs retain 30 days with a 0.1 GB daily
quota. The €5 budget filters the three application resource groups and has 80%
and 100% actual-spend notifications. This is an alert, not a spending cap.

The initial failure-alert creation was rejected because neither Container Apps
log table exists in an empty workspace. Its query now unions an empty typed
table with optional log tables. Terraform formatting/validation and all four
mock safety-gate tests passed after this correction. Direct query verification
from this Mac was blocked by a TLS certificate trust error at the Log Analytics
endpoint; TLS verification was not disabled.

The Consumption environment completed successfully after 17 minutes 27 seconds.
A second reviewed saved plan created only the corrected, disabled failure alert;
Azure accepted it. Final ARM checks confirmed environment `Succeeded`, only the
Consumption workload profile, both operational alerts disabled, zero jobs and
zero vault secrets with no continuation page. Identity role assignments match
the intended production/pilot/backup container scopes; none can access the
Terraform backend.

The final Terraform plan returned exit code 0: all 23 managed resources were
unchanged, no job or Key Vault secret resource existed, and `job_names` was empty.
The state remains in Azure Blob Storage. Local backend configuration, nonsecret
production variables and saved plans are ignored; no application credential
value was read or copied. Source changes remain prepared on the feature branch.

## Remaining stages

Follow the [migration runbook](azure-migration.md) for a merged application
release, separately authorized credential copying, isolated pilot, VM state
handoff and schedule activation. Keep jobs, pilot, schedules, release attestation
and VM pause attestation false until their respective prerequisites are met.
The production homelab publisher continues to own refreshes during preparation.
