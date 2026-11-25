## Threat model: Worker endpoints and runner credentials

### Scope and status

This covers the Worker's three entry points (`/data/*`, `/api/tracker`,
`email()`), the refresh runner's credentials and what the runner does with
untrusted ad text. It is a STRIDE pass over the code and configuration on
`main` after the v2 switch (observed implementation and declared
configuration), read from the files named below. It is not a penetration test,
and Cloudflare Access's own policy lives in the separate Cloudflare Terraform
repository, which was not read. The design assumes one owner and no other
users.

### Assets

| Asset | Why it matters |
|---|---|
| The job list (`jobs.json`) | Shows where the owner is applying while employed. Must never be public. |
| The tracker | The owner's statuses per job; cannot be recollected. |
| Job data in D1 | Verdict ledger and run history; recoverable from Time Travel (7 days) and the nightly export (30 days). |
| Runner credentials | One account-wide Cloudflare D1+KV token, the CV deploy key, the Claude OAuth token, the Telegram bot token and chat id, the GHCR pull token. |
| The owner's target roles and salary benchmarks | Private files from `employee-cv`, sent to Claude as the judge's context. |

### Trust boundaries

| ID | Boundary | Who crosses it | Check |
|---|---|---|---|
| B1 | Internet to the dashboard hostname | The owner's browser | Cloudflare Access sign-in; for `/data/*` and `/api/*` also the Worker's JWT check ([ADR 5](../decisions/0005-verify-access-jwt-in-worker.md)) |
| B2 | Internet mail to `email()` | Anyone who sends to the alert address | Email Routing's DMARC verdict, parsed by `src/email.js` ([ADR 6](../decisions/0006-ingest-linkedin-alert-emails.md)) |
| B3 | Portal pages to the runner and the judge | Job portals, and whoever writes an ad | Collectors get no secrets; the judge has no tools ([ADR 4](../decisions/0004-tool-less-json-schema-judge.md)) |
| B4 | Key Vault to the jobs | The two Container Apps Jobs | Managed identity per job, Key Vault RBAC |
| B5 | GitHub to Azure | `azure-deploy.yml` on `main` | OIDC subject pinned to the `azure-production` environment; image-only plan guard |

### Threats

IDs are stable; each row names its boundary.

| ID | Boundary | STRIDE | Threat | Mitigation today | Residual |
|---|---|---|---|---|---|
| T-01 | B1 | Spoofing, Information disclosure | A request reaches the Worker without passing Access (a `workers.dev` or preview URL, a new route, a policy mistake) | `workers_dev` and `preview_urls` are `false`; every `/data/*` and `/api/*` request needs a valid RS256 assertion for this application's `aud` and an allowlisted identity, else 403 (`ACCESS_ENFORCE=enforce`) | The static UI files are served without the Worker; Access is their only lock. They hold no job data. Until 2026-11-24 the bypass URLs served the list publicly. |
| T-02 | B1 | Elevation | A valid Access identity that is not the owner reads or writes data | `OWNER_EMAILS` allowlist, ASCII-only comparison (a non-ASCII address never matches); service tokens are limited to `RUNNER_CLIENT_ID` and to `GET /data/*` and `GET /api/tracker` | The runner allowance is unused since v2 (the runner reads D1 directly); it stays until the v1 retirement. |
| T-03 | B1 | Tampering | A cross-site page makes the owner's browser replace the tracker | `PUT` requires `Content-Type: application/json` (forces a preflight) and, when sent, an `Origin` equal to the dashboard's | None identified. |
| T-04 | B1 | Denial of service, Tampering | An oversized or malformed tracker body | 512 KB cap in bytes, checked on `Content-Length` and while reading; shape check; one atomic batch; 503 until the import sentinel exists | `PUT` replaces the whole map; the client merge rule (never PUT before a successful GET) is load-bearing (`public/app.js`). |
| T-05 | B1 | Repudiation, Information disclosure | Logs leak a token, an address or a claim | `access_denied` lines carry a principal category, reason, method and path only | None identified. |
| T-06 | B2 | Spoofing | Forged mail claims to be a LinkedIn alert | `From` must be LinkedIn; only the first `Authentication-Results` from `mx.cloudflare.net` is read, refused on quotes, backslashes, unbalanced or `;`/`=`-carrying comments; every DMARC result must pass with `header.from` at LinkedIn; DKIM alone is not enough | Fails closed on forwarded mail (SRS sender). An attacker who passes LinkedIn's DMARC can only add job ids, which the runner then fetches from LinkedIn and judges. |
| T-07 | B2 | Denial of service | Mail flood or a huge message | At most 512 KB read, one linear decode pass, at most 200 ids, `INSERT OR IGNORE`; unverified mail is never ingested or bounced; with `FORWARD_TO` set, only DMARC-verified LinkedIn mail is forwarded (one forward each), so spoofs are never relayed | Email Routing's own limits apply; not measured here. |
| T-08 | B3 | Elevation, Tampering | Prompt injection in an ad's text | The judge runs with `--tools ""`, no MCP servers, a JSON schema and an empty working directory; candidates are a JSON block with `<`/`>` escaped; code validates every field; Telegram text is HTML-escaped | An ad can steer its own verdict, description or estimated salary. The impact stays inside the owner's list and digest. |
| T-09 | B3 | Elevation, Information disclosure | Code execution in a collector parsing a hostile page | Collectors run on a temp copy with materialised inputs and a minimal environment, without Cloudflare or Telegram secrets (`scripts/v2/run.mjs`) | They run as the same OS user in the same container as the runner, so environment isolation is not a hard boundary against code execution there. |
| T-10 | B4 | Elevation | The Cloudflare token is stolen | Held in Key Vault as `jobs-cloudflare-api-token`, resolved into the refresh and backup jobs only | The token has D1 Edit and Workers KV Storage Edit for the whole Cloudflare account, not for these two databases and one namespace. Theft allows reading, changing or deleting any D1 database or KV namespace in the account. |
| T-11 | B4 | Information disclosure | The CV deploy key, the Claude OAuth token or the Telegram bot token is stolen | Key Vault, resolved through the runner identity; the deploy key is written to a 0600 file in a 0700 temp directory and deleted after the fetch, and `run.mjs` never receives it; collectors receive none of these; the judge passes the OAuth token only to its `claude` process | Telegram chats are not end-to-end encrypted; the digest names companies (accepted in the README). |
| T-12 | B4 | Information disclosure | Private CV context leaves the system | Only `target-roles.md` and `salary-benchmarks.md` are read, and only sent to Claude as the judge's context | They are processed by Anthropic under the subscription or API terms. |
| T-13 | B5 | Elevation, Tampering | The automatic deploy changes more than the image | Saved plan; `azure_release_guard.py` accepts only an in-place image change of both jobs; OIDC subject limited to the `azure-production` environment, which allows only `main` | The deploy identity holds Contributor on the runtime resource group; the guard, not the role, enforces the limit ([azure-image-deployment.md](../../azure-image-deployment.md)). |

### Open points

- The runner's service-token allowance (T-02) and the v1 tracker credentials
  in Key Vault outlive their use until cutover step 4.
- A Cloudflare token scoped to the two databases and the namespace would shrink
  T-10. Whether the API allows that for D1 was not checked here.
