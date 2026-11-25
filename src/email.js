// LinkedIn job-alert ingestion (Email Routing → Worker email() handler).
//
// The only thing kept from a message is the set of numeric LinkedIn job ids
// it links to; they land in JOBS_DB.email_candidates and the next run fetches
// each ad through the guest detail endpoint like any other candidate. The
// body is never stored, forwarded or replied to.
//
// Trust: Email Routing evaluates SPF/DKIM/DMARC before invoking the Worker
// and PREPENDS its own `Authentication-Results: mx.cloudflare.net; …` header
// (developers.cloudflare.com/email-service/api/route-emails/email-handler/
// #authentication-results). Any other Authentication-Results or
// ARC-Authentication-Results header may come from the sender and is ignored.
// The deciding check is DMARC (aligned with the From domain), not a bare
// DKIM pass, which any domain can produce for itself.

export const MAX_EMAIL_BYTES = 512 * 1024; // LinkedIn alerts measure well under this
export const MAX_IDS_PER_EMAIL = 200;
const LINKEDIN = "linkedin.com";

const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

export const isLinkedInDomain = (d) => typeof d === "string" && (d === LINKEDIN || d.endsWith("." + LINKEDIN));

// From header → lower-case domain of its single address, or null. A display
// name cannot smuggle a domain: when angle brackets are present only the
// bracketed address counts, and more than one address is refused. ASCII-only
// lower-casing: Unicode folding would turn e.g. the Kelvin sign into "k".
export function fromDomain(fromHeader) {
  if (typeof fromHeader !== "string") return null;
  const angled = [...fromHeader.matchAll(/<([^<>]*)>/g)];
  let addr;
  if (angled.length === 1) addr = angled[0][1];
  else if (angled.length === 0) addr = fromHeader;
  else return null;
  addr = asciiLower(addr.replace(/^[ \t]+|[ \t]+$/g, ""));
  const m = /^[^\s@<>,;"]+@([a-z0-9.-]+)$/.exec(addr);
  return m ? m[1] : null;
}

// Parses the FIRST Authentication-Results header, which must have the
// authserv-id exactly "mx.cloudflare.net". Returns { ok: true, results:
// [{ method, result, props }] } or { ok: false, reason }.
//
// message.headers is a Fetch Headers object: repeated headers come back from
// get() joined with ", ". Cloudflare's header is prepended, so it is the
// prefix; everything from the first comma on may belong to a sender-supplied
// header and is dropped. Values inside Cloudflare's own header can echo
// sender-controlled text (e.g. smtp.mailfrom or the SPF comment), so the
// header is refused outright if it contains a quote, a backslash, unbalanced
// parentheses, or a ";" or "=" inside a (comment): the resinfo split below
// runs before comments are removed, so any of those could smuggle in a
// result such as "(x; dmarc=pass header.from=linkedin.com)". A comment
// containing a comma ends up unbalanced: refused too, never trusted.
// Cost of failing closed: an SRS envelope sender (a forward, "SRS0=…") in the
// SPF comment makes the message unverified.
export function parseCloudflareAuthResults(value) {
  if (typeof value !== "string" || value === "") return { ok: false, reason: "missing" };
  const head = /^[ \t]*mx\.cloudflare\.net[ \t]*;/i.exec(value);
  if (!head) return { ok: false, reason: "not_cloudflare" };
  let rest = value.slice(head[0].length);
  const comma = rest.indexOf(",");
  if (comma !== -1) rest = rest.slice(0, comma);
  if (/["\\]/.test(rest)) return { ok: false, reason: "unsafe" };
  let depth = 0;
  for (const ch of rest) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) break;
    else if (depth > 0 && (ch === ";" || ch === "=")) return { ok: false, reason: "unsafe" };
  }
  if (depth !== 0) return { ok: false, reason: "unsafe" };

  const results = [];
  for (const part of rest.split(";")) {
    const tokens = part.replace(/\([^()]*\)/g, " ").trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const mr = /^([a-z0-9_-]+)=([a-z0-9_-]+)$/i.exec(tokens[0]);
    if (!mr) continue;
    const props = Object.create(null);
    for (const t of tokens.slice(1)) {
      const p = /^([a-z0-9_.-]+)=(.+)$/i.exec(t);
      if (p) props[asciiLower(p[1])] = asciiLower(p[2]);
    }
    results.push({ method: asciiLower(mr[1]), result: asciiLower(mr[2]), props });
  }
  return { ok: true, results };
}

// Verified = at least one dmarc result, and every dmarc result is "pass" with
// a header.from property that is linkedin.com or a subdomain (a dmarc result
// without header.from does not count). The caller separately requires the
// From address itself to be LinkedIn's.
export function hasLinkedInDmarcPass(results) {
  if (!Array.isArray(results)) return false;
  const dmarc = results.filter((r) => r.method === "dmarc");
  return dmarc.length > 0 && dmarc.every(
    (r) => r.result === "pass" && isLinkedInDomain(r.props["header.from"]),
  );
}

// Verdict tokens for logs, e.g. "spf=pass dkim=pass dmarc=fail". No property
// values: those can carry addresses.
export const verdictTokens = (results) =>
  (Array.isArray(results) ? results.map((r) => `${r.method}=${r.result}`).join(" ") : "");

// Undo the two transfer encodings mail clients use for HTML bodies, enough
// for URL matching (no full MIME parse), in one linear pass:
//  - quoted-printable: drop soft line breaks, decode =3D;
//  - base64: a "Content-Transfer-Encoding: base64" line arms the scanner; the
//    body after the next blank line is the run of base64-only lines.
const B64_CTE = /^Content-Transfer-Encoding:[ \t]*base64[ \t]*$/i;
const B64_LINE = /^[A-Za-z0-9+/=]+$/;

export function decodeForLinks(raw) {
  const decoded = [raw.replace(/=\r?\n/g, "").replace(/=3D/gi, "=")];
  const lines = raw.split(/\r?\n/);
  let armed = false;
  for (let i = 0; i < lines.length; i++) {
    if (B64_CTE.test(lines[i])) { armed = true; continue; }
    if (!armed || lines[i] !== "") continue;
    armed = false;
    let j = i + 1;
    while (j < lines.length && B64_LINE.test(lines[j])) j++;
    if (j > i + 1) {
      try {
        decoded.push(atob(lines.slice(i + 1, j).join("")));
      } catch {
        // not valid base64 after all: ignore this part
      }
    }
    i = j - 1;
  }
  return decoded.join("\n");
}

// https://(www.|xx.)linkedin.com/jobs/view/<digits> and /comm/jobs/view/<digits>
// only. Digits must end the path segment, so slugs like /jobs/view/123-foo
// and look-alike hosts (evillinkedin.com, linkedin.com.evil.net) never match.
const JOB_LINK = /https:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/(?:comm\/)?jobs\/view\/([1-9]\d{0,19})(?![\w-])/gi;

export function extractLinkedInJobIds(raw) {
  const ids = new Set();
  for (const m of decodeForLinks(raw).matchAll(JOB_LINK)) {
    ids.add(m[1]);
    if (ids.size >= MAX_IDS_PER_EMAIL) break;
  }
  return [...ids];
}

// One statement, two parameters: the timestamp and the id list as JSON.
export const INSERT_CANDIDATES_SQL =
  "INSERT OR IGNORE INTO email_candidates (id, received_at) " +
  "SELECT 'li-' || value, ?1 FROM json_each(?2)";
