# 8. Release by tag, deploy by a Renovate pin bump through the guard

Date: 2026-11-25

## Status

Accepted

Implemented in jobs-dashboard PR #67 on 2026-11-25
([image deployment](../../azure-image-deployment.md)).

## Context

The refresh image runs as two Container Apps Jobs
([ADR 1](0001-run-refresh-as-azure-container-apps-job.md)). What runs is set by
`infra/azure/image.auto.tfvars.json`, applied by Terraform. The current chain
has a bot commit that pin to `main` with `GITHUB_TOKEN`, and because such a
push starts no workflow, call the deploy workflow explicitly. That is one more
writer on `main` that bypasses pull requests, and a different path from the
sibling projects, where Renovate proposes the pin.

Infrastructure changes (schedules, identities, environment, secrets) need a
reviewed operator plan and apply, never the automatic path.

## Decision drivers

- Every change to what runs in production is a reviewed, CI-checked commit on
  `main`.
- The automatic path can change the image and nothing else.
- A deploy never interrupts or overlaps a run.
- Terraform deploys a reference proven to work in Container Apps.

## Considered options

1. Keep the bot commit and the direct deploy call.
2. Release by tag; Renovate opens the pin pull request, which automerges after
   CI; the push to `main` triggers the guarded deploy.

## Decision

Option 2:

1. A merge that changes the image's inputs runs `auto-release.yml`: after a
   30-minute batch window that a newer merge restarts (amended 2026-11-25, so
   a merge session produces one release and one deploy), the full
   validation workflow, then the next CalVer tag and its GitHub release
   ([ADR 7](0007-calendar-versioning.md)), then `release.yml` builds and pushes
   the image to private GHCR.
2. Renovate opens a pull request that bumps both fields of
   `image.auto.tfvars.json`: `image`, the digest-only
   `ghcr.io/dezoxy/jobs-fetcher@sha256:…` reference Terraform deploys, and
   `image_version`, the release tag Renovate tracks. Terraform keeps the
   digest-only reference because Container Apps' acceptance of
   `name:tag@digest` is unverified.
3. The pin pull request automerges after CI, at any time of day. The pin rule
   in `renovate.json` has no schedule, a minimum release age of 0 days and
   `allowedVersions` limited to CalVer.
4. The push to `main` triggers `azure-deploy.yml`. It first binds the pin: tag
   `v<image_version>` must be on `main`, and the GHCR tag `<image_version>`
   must resolve to the pinned digest. It makes a saved plan over OIDC, and
   `.github/scripts/azure_release_guard.py` accepts it only if it is a pure
   in-place image change of both jobs. It then waits until neither job is
   running and none is due within ten minutes, checks that a newer pin has not
   superseded this one, applies the saved plan and verifies the live image of
   each job.
5. `pin-freshness.yml` fails every three hours, and GitHub e-mails the owner,
   while the newest release has stayed unpinned for more than six hours.

Infrastructure changes go through the operator plan and apply path
([migration runbook](../../azure-migration.md)).

## Consequences

Positive:

- No bot writes to `main` outside a pull request.
- The same release-then-pin flow as notification-digest.
- The guard limits the automatic path to the image, whatever else a plan would
  change.

Negative / accepted trade-offs:

- A release reaches production only after Renovate's next run and the pin
  pull request's CI, not right after the build.
- The deploy identity holds Contributor on the runtime resource group, broader
  than an image update; the guard, not the role, enforces the limit.
- The deployed reference carries no tag, so the version is read from
  `image_version` next to it.

## Risks

- Renovate's run frequency decides how fast a release deploys; the freshness
  check catches a release that never gets pinned.
- `main` and tags are unprotected: rulesets need a paid plan for a private
  repository. Someone who can push could move a tag between the binding check
  and the apply. Accepted in jobs-dashboard PR #67.
- Rollback is a reviewed pull request that edits both pin fields, plus an
  `allowedVersions` cap on the pin rule so Renovate does not bump it straight
  back.

## Related

- Architecture views: Delivery.
- Other ADRs: [1](0001-run-refresh-as-azure-container-apps-job.md),
  [7](0007-calendar-versioning.md).
