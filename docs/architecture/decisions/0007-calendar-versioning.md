# 7. Number releases by calendar (vYYYY.M.N)

Date: 2026-11-25

## Status

Accepted

Merged in jobs-dashboard PR #56 on 2026-11-25. The next release is `v2026.11.0`; the last
semver release is `v1.0.11`.

## Context

Every merge that changes the refresh image's inputs creates a release:
`auto-release.yml` tags the commit and `release.yml` builds and pushes
`ghcr.io/dezoxy/jobs-dashboard:<version>`. The tags were `v1.0.N`. The number
said nothing about when a build was made, and nothing parses it except the
release tag check (`vX.Y.Z`, no leading zeros).

notification-digest and Flodni already number releases `vYYYY.M.N`.

## Decision drivers

- A version that tells the reader when the image was built.
- The same scheme in every repository the owner runs.
- Still a valid `vX.Y.Z`, so the tag check and tools that sort versions keep
  working.
- No judgement call per release.

## Considered options

1. Keep counting `v1.0.N`.
2. `vYYYY.M.N`, as notification-digest and Flodni.

## Decision

Option 2, computed by
[next_release_version.py](../../../.github/scripts/next_release_version.py):

- `YYYY` and `M` are the UTC year and month of the release, the month without
  a leading zero (`v2026.1.0`, never `v2026.01.0`).
- `N` counts releases in that month from 0 and resets each month.
- The next tag is the highest valid tag with `N` plus one, but never below
  `vYYYY.M.0` for the current month. So the `v1.0.x` tags sort below the floor
  and need no bootstrap tag, a hand-pushed tag is continued from, and a clock
  behind the latest tag never moves the version backwards.
- A retried release reuses the version tag already on its commit.

## Consequences

Positive:

- The build month is in the tag, the GitHub release and the image tag.
- No change to `release.yml`'s tag check or the image naming.

Negative / accepted trade-offs:

- The number no longer says whether a release is breaking. Nothing outside
  this repository consumes the image, so nothing depends on that signal.
- The step from `v1.0.11` to `v2026.11.0` is a semver major jump, once.

## Risks

- None tracked.

## Related

- Architecture views: Delivery.
- Other ADRs: [8](0008-release-by-tag-deploy-by-renovate-pin.md).
