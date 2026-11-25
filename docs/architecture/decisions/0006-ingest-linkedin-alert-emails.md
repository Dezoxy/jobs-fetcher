# 6. Ingest LinkedIn alert e-mails, DMARC-verified, and not No Fluff Jobs

Date: 2026-11-25

## Status

Accepted

The LinkedIn part was an owner decision of 2026-11-24 and is live with v2. The
owner decided on 2026-11-25 not to add the same for No Fluff Jobs.

## Context

LinkedIn is collected over its guest search endpoints, sessionless, with a
26-hour window. A query that hits the endpoint's 100-result ceiling drops ads
inside the window, and the README states that the window does not guarantee
complete LinkedIn coverage. LinkedIn's own job-alert e-mails list matching ads
as links that carry the job id.

No Fluff Jobs is different: its listing has no result cap, so the collector
already sees every ad that matches.

An inbound e-mail handler is a new internet-facing input. Anyone can send mail
to the address, and the `From` header is free text.

## Decision drivers

- Catch LinkedIn ads the guest search misses.
- Accept nothing that LinkedIn did not demonstrably send.
- Never bounce real LinkedIn mail, or LinkedIn may disable the address.
- Store no mail content.

## Considered options

1. No e-mail ingestion.
2. Ingest LinkedIn alert e-mails through Cloudflare Email Routing.
3. Option 2, plus No Fluff Jobs alert e-mails.

## Decision

Option 2 ([contract](../../architecture-v2.md#alert-e-mail-ingestion-email)).
Email Routing delivers mail for a subdomain address to the Worker's `email()`
handler:

1. The `From` header must be one address at `linkedin.com` or a subdomain;
   anything else is rejected.
2. Only the first `Authentication-Results`, and only with authserv-id
   `mx.cloudflare.net`, is read; a header with quotes, backslashes, unbalanced
   parentheses or `;`/`=` inside a comment is refused. Every `dmarc` result must
   be `pass` with `header.from` at LinkedIn. DKIM alone does not count.
3. Mail that claims LinkedIn but fails verification is dropped and logged, not
   rejected, so a spoofer learns nothing and a header-format change cannot
   bounce real alerts.
4. At most 512 KB of the raw message is read; only `https` LinkedIn
   `jobs/view/<digits>` links count, at most 200 ids, inserted with
   `INSERT OR IGNORE` into `email_candidates`. The body is never stored or
   answered.
5. Amended 2026-11-25: when the `FORWARD_TO` Worker secret is set, every
   message that passed steps 1 and 2 is forwarded untouched to that verified
   Email Routing destination after step 4, with or without job links. Mail
   that fails step 2 is never forwarded: linkedin.com enforces DMARC, so it is
   almost certainly a spoof, and relaying it would deliver phishing to the
   owner. A forward failure is logged with addresses redacted and never thrown.
   Every event that can lose a message (`email_forward_failed`,
   `email_forward_skipped`, `email_ingest_failed`, `email_store_failed`) is
   logged at error level; Workers Issues groups it and a Cloudflare
   notification policy e-mails the owner. The raw message is drained, not
   cancelled, past the 512 KB read cap, so `forward()` always follows a fully
   read stream, the state verified in production on 2026-11-25.

The runner fetches each new id's guest detail page and treats it like any other
candidate. An id is consumed once decided, or after 7 days.

Option 3 is rejected: with no result cap on the No Fluff Jobs listing, its
alerts would add no ads the collector does not already see.

## Consequences

Positive:

- LinkedIn ads beyond the search ceiling reach the judge.
- The handler can only add ids; the runner still judges every candidate.

Negative / accepted trade-offs:

- A forwarded alert fails verification (the SPF comment carries an SRS sender)
  and is not ingested. Alerts must arrive directly, and LinkedIn sends job
  alerts only to the account's primary e-mail, so the alert address (kept
  out of this public repo) is the LinkedIn primary. Step 5 keeps the
  owner's other LinkedIn mail (recruiter InMail notices, security notices)
  reaching their inbox.
- The handler depends on Email Routing's header format; a change shows as
  `email_unverified` log lines, not as an error.
- One more inbound path into the Worker, covered in the
  [threat model](../security/threat-model.md).

## Risks

- None tracked.

## Related

- Architecture views: Access.
- Other ADRs: [5](0005-verify-access-jwt-in-worker.md).
