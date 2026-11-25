# 9. Move the code to a public jobs-fetcher repository

Date: 2026-11-25

## Status

Accepted

Replaces the private `Dezoxy/jobs-dashboard` repository as the code and control
plane. That repository stays private and read-only as the archive.

## Context

Private repositories share 2,000 GitHub Actions minutes a month; public
repositories run on standard runners for free. Making `jobs-dashboard` public
was not safe. Its history holds the owner's job hunt: several hundred commits
of `jobs.json` with saved jobs and AI gap analyses, and commits under a
personal author e-mail. A history rewrite would not remove them, because
GitHub keeps pull request refs to the old commits.

Since v2 (ADR 2) the repository holds code only. The job data lives in D1/KV,
the secrets in Azure Key Vault, and the owner's facts (location, known gaps,
salary floor) in the private `employee-cv` repository's
`profile/judge-profile.md`. The refresh reads that file as `<owner_profile>`
and fails closed when its required lines are missing.

## Decision

- Start `Dezoxy/jobs-fetcher` as a public repository from one commit: a
  snapshot of `jobs-dashboard` `main` after the personal data was moved out
  (jobs-dashboard PRs #79 and #80). The snapshot was scanned for secrets
  (gitleaks) and personal data before the first push.
- Publish the refresh image as `ghcr.io/dezoxy/jobs-fetcher`, a new package
  with its own CalVer tag space starting at `v2026.11.0`. The image carries
  `org.opencontainers.image.source`, which links the package to this
  repository so Renovate can read it.
- Keep every Azure, Cloudflare, D1, KV and Worker resource name
  (`jobs-dashboard*`). Only the repository and the image move.
- Store the five `azure-production` values as environment secrets, not
  variables. Public logs print variable values; secrets are masked.
- Protect `main` with a ruleset: pull requests only, required checks, no force
  push or deletion. The `azure-production` environment accepts only `main`,
  and Azure trusts only this repository's `main` environment subject.
- Require approval before Actions runs for outside contributors. Keep
  `GITHUB_TOKEN` read-only by default, with write permissions granted per job.
  Turn on secret scanning with push protection and private vulnerability
  reporting.

## Consequences

- The Actions minutes are free, and the old history stays private.
- Until the first `jobs-fetcher` pin, the validators (`variables.tf`,
  `azure_release_guard.py`) accept both package names. The deploy binding
  check already requires `jobs-fetcher`, because a release tag must exist in
  this repository. Once the pin moves, narrow the validators to
  `jobs-fetcher`.
- The image-pin freshness check fails six hours after the first
  `jobs-fetcher` release, until that first pin is merged. That is the
  intended signal.
- GitHub secrets cannot be read back. The readable operator copy of the
  Terraform values stays in the archive repository's environment variables.
  It must be updated together with this repository's secrets.
- Pull request links written before the move (`jobs-dashboard PR #NN`) point
  to the private archive.
