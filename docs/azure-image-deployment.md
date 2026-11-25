# Azure image deployment with GitHub OIDC

GitHub Actions publishes the private image to GHCR using its short-lived
`GITHUB_TOKEN`. Azure access uses OIDC through `azure/login@v3` and Terraform's
`ARM_USE_OIDC=true`. No SSH session or Azure client secret is needed to ship an
image. The image is public, so the Azure jobs pull it anonymously, with no
registry credential; their SSH deploy keys are for GitHub code/data access, not Azure deployment.

## Release and deploy

1. Merge a PR into `main` that changes refresh-image inputs:
   `Dockerfile`, `.dockerignore`, `scripts/**`, `runtime/**`,
   `docs/judge-prompt.md`, `package.json` or `package-lock.json`.
   [auto-release.yml](../.github/workflows/auto-release.yml) runs the full
   application validation workflow, then creates the next CalVer version
   `vYYYY.M.N` (UTC year, unpadded month, per-month counter from 0; for example
   `v2026.11.0` → `v2026.11.1`, then `v2026.12.0`; the scheme notification-digest
   and Flodni use) and its GitHub release. A failed validation creates no
   release. A retry reuses the valid version tag already on that commit. A tag
   pushed by hand is respected and continued from.
2. The automatic workflow calls
   [release.yml](../.github/workflows/release.yml) to test, build and push the
   exact Linux image to GHCR as `ghcr.io/dezoxy/jobs-fetcher:YYYY.M.N`, labelled
   with `org.opencontainers.image.source` so the package is linked to this repo
   and Renovate can read its tags.
   Release stops there; it does not touch the pin or Azure.
3. Renovate sees the new tag and opens a PR that bumps
   [image.auto.tfvars.json](../infra/azure/image.auto.tfvars.json):
   `image_version` (the tag Renovate compares) and `image`, the digest-only
   `ghcr.io/dezoxy/jobs-fetcher@sha256:...` reference Terraform deploys. Both
   come from one registry lookup. The PR automerges once CI is green, at any
   time, with no release-age wait and outside Renovate's PR limits
   ([renovate.json](../renovate.json)).
4. The push of that pin to `main` runs
   [azure-deploy.yml](../.github/workflows/azure-deploy.yml). It creates a saved
   Terraform plan through OIDC and accepts only in-place image updates to both
   production jobs: refresh and backup. Schedules, identity settings, environment
   values, secrets, resource creation/deletion and partial image changes are
   refused. Both jobs already using the pin is a no-op.
5. The workflow binds the pin to merged code: tag `v<image_version>` must point
   to a commit on `main`, and the GHCR tag must resolve to exactly the pinned
   digest. A tag pushed on an unmerged commit, or a re-pointed GHCR tag, never
   deploys. It then waits for all jobs to be
   idle with no scheduled firing in the next ten minutes, checks that no newer
   pin has reached `main`, applies that exact saved plan and verifies each live
   ARM image and provisioning state. It does not start a refresh or send a
   Telegram test message.

Merging application code authorizes the release; the automerged pin PR is the
deploy. No version tag, digest edit or deployment dispatch is needed for normal
PRs. UI-only changes, deployment-workflow changes, Terraform changes and general
documentation changes do not release a container. UI/Worker changes continue
through Cloudflare Workers Builds. The pin file is outside the release path
filter, so a pin bump cannot cut a release. An application PR that also alters
infrastructure can publish its image, but Azure deployment still refuses a plan
containing those infrastructure changes.

If a newer pin lands while a deployment waits, the older run refuses and the
newer pin's own run applies. GitHub's concurrency group keeps one active and
one pending run per workflow; bursts can replace intermediate pending runs, and
the newest commit contains their changes. To pin by hand (for example a
rollback), edit both fields of the pin file to an existing release and merge it
as a reviewed PR; the same guarded deployment runs. For a rollback, also cap the
pin rule in `renovate.json` with `"allowedVersions": "<=YYYY.M.N"` (the rollback
version) in the same PR, so Renovate does not propose the bad release again;
remove the cap when the fix is released.

Deploy latency follows Renovate's run cadence on the hosted app: usually
minutes, sometimes hours, because opening and automerging the pin PR can take
separate Renovate runs. [pin-freshness.yml](../.github/workflows/pin-freshness.yml)
fails, which e-mails the owner, when the newest release is still unpinned six
hours after its commit. A re-run release that rebuilds a tag moves its GHCR
digest; until Renovate's digest PR merges, a manual `operation=deploy` of the old
pin fails closed at the binding check.

A version tag pushed by hand is built by `release.yml`, and Renovate pins it
like any other release. Azure deployment also supports the retry/plan
operations below. Re-run a failed automatic Actions run to reuse its source commit and version. To request
a fresh automatic release of the latest `main` explicitly:

```bash
gh workflow run auto-release.yml --repo Dezoxy/jobs-fetcher --ref main
```

The workflow has a shared concurrency group and does not cancel a deployment
when another pin arrives. Its idle check has a 45-minute limit; if that expires,
re-run the deployment after the active job finishes. The ten-minute margin is
an operational window, not a scheduler lock. Run only one deployment mechanism
at a time; operator Terraform applies must not overlap this workflow.

The repository's `azure-production` environment permits only `main`, and the
`main` ruleset accepts changes only through pull requests.
Azure trusts the exact subject
`repo:Dezoxy@176568786/jobs-fetcher@1471545526:environment:azure-production`, issued by
`https://token.actions.githubusercontent.com` for `api://AzureADTokenExchange`.
The subject prefix is read from GitHub’s OIDC customization API; this repository
uses immutable owner/repository IDs. PRs and other branches cannot use the production environment. The workflow
also checks its ref independently. There is no assumed required-reviewer rule:
merging application code or a manual digest pin authorizes the automatic image update.

To check OIDC and the current pin without applying anything:

```bash
gh workflow run azure-deploy.yml --repo Dezoxy/jobs-fetcher --ref main -f operation=plan
```

To retry a refused/timed-out image deployment after resolving its cause:

```bash
gh workflow run azure-deploy.yml --repo Dezoxy/jobs-fetcher --ref main -f operation=deploy
```

Both operations enforce the image-only plan guard. Infrastructure changes
continue through the reviewed operator plan/apply path in the
[migration runbook](azure-migration.md). No saved plan, state JSON or Terraform
configuration is uploaded as an Actions artifact. Logs contain the guard's
decision, image references and live verification; full plan output remains
only on the ephemeral runner. A plan failure deliberately suppresses the full
log, so reproduce it with operator login when detailed diagnostics are needed.

An operator plan must use the same reviewed inputs as CI, never a hand-kept
local `production.auto.tfvars`: Terraform auto-loads it, and a stale copy once
planned the removal of every `ANTHROPIC_FEDERATION_*` setting. Plan from a
clean worktree of `origin/main` with the reviewed variable as the only var file:

GitHub secrets cannot be read back. The readable operator copy of
`AZURE_TERRAFORM_VARS_JSON` is the blob `operator/terraform-vars.json` next to
the state, in the backend container. The operator already has data access there
(Entra auth), the GitHub deploy identity already holds the same values, and the
jobs' identities cannot read it. Keeping it out of the jobs' Key Vault matters
because the runner may read every secret in that vault. Change both copies
together.

```bash
git worktree add --detach /tmp/jd-op origin/main
cp infra/azure/backend.hcl /tmp/jd-op/infra/azure/
az storage blob download --auth-mode login --account-name "$(sed -n 's/^storage_account_name *= *"\(.*\)"/\1/p' infra/azure/backend.hcl)" \
  --container-name terraform-state --name operator/terraform-vars.json --file /tmp/jd-op/reviewed.tfvars.json --output none
chmod 600 /tmp/jd-op/reviewed.tfvars.json
terraform -chdir=/tmp/jd-op/infra/azure init -backend-config=backend.hcl -input=false -lockfile=readonly
terraform -chdir=/tmp/jd-op/infra/azure plan -input=false -var-file=../../reviewed.tfvars.json -out=/tmp/jd-op.tfplan
```

Review container `env` changes by name, not list index, then apply the saved
plan and remove the worktree, plan and var file.

## Azure identity and GitHub configuration

Configured on 2026-10-09: the dedicated Entra application
`jobs-dashboard-github` (client ID `d682264f-116d-4a32-9dd8-2be599c9d2e1`)
has no client secret or certificate. Its service principal has these scoped roles:

| Role | Scope | Purpose |
| --- | --- | --- |
| Contributor | `jobs-dashboard-westeurope` resource group | Update jobs and refresh runtime resource metadata |
| Reader | `jobs-dashboard-backups-westeurope` resource group | Refresh backup infrastructure metadata |
| Reader | `jobs-dashboard-terraform-westeurope` resource group | Inspect backend metadata |
| Reader | `jobs-dashboard-monthly` budget | Refresh the existing budget |
| Storage Blob Data Contributor | `sttoomjobstfweu/terraform-state` container | Read/write and lease Terraform state |

Runtime Contributor is broader than image-only writes; the Terraform guard
enforces the deployment limit. The identity has no subscription-wide
Contributor, role-assignment administration, Key Vault secret-value role or
application Blob data role. Terraform planning requires state locking, hence
the backend container's data-contributor role even for `operation=plan`.
This identity does not replace or reuse the runner, backup, digest or
homelab identities. The app registration and role assignments are bootstrap
configuration outside the application's Terraform stack, avoiding an identity
that could modify its own trust or grant itself additional roles.

Set these as **environment secrets** in GitHub's `azure-production` environment.
They are not credentials, but this repository is public and so are its Actions
logs: GitHub prints environment *variables* in each step's `env` header, and the
Terraform values include the alert e-mail and the subscription ID. Secrets are
masked in logs.

| Secret | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Dedicated application client ID |
| `AZURE_TENANT_ID` | Existing tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Existing subscription ID |
| `AZURE_TERRAFORM_BACKEND_JSON` | JSON with exactly `resource_group_name`, `storage_account_name`, `container_name`, `key` for the existing backend |
| `AZURE_TERRAFORM_VARS_JSON` | Reviewed Terraform input values, containing only nonsecret settings and Key Vault secret names; omit `image` |

The committed digest owns the image in both CI and operator runs. Remove any
`image` entry from ignored `production.auto.tfvars` or `.json` files. The helper
rejects image overrides, unreviewed fields and a different backend/subscription.
Terraform validates application settings. The backend uses Entra authentication
without storage keys; OIDC is selected by the workflow environment and operator
login remains usable locally.

Deployment helpers live in `.github/scripts/`, outside the container's verified
runtime source. Changing CI or the image pin does not introduce executable drift
into the current refresh image. Azure workloads and their state stay in West
Europe; GitHub and GHCR remain the code and image processors. The jobs hold no
registry credential. No Azure Container Registry or other billed service is added.

## GitHub credential inventory

GitHub Actions has no saved application secrets: Telegram credentials remain in
Azure Key Vault, and the obsolete manual GitHub Telegram sender has been removed.
The five `azure-production` environment secrets above are identity IDs and
Terraform configuration, kept as secrets only so public logs mask them. All five are required by this workflow; there
are no repository-level secrets or variables. `GITHUB_TOKEN` is generated automatically for
each Actions job with that job's permissions; it is not a manually stored secret.

The Azure workload holds one GitHub deploy key:

| Public deploy key | Azure private-key secret | Consumer |
| --- | --- | --- |
| read-only key on `Dezoxy/employee-cv` | `jobs-employee-cv-deploy-key` | The refresh fetches three CV files (`EMPLOYEE_CV_SSH_KEY`) |

The write-access `jobs-dashboard` deploy key and its `jobs-dashboard-deploy-key`
secret were removed in cutover step 4 on 2026-11-25: v2 neither clones this
repository nor publishes data commits. Neither key is used by Actions to connect
to Azure or push images. OIDC from GitHub to Azure does not replace
authentication in the reverse direction, from Azure jobs to private GitHub
repositories.

The migration pilot was retired on 2026-10-09 at the owner's request. Its Manual
job, identity, Blob container and role assignments are removed from Terraform.
The pilot deploy key and vault secret are removed after the reviewed retirement
apply. A protected local archive retains the four historical pilot-state blobs;
production state and backups are preserved.
