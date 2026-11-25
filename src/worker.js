// jobs-dashboard Worker, v2 (docs/architecture-v2.md is the contract).
//
// Routes that reach this script (wrangler.jsonc run_worker_first):
//   GET  /data/jobs.json, /data/last-run.json  SNAPSHOT KV (written by each v2 run)
//   GET  /data/version.json                     this Worker's deployed version (footer)
//   GET  /api/tracker                           TRACKER_DB → { [id]: { st, at } }
//   PUT  /api/tracker                           replace the whole map (owner only)
//   email()                                     LinkedIn alert → JOBS_DB.email_candidates
// Every other path is served by the assets layer before this code runs.
//
// Every fetch first passes checkAccess(): Cf-Access-Jwt-Assertion verified
// (RS256, iss, aud, exp/nbf), then the owner/runner allowlist. Access on the
// hostname remains the primary control; this is the second lock.

import { checkAccess, makeKeyStore } from "./access.js";
import { readCapped } from "./body.js";
import {
  DELETE_ALL_SQL, INSERT_FROM_JSON_SQL, MAX_BYTES, READY_SQL, SELECT_DOC_SQL, sanitize,
} from "./tracker.js";
import {
  INSERT_CANDIDATES_SQL, MAX_EMAIL_BYTES, extractLinkedInJobIds, fromDomain,
  hasLinkedInDmarcPass, isLinkedInDomain, parseCloudflareAuthResults, verdictTokens,
} from "./email.js";

const SITE_ORIGIN = "https://jobs.toomhorvath.com";
const SNAPSHOT_KEYS = new Map([
  ["/data/jobs.json", "jobs.json"],
  ["/data/last-run.json", "last-run.json"],
]);

const NO_STORE = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: NO_STORE });
const log = (fields) => console.log(JSON.stringify(fields));
// Error level is what Workers Issues detects (observability.issues in
// wrangler.jsonc), and the account's Issues notification e-mails the owner.
// Used only where an e-mail to the LinkedIn primary address could be lost.
const logError = (fields) => console.error(JSON.stringify(fields));

// Module scope = one JWKS cache per isolate, rebuilt only if the team changes.
let keyStore = null;
let keyStoreTeam = null;
function getKeyFor(team) {
  if (!keyStore || keyStoreTeam !== team) {
    keyStore = makeKeyStore(`https://${team}/cdn-cgi/access/certs`);
    keyStoreTeam = team;
  }
  return keyStore;
}

// The version_metadata binding: the tag is the short commit when deployed by
// scripts/cf-deploy.sh; any other tag is dropped. Null fields when unbound
// (wrangler dev, tests) or deployed without a tag.
const COMMIT = /^[0-9a-f]{7,40}$/;
export function webVersion(meta) {
  return {
    commit: COMMIT.test(meta?.tag ?? "") ? meta.tag : null,
    deployedAt: typeof meta?.timestamp === "string" && meta.timestamp ? meta.timestamp : null,
  };
}

async function serveData(request, env, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
  if (pathname === "/data/version.json") return json({ web: webVersion(env.CF_VERSION_METADATA) });
  const key = SNAPSHOT_KEYS.get(pathname);
  if (!key) return json({ error: "not found" }, 404);
  // Streamed straight through: the 1.5 MB list is never parsed here
  // (Free-plan CPU is 10 ms per request).
  const body = await env.SNAPSHOT.get(key, "stream");
  if (body === null) {
    // Every v2 run re-puts both keys, and public/data is gone (cutover step 4),
    // so a missing key is an outage to see in Workers Logs, not a 404 to hide.
    log({ event: "snapshot_missing", key });
    return json({ error: "snapshot unavailable" }, 503);
  }
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// 503 until the import has written the meta sentinel, and on any D1 error
// (e.g. a missing table): the client treats non-200 as "offline" and keeps
// its local copy, which is exactly right for both.
const notReady = () => json({ error: "tracker not initialised" }, 503);

async function getTracker(env) {
  let row;
  try {
    row = await env.TRACKER_DB.prepare(SELECT_DOC_SQL).first();
  } catch (e) {
    log({ event: "tracker_unavailable", op: "get", error: String(e?.message ?? e).slice(0, 200) });
    return notReady();
  }
  if (!row?.ready) return notReady();
  return new Response(row.doc ?? "{}", { headers: NO_STORE });
}

async function putTracker(request, env) {
  // CSRF hardening on top of Access: a cross-site form or fetch cannot set
  // this content type without a preflight, and a browser always sends Origin
  // on a PUT. (Consequence: `wrangler dev` on localhost cannot PUT.)
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== SITE_ORIGIN) return json({ error: "forbidden origin" }, 403);
  const ct = request.headers.get("content-type") ?? "";
  if (!/^application\/json[ \t]*(?:;|$)/i.test(ct)) return json({ error: "content-type must be application/json" }, 415);

  // The cap is in bytes: refuse on Content-Length before reading, then read
  // at most MAX_BYTES and refuse if more was sent (chunked or lying bodies).
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BYTES)) return json({ error: "too large" }, 413);
  const { text, truncated } = await readCapped(request.body, MAX_BYTES);
  if (truncated) return json({ error: "too large" }, 413);
  let raw;
  try { raw = JSON.parse(text); } catch { return json({ error: "invalid JSON" }, 400); }
  const clean = sanitize(raw);
  if (!clean) return json({ error: "invalid tracker shape" }, 400);

  try {
    if (!(await env.TRACKER_DB.prepare(READY_SQL).first())) return notReady();
  } catch (e) {
    log({ event: "tracker_unavailable", op: "put", error: String(e?.message ?? e).slice(0, 200) });
    return notReady();
  }
  // One batch = one transaction: readers never see a half-replaced table.
  await env.TRACKER_DB.batch([
    env.TRACKER_DB.prepare(DELETE_ALL_SQL),
    env.TRACKER_DB.prepare(INSERT_FROM_JSON_SQL).bind(JSON.stringify(clean)),
  ]);
  return json({ ok: true, entries: Object.keys(clean).length });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    const gate = await checkAccess(request, env, getKeyFor(env.ACCESS_TEAM));
    if (!gate.allowed) return json({ error: "forbidden" }, 403);

    if (pathname.startsWith("/data/")) return serveData(request, env, pathname);

    if (pathname === "/api/tracker") {
      if (request.method === "GET") return getTracker(env);
      if (request.method === "PUT") return putTracker(request, env);
      return json({ error: "method not allowed" }, 405);
    }

    // Any other path that reached the script: same 404-page behaviour as
    // the assets layer.
    return env.ASSETS.fetch(request);
  },

  async email(message, env) {
    // Header From, not the envelope: LinkedIn's envelope sender is a bounce
    // subdomain, and a forwarded alert carries the forwarder's. Authenticity
    // comes from Cloudflare's DMARC verdict below, not from either address.
    if (!isLinkedInDomain(fromDomain(message.headers.get("from")))) {
      log({ event: "email_rejected", reason: "sender" });
      message.setReject("Sender not accepted");
      return;
    }
    // Claims to be LinkedIn but is not verified: neither ingested nor
    // forwarded, and not bounced. A reject would tell a spoofer what passes,
    // and bouncing a real LinkedIn alert (if Cloudflare's header format ever
    // changes) risks LinkedIn disabling the address. linkedin.com enforces
    // DMARC, so direct LinkedIn mail passes; forwarding failures would relay
    // spoofs into the owner's inbox.
    const auth = parseCloudflareAuthResults(message.headers.get("authentication-results"));
    if (!auth.ok || !hasLinkedInDmarcPass(auth.results)) {
      log({
        event: "email_unverified",
        reason: auth.ok ? "dmarc" : auth.reason,
        verdicts: auth.ok ? verdictTokens(auth.results) : "",
      });
      return;
    }
    // Ingestion never throws (a throw bounces the message back to LinkedIn)
    // and never prevents the forward, so verified mail without job links
    // (recruiter InMail notices, security notices) still reaches the owner.
    try {
      await ingestAlert(message, env);
    } catch (e) {
      logError({ event: "email_ingest_failed", error: redactAddresses(e) });
    }
    await forwardCopy(message, env);
  },
};

// FORWARD_TO is a Worker secret (the owner's inbox, a verified Email Routing
// destination). Unset means ingest only, the behaviour before forwarding.
async function forwardCopy(message, env) {
  if (!env.FORWARD_TO) return;
  if (message.canBeForwarded === false) {
    logError({ event: "email_forward_skipped", reason: "not_forwardable" });
    return;
  }
  try {
    await message.forward(env.FORWARD_TO);
    log({ event: "email_forwarded" });
  } catch (e) {
    logError({ event: "email_forward_failed", error: redactAddresses(e) });
  }
}

// Logs never carry an address: error text from the platform may name the
// destination or the sender.
const redactAddresses = (e) =>
  String(e?.message ?? e).replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, "<address>").slice(0, 200);

// Called only for verified LinkedIn mail.
async function ingestAlert(message, env) {
  const { text, truncated } = await readCapped(message.raw, MAX_EMAIL_BYTES, { drain: true });
  const ids = extractLinkedInJobIds(text);
  if (ids.length === 0) {
    // A genuine LinkedIn mail without job links (e.g. a notice): nothing to
    // ingest. It is still forwarded when FORWARD_TO is set.
    log({ event: "email_no_ids", size: message.rawSize, truncated });
    return;
  }
  let res;
  try {
    res = await env.JOBS_DB.prepare(INSERT_CANDIDATES_SQL)
      .bind(new Date().toISOString(), JSON.stringify(ids))
      .run();
  } catch (e) {
    // Never throw from here: a throw bounces the alert back to LinkedIn.
    logError({ event: "email_store_failed", ids: ids.length, error: String(e?.message ?? e).slice(0, 200) });
    return;
  }
  log({ event: "email_ingested", ids: ids.length, inserted: res?.meta?.changes ?? null, truncated });
}
