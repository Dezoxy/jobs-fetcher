#!/usr/bin/env node
// Sessionless liveness probe for every row in jobs.json.
//
// Dead-ad signatures:
//   - Profession (probed 2026-07-29, re-confirmed 2026-08-11): a removed/expired
//     ad answers 301 to a category listing; a live ad answers 200 and its page
//     does NOT contain "lejárt", so a 200 body carrying an "álláshirdetés
//     lejárt" marker is also dead.
//   - NFJ (revised 2026-08-11): the HTML page answers 200 even for an expired
//     ad, so the old status-code probe reported every NFJ row alive — it found
//     0 dead out of 56 while 9 were in fact gone. The truth lives in the SPA's
//     own API: GET /api/posting/<slug> returns { status } — PUBLISHED is live,
//     EXPIRED/DISABLED is dead, 404 means removed outright.
//   - LinkedIn (added 2026-08-11): the header comment used to say li- rows
//     "cannot be checked without a session". That is wrong for the *guest*
//     fragment: GET /jobs-guest/jobs/api/jobPosting/<id> answers without a
//     cookie, 404s for a removed ad, and renders a "No longer accepting
//     applications" banner for a closed one. Live ads carry no such marker.
//     Validated against rows already marked closed by hand: 4/7 confirmed, the
//     other 3 read live (a closed row can be re-opened or re-posted) — the
//     probe errs toward "live", never toward a false death.
//
// Usage: npm run liveness              full sweep
//        npm run liveness -- --retry-unknown   re-probe only last run's unknowns
//
// Output: .cache/dead-ids.json
//   { checkedAt, dead: [ids], alive: [ids], unknown: [{id, why}], checked, skipped }
// The refresh task uses `dead` two ways: it never bumps lastSeen for a
// dead id (so dead SAVED ads age into the 14-day archive naturally even
// though the portal's saved list still contains them), and it deletes dead
// Értesítő / NFJ keresés rows outright (no curation is lost — they were
// feed echoes of ads that no longer exist).
//
// `alive` (added 2026-08-31) is the mirror of that, and it exists because
// the LinkedIn channel stopped being able to refresh its own lastSeen.
//
// Until 2026-08-29 a row's lastSeen was bumped by one thing only: the row
// reappearing in a feed. That worked while the feeds returned their whole
// result set. LinkedIn's guest search does not — it caps at 100 results per
// query and ignores sortBy, so a query with more than 100 matches truncates
// at the same place every run and the rows past that point are invisible
// forever, not intermittently. Measured on the git history 2026-08-31:
// of the 48 LinkedIn rows the retired browse step last saw alive, 28 had
// stopped being refreshed two days later, and a probe of all 28 found every
// one of them still live. Thirteen were ads that DO match a query and were
// simply beyond the ceiling; they were on course to archive as false deaths.
//
// So liveness now carries the positive verdict as well as the negative one.
// It is the better signal anyway: "the ad still exists" is a fact about the
// ad, while "the search returned it" is a fact about the search.
//
// Only rows seen within the last 20 days are probed: anything older is
// already archived by the UI, so a request would be wasted.
//
// A network error, a timeout or a throttle response is NOT proof of death —
// those rows are left alone rather than guessed at.

import fs from "node:fs";
import path from "node:path";
import { httpGet } from "./http.mjs";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, ".cache", "dead-ids.json");
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/jobs.json"), "utf8"));

const RECENT_DAYS = 20;
// LinkedIn throttles a bare fetch UA; the guest fragment wants a browser one.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const LI_CLOSED = /No longer accepting applications|Nem fogad(unk)? több jelentkez/i;
const PR_EXPIRED = /állás(hirdetés)?\s+(sajnos\s+)?lejárt/i;

const ageOf = (iso) => (Date.now() - new Date(iso + "T00:00:00").getTime()) / 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --retry-unknown re-probes only the rows the previous run could not decide,
// merging the result into the existing dead-ids.json rather than replacing it.
// A throttled row is worth another try; re-sweeping all ~790 to reach 40-odd
// of them is not.
const RETRY = process.argv.includes("--retry-unknown");
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
if (RETRY && !prev?.unknown?.length) {
  console.log("check-liveness: nothing to retry — no unknown rows in the last run");
  process.exit(0);
}

const retryIds = RETRY ? new Set(prev.unknown.map((u) => u.id)) : null;
const candidates = doc.jobs.filter((j) =>
  RETRY ? retryIds.has(j.id) : ageOf(j.lastSeen) <= RECENT_DAYS);
const skipped = doc.jobs.length - candidates.length;

// Every probe returns one of three verdicts. "unknown" is a first-class
// outcome, not a quiet fallback to "live": a throttle or a timeout says
// nothing about the ad, and a run that cannot name the rows it failed on
// cannot be re-run against them either.
const DEAD = (why) => ({ verdict: "dead", why });
const LIVE = (why) => ({ verdict: "live", why });
const UNKNOWN = (why) => ({ verdict: "unknown", why });

const dead = [];
const alive = [];
const unknown = [];

// Profession is the source that broke on keep-alive reuse (see scripts/http.mjs):
// before the 2026-09-06 fix this probe left 75 rows stuck "unknown" every run,
// so no Profession ad could be retired at all.
async function probeProfession(j) {
  const res = await httpGet(j.url, {
    followRedirects: false, // a redirect is how Profession retires an ad
    headers: { "User-Agent": "jobs-dashboard-liveness/1.0", "Accept-Language": "hu-HU" },
    timeoutMs: 15000,
  });
  if (res.status >= 300 && res.status < 400) return DEAD(`http-${res.status}`);
  if (res.status !== 200) return UNKNOWN(`http-${res.status}`);
  return PR_EXPIRED.test(res.text) ? DEAD("lejart-marker") : LIVE("http-200");
}

async function probeNfj(j) {
  const slug = j.url.split("/job/")[1];
  const res = await httpGet(`https://nofluffjobs.com/api/posting/${slug}`, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    timeoutMs: 20000,
  });
  if (res.status === 404) return DEAD("http-404");
  if (res.status !== 200) return UNKNOWN(`http-${res.status}`);
  const status = String(JSON.parse(res.text).status || "").toUpperCase();
  if (!status) return UNKNOWN("no-status");
  return status === "PUBLISHED" || status === "ACTIVE" ? LIVE(status) : DEAD(status);
}

async function probeLinkedIn(j) {
  const num = j.id.replace(/^li-/, "");
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${num}`;
  // LinkedIn answers 429/999 under load; back off twice before giving up.
  let last = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await httpGet(url, {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
      timeoutMs: 20000,
    });
    last = res.status;
    if (res.status === 404 || res.status === 410) return DEAD(`http-${res.status}`);
    if (res.status === 200) {
      const body = res.text;
      if (!body.trim()) return UNKNOWN("empty-200");
      return LI_CLOSED.test(body) ? DEAD("no-longer-accepting") : LIVE("http-200");
    }
    await sleep(3000 * (attempt + 1));
  }
  return UNKNOWN(`http-${last}`);
}

async function probe(j) {
  let r;
  try {
    if (j.id.startsWith("pr-")) r = await probeProfession(j);
    else if (j.id.startsWith("nfj-")) r = await probeNfj(j);
    else if (j.id.startsWith("li-")) r = await probeLinkedIn(j);
    else r = UNKNOWN("unrecognised-id-prefix");
  } catch (e) {
    // network error / timeout: NOT proof of death — leave the row alone
    r = UNKNOWN(e?.name === "TimeoutError" ? "timeout" : "network");
  }
  if (r.verdict === "dead") dead.push(j.id);
  else if (r.verdict === "live") alive.push(j.id);
  else unknown.push({ id: j.id, why: r.why });
}

const queue = [...candidates];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    await probe(queue.shift());
    await sleep(250); // keep LinkedIn from tripping its rate limiter
  }
}));

// On a retry the previous verdicts stand — those rows were decided, and this
// run never looked at them again. Both lists carry forward for the same
// reason; dropping `alive` here would silently un-confirm every row the full
// sweep proved live, and the merge would stop bumping them.
const allDead = RETRY ? [...new Set([...prev.dead, ...dead])] : dead;
const allAlive = RETRY
  ? [...new Set([...(prev.alive ?? []), ...alive])]
  : alive;
const checked = candidates.length - unknown.length;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  checkedAt: new Date().toISOString(),
  dead: allDead.sort(),
  alive: allAlive.sort(),
  unknown: unknown.sort((a, b) => a.id.localeCompare(b.id)),
  checked,
  skipped,
}, null, 2) + "\n");

console.log(
  `check-liveness${RETRY ? " (retry)" : ""}: probed=${candidates.length} decided=${checked} ` +
  `dead=${dead.length}${RETRY ? ` (total ${allDead.length})` : ""} ` +
  `alive=${alive.length}${RETRY ? ` (total ${allAlive.length})` : ""} unknown=${unknown.length} ` +
  (RETRY ? `not-retried=${skipped}` : `skipped-old=${skipped}`));
