# 3. Keep the tracker in its own D1 database

Date: 2026-11-24

## Status

Accepted

Live since the v2 switch on 2026-11-24. The v1 `TRACKER` KV namespace stays
bound and untouched as the recovery copy until 30 days after the cutover.

## Context

The tracker is the owner's own record per job: saved, applied, interview,
offer, rejected or ignored, with a timestamp. Since 2026-08-07 it has synced
across devices through `GET/PUT /api/tracker`; in v1 it was one KV blob. It is
the only data in the system that a person writes, and it cannot be recollected
from the portals.

D1 recovery works per database: Time Travel and an imported export both put a
whole database back to a point in time. Job data may need such a restore after
a bad run. The tracker should not move back with it.

A browser that has synced before reads an empty map as "deleted on another
device". An empty or half-imported tracker served as the truth would therefore
wipe local entries.

## Decision drivers

- Restoring job data must never rewind the owner's clicks.
- An uninitialised tracker must never be served as an empty one.
- Keep v1's JSON contract so the page needs no new protocol.

## Considered options

1. A `tracker` table inside `jobs-data`.
2. Keep the v1 KV blob.
3. A separate D1 database, `jobs-tracker`.

## Decision

Option 3 ([schema](../../architecture-v2.md#d1-jobs-tracker-schema-migrationstracker)).
One row per job id with `CHECK`s that mirror the Worker's shape check, plus a
`meta` table. The one-off import writes `meta.tracker_imported` as its last
step; until that row exists, and on any D1 error, both tracker routes answer
503. `GET` lets SQLite build the `{ [id]: {st, at} }` document; `PUT` replaces
the whole map in one batch. The page never PUTs before it has merged with a
successful GET in the same page load.

Option 1 fails the first driver. Why the owner preferred D1 over keeping the
KV blob (option 2) is not recorded beyond moving all data to D1
([ADR 2](0002-d1-data-plane-github-code-only.md)).

## Consequences

Positive:

- Job data and the tracker can be restored independently.
- The runner reads tracker statuses in the same way as the rest of its state,
  through the D1 API, instead of through the Worker with a service token.

Negative / accepted trade-offs:

- Two databases to migrate, back up and restore. The nightly export carries
  both in one file.
- `PUT` replaces the whole map, so the client-side merge rule is load-bearing.
- A tracker that is down shows as offline in the page, not as an error.

## Risks

- None tracked beyond the restore exercise noted in
  [ADR 2](0002-d1-data-plane-github-code-only.md).

## Related

- Architecture views: Containers, Access.
- Other ADRs: [2](0002-d1-data-plane-github-code-only.md).
