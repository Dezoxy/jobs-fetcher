# Jobs-dashboard Azure cutover — 2026-10-09

The owner authorized copying secrets, pausing the homelab publisher and enabling
Azure before the 09:00 Budapest refresh. Runtime, backup and state resources are
in West Europe; GitHub, Cloudflare, Claude and Telegram remain external processors.

## Release and credentials

Application [PR 34](https://github.com/Dezoxy/jobs-dashboard/pull/34) and homelab
PR 1103 (private homelab repository) were merged
before deploying. Release v1.0.0 is pinned to
`ghcr.io/dezoxy/jobs-dashboard@sha256:56176a048a93891764fe51b62265dc91799646ed0232e69b2b1c5af2e32c9682`.
Release CI passed Node/Azurite tests, Python secret-copy tests, Terraform safety
gates and the Linux image build. Homelab full `make ci` passed in a clean tracked
snapshot; the pause playbook dry run passed before the scoped config deployment.

Nine secrets were copied/created in `kv-toom-jobs-weu` and readback-verified,
without printing values or putting credentials into Terraform. Source credentials
and deploy keys were retained. The pilot has a separate read-only GitHub deploy
key and no production tracker/Telegram secrets. Registry authentication was
verified against the immutable image manifest.

## Pilot and state handoff

`jobs-pilot-frl45cv` succeeded from 06:29:40 to 06:38:13 UTC (8m33s), exit 0.
Collection and liveness succeeded; all 1,131 jobs passed validation. Publishing,
Telegram and tracker import were disabled. ARM metrics returned eight one-minute
maximum samples: memory peaked at 476,856,320 bytes (454.8 MiB), CPU at 0.0982
cores. These samples can miss shorter peaks; the historical 60-run VM evidence
remains the stronger capacity baseline. One complete isolated pilot was used
before cutover; the plan's three-pilot observation target remains follow-up work.

At 08:40 Budapest the merged, scoped Ansible pause operation disabled/stopped
only `jobs-refresh.timer`; the service was inactive. The VM checkout advanced
with a fast-forward to merged main before the guarded final state export.
The complete VM cache and tracker export were retained in ignored private files.
Only the four approved essential files were seeded into the production Blob
namespace, and an export readback matched the entire seed exactly. The seed
contained 1,131 jobs, 185 saved rows and 1,131 firstSeen values.

Operator access for the handoff is scoped to state/pilot Blob containers,
backup-container readback and the dedicated vault. Workload identities have no
Terraform-backend access. VM state, service configuration and keys remain for
recovery; its recurring publisher is paused, not deleted.

## Production verification

The first production refresh and backup revealed Cloudflare challenges on the
tracker requests. An Azure read-only probe with identical credentials confirmed
HTTP 403 for the default client and HTTP 200 for an explicit
`jobs-dashboard/1.0` User-Agent. Both tracker readers now identify that client;
Cloudflare Access remains unchanged. The failed backup wrote no recovery blob.
The initial refresh retained the existing rejection ledger after import failed.

## Schedule activation and first scheduled-slot run

The edge Terraform change ([toom-edge#206](https://github.com/Dezoxy/toom-edge/pull/206))
merged and its `terraform-sync` run on main succeeded (07:02 UTC). It changed one
existing resource: Bot Fight Mode on the primary zone, enabled to disabled, so
authenticated tracker automation is not challenged. The live zone setting was not
re-read from this Mac; CI success is the evidence.

The reviewed schedule plan (2 add, 2 change, 2 destroy) was applied after all
executions had drained. It replaced only the `jobs-refresh` and `jobs-backup`
definitions (Manual to Schedule) and enabled `jobs-dashboard-failures` and
`jobs-dashboard-freshness`. A follow-up `terraform plan` showed no drift. Live
state: refresh `0 1,7,13,19 * * *` UTC, backup `15 4 * * *` UTC, pilot still
Manual, all jobs on the same immutable image digest. The VM's `jobs-refresh.timer`
was confirmed disabled and inactive over SSH, with no jobs container running.

Evidence for the corrected image:

| Item | Result |
|---|---|
| `jobs-backup-cvljsmk` (07:03 UTC) | Succeeded, after the two tracker-403 failures |
| `jobs-refresh-yzg51cm` (manual, slot 2026-10-09T07:00Z) | Succeeded, 08:17:36 to 08:24:13 UTC (6m37s), exit 0 |
| Checkpoint phase | `completed`, `refreshExit` 0, manifest advanced under the lease |
| Publication | Commit `31e1a49` on main; 1,131 jobs, all with `firstSeen` |
| Telegram | `delivery: skipped`: no added/removed/promoted/archived job, so no message by design |
| Tracker | Unauthenticated request still gets the Access redirect (302) |

Not yet evidenced: a cloud Telegram send (needs a run with list changes), a
notification-delivery drill for either alert, an independent restore from the
backup account, and the plan's three-pilot target. Log Analytics queries still
fail certificate verification from this Mac, so run logs were not read here;
outcomes above come from execution status, the Blob manifest and bundle, and git.

The actual Log Analytics console schema was queried through a trusted guest
connection because this Mac's direct endpoint certificate check failed. It has
`ContainerJobName_s`, `ContainerGroupName_s`, `Log_s` and `TimeGenerated`, matching
the alert queries. Do not treat schema validation as proof of delivered alerts;
no synthetic failure or notification-delivery alert drill has been performed.

## Observation

Retain seven days of run/collection/delivery/memory/cost evidence before retiring
homelab resources. The €5 budget sends notices and does not cap spending. Keep
source credentials until recovery and observation are complete. A fallback to
the VM requires draining cloud runs and transferring the newest cloud state;
never enable its stale cache alongside the cloud publisher.
