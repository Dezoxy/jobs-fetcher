# 5. Verify the Access JWT in the Worker as a second lock

Date: 2026-11-24

## Status

Accepted

Deployed in `log` mode with v2 (jobs-dashboard PR #47) and switched to `ACCESS_ENFORCE=enforce`
at the v2 switch on 2026-11-24 (jobs-dashboard PR #55).

## Context

The job list shows where the owner is applying while employed; it must never
be public. Cloudflare Access in front of the custom hostname is the primary
control, managed in the separate Cloudflare Terraform repository.

Access protects a hostname, not a Worker. Until 2026-11-24 the default
`*.workers.dev` and preview URLs reached the same Worker without Access and
served the job list and the tracker to anyone. Any future route, preview or
misconfigured policy would do the same, and nothing in the Worker would notice.

## Decision drivers

- Access stays the primary control; the Worker must not trust that every
  request came through it.
- Only the owner, and the runner's service token for reads, may get data.
- The check must not lock the owner out on a key rotation or a short outage of
  the certificate endpoint.
- Never log a token, an e-mail address or a claim value.

## Considered options

1. Rely on Access alone and disable the bypass URLs.
2. Disable the bypass URLs and also verify the Access assertion in the Worker
   for every route that returns data.

## Decision

Option 2. `wrangler.jsonc` sets `workers_dev: false` and `preview_urls: false`
and sends `/data/*` and `/api/*` through the Worker first. On each such request
`src/access.js`:

1. verifies `Cf-Access-Jwt-Assertion`: RS256 against the team's certificate
   endpoint (cached 1 h, an unknown `kid` refetches at most every 30 s, a
   failed refresh keeps the previous keys), `iss`, `aud` containing
   `ACCESS_AUD`, and `exp`/`nbf` with 60 s skew;
2. allowlists the identity: a browser needs an `email` listed in the
   `OWNER_EMAILS` secret (ASCII-only comparison); a service token needs
   `common_name` equal to the `RUNNER_CLIENT_ID` secret and may only
   `GET /data/*` and `GET /api/tracker`;
3. logs a failure as one `access_denied` line with a principal category, never
   the token or the address, and returns 403. `ACCESS_ENFORCE=log` only logs;
   any other value enforces.

`PUT /api/tracker` also requires `Content-Type: application/json`, an `Origin`
equal to the dashboard's own when one is sent, and at most 512 KB in bytes.

## Consequences

Positive:

- A request that bypasses Access by any route gets 403 from the data routes.
- The first deploy could be watched in `log` mode before enforcing.

Negative / accepted trade-offs:

- The static UI files are served without running the Worker, so Access remains
  their only lock. They hold no job data.
- Both secrets must be set before enforcing; an unset one locks that caller out.
- `wrangler dev` on localhost cannot PUT the tracker (the `Origin` check).
- The Worker depends on the Access certificate endpoint; stale keys are kept
  on a refresh failure.

## Risks

- The runner allowance is unused since v2: the runner reads D1 directly. It
  stays until the v1 retirement (see the [threat model](../security/threat-model.md)).

## Related

- Architecture views: Access.
- Other ADRs: [3](0003-tracker-in-its-own-d1-database.md),
  [6](0006-ingest-linkedin-alert-emails.md).
