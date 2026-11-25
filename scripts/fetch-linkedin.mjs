#!/usr/bin/env node
// Sessionless LinkedIn job collector — the replacement for the Playwright
// browse step (Phase 2b), retired 2026-08-29.
//
//   node scripts/fetch-linkedin.mjs [-o <out>]
//     out = .cache/browser-latest.json   (unchanged: the browse step's contract)
//
// WHY THIS EXISTS
// ---------------
// Until 2026-08-29 the LinkedIn channel was the only source that needed a
// session, and it cost the whole browser apparatus: a logged-in Chromium, a
// Playwright MCP server, a second `claude --print` invocation, the auth
// gate (exit 7) and the browser-degradation alert (exit 8). docs/refresh-
// task.md's rule — "No curl/wget/requests fallback for anything with a
// session — the LinkedIn alerts feed stays in the browser" — was written on
// 2026-07-28 and was correct then. It rests on a premise that no longer
// holds: LinkedIn serves the same ads unauthenticated through its guest
// endpoints.
//
//   /jobs-guest/jobs/api/seeMoreJobPostings/search   discovery (this file)
//   /jobs-guest/jobs/api/jobPosting/<id>             detail (not used here)
//
// Probed 2026-08-29 from the homelab egress: no cookie, no Authorization,
// not even a User-Agent required; 14 sequential requests returned 200 with
// no 429. Each card carries id, title, company, location and datetime as
// structured markup.
//
// THE TITLE IS THE POINT, NOT THE SAVED CHROMIUM
// ----------------------------------------------
// scripts/filter-browser.mjs documents a nine-day outage (2026-08-12 to
// 08-21) in which rows arrived carrying only id/url/text. judgeLinkedIn("")
// returns "keep" for every row, so both vetoes went quiet while the ledger
// kept working — indistinguishable from a clean feed — and 21 of 41 rows
// that should have been dropped reached the merge agent.
//
// That failure is structural to an LLM reading a rendered card: the title is
// whatever the agent chose to extract. Here it comes from the card's own
// <h3 class="base-search-card__title">. The bug class is gone, not merely
// less likely — which is why `titled` should equal `kept` on every run now.
//
// KEYWORDS ARE MEASURED, NOT GUESSED
// ----------------------------------
// Derived 2026-08-29 from 548 LinkedIn rows and the 505 "Nem érdekel"
// verdicts in the dashboard tracker. The ignore base rate is 92%, so a
// keyword only earns its place by beating that, or by covering rows that
// survived triage. Findings that shaped the list below:
//
//   - Bare "engineer" is unusable: page 1 returns Hardware Engineer,
//     Mechanical Engineer, EPLAN, Verification Engineer. It is refined into
//     an OR group instead.
//   - NOT is silently ignored by the endpoint. "engineer NOT (sales OR
//     analyst)" returned *more* mechanical-engineering rows, not fewer, so
//     exclusion has to happen downstream in vetoes.mjs — never in the query.
//   - OR groups and quoted phrases both work, and match Hungarian titles
//     too ("Platformmérnök" came back for `platform engineer`).
//   - security is dropped: 49 rows, 100% ignored, 0 survivors — despite
//     Security sitting in PRIORITY_CATEGORIES (public/app.js) and the
//     "security/IAM gap" direction in fetch-sources.mjs. The strategy and
//     the revealed preference disagree; until that is resolved, the query
//     is off. `iam` never matched a single row and is gone with it.
//   - consultant / analyst / sap / administrator / system engineer:
//     195 rows, 0 survivors between them. Never queried.
export const LINKEDIN_QUERIES = [
  "(devops OR platform OR cloud OR infrastructure) engineer",
  // ONE bare query for the whole architect family, 2026-09-11. It replaces the
  // six quoted phrases (solution / cloud / enterprise / system architect from
  // 2026-09-01, platform / technical architect from 09-02) because their
  // premise no longer holds: the guest endpoint ignores the quotes. Measured
  // 2026-09-11 in the 24h window, quoted and unquoted "solution architect"
  // shared 95 of 100 ids; "solution", "system" and "technical architect"
  // overlapped 81-85 ids pairwise and all three capped at 100 around the same
  // 9 architect titles. The rest was body-text noise (Senior Software Engineer,
  // Senior Cisco Network Engineer, SAP FI Consultant). Splitting further
  // cannot help when every phrase returns the same pool.
  //
  // Historical 2026-09-11 ranking/window measurements:
  // Title matches rank first: bare `architect` over 24h put its architect
  // titles at positions 0-8 of 100, and the one tail hit, at 87, was a
  // building-design role. Over 24h it found every architect title the six
  // phrases had found; over 12h it returns ~55 rows, under the ceiling. It
  // still covers the two misses that motivated the 09-02 phrases, "IT
  // infrastruktúra platform architect" (MBH) and "HCI AI & Automation
  // Technical Architect" (Stefanini).
  "architect",
  "devops",
  "(ai OR genai OR llm) engineer",
  // Bare "azure" and "aws" behaved exactly like bare "engineer": they are
  // technology mentions in the body, not role names, so they capped at 100
  // in BOTH windows while scoring 89-90% noise with one survivor each.
  // Qualified the same way, this single query replaces both and returns
  // only role matches (it also catches Hungarian titles: "Platformmérnök
  // (Azure)", "Infrastruktúra-mérnök (Azure)").
  "(azure OR aws OR gcp) (engineer OR architect OR devops)",
  // Deliberate blind-spot probe, not a measured winner. SRE scored 0
  // survivors out of 10 rows — but every historical row came in through
  // the old alerts, so "never kept" and "never shown" are indistinguishable
  // in that data. This query is how we find out which one it was. Drop it
  // if it is still contributing nothing in a month.
  "(site reliability OR sre)",
];

// Daily discovery covers 26 hours: a 24-hour interval plus two hours of
// overlap for normal startup/collection delays. This does not recover a
// wholly missed day. Existing ads are checked by check-liveness.mjs.
//
// The previous 12-hour window reduced query caps, but would leave half a day
// unseen at daily cadence. LinkedIn's 100-result ceiling and ignored quotes
// remain provider limits; retain cap/paging detection and exit 5 rather than
// claiming complete coverage. Broad queries capped at 24h in September.
export const LOOKBACK_HOURS = 26;
const TIME_WINDOWS = [`r${LOOKBACK_HOURS * 3600}`];
const LOCATION = "Budapest, Hungary";

// 10 cards/page; start=100 returns 0, so 100 is the endpoint's hard ceiling
// per query — the same shape as Profession's 15-item RSS cap, and the same
// mitigation: many narrow queries rather than one broad one. Hitting it here
// is now a genuine defect rather than a tolerable one (see TIME_WINDOWS), so
// a cap exits non-zero while preserving collected rows.
const PAGE_SIZE = 10;
const MAX_START = 90;
const DELAY_MS = 1200;
const MAX_RETRIES = 3;

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache");
const BASE = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decode = (s) => s
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, " ").trim();

const field = (card, re) => { const m = card.match(re); return m ? decode(m[1]) : ""; };

// One <li> per card. Splitting on <li> is safe here because the guest
// endpoint returns a bare card list, not a full page.
export function parseCards(html) {
  return html.split("<li>").slice(1).map((c) => ({
    jobId: field(c, /data-entity-urn="urn:li:jobPosting:(\d+)"/),
    title: field(c, /base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/),
    company: field(c, /base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/),
    location: field(c, /job-search-card__location"[^>]*>([\s\S]*?)<\/span>/),
    posted: field(c, /datetime="([^"]+)"/),
  })).filter((r) => r.jobId && r.title);
}

async function getPage(keywords, window, start) {
  const url = `${BASE}?keywords=${encodeURIComponent(keywords)}` +
    `&location=${encodeURIComponent(LOCATION)}&f_TPR=${window}&start=${start}`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 200) return parseCards(await res.text());
      // 429 is the one we expect to meet eventually; back off rather than
      // hammering, and let the caller decide whether the run still stands.
      if (attempt === MAX_RETRIES) throw new Error(`HTTP ${res.status}`);
      await sleep(DELAY_MS * 4 * attempt);
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      await sleep(DELAY_MS * 4 * attempt);
    }
  }
  return [];
}

export async function collectLinkedIn({ queries = LINKEDIN_QUERIES, fetchPage = getPage,
  pause = sleep, now = () => new Date() } = {}) {
  const rows = new Map();   // jobId -> row, deduped across queries and windows
  const perQuery = [];
  const failures = [];
  // A capped query is a query that silently dropped results. Never let that
  // pass as "covered everything" — it is reported per query and in the file.
  const truncated = [];

  for (const q of queries) {
    for (const window of TIME_WINDOWS) {
      let got = 0, fresh = 0, hitCeiling = false;
      // Distinct ids THIS query returned. `fresh` cannot stand in for it: it also
      // excludes ids an earlier query already collected, so a query overlapping a
      // previous one looks like page 1 repeating when it is not. On 2026-09-11
      // "system architect" and "technical architect" each paged through 100
      // distinct ids, showed fresh=5 and fresh=3, and were reported PAGING BROKEN.
      const queryIds = new Set();
      try {
        for (let start = 0; start <= MAX_START; start += PAGE_SIZE) {
          const cards = await fetchPage(q, window, start);
          if (cards.length === 0) break;            // exhausted this query
          got += cards.length;
          if (start === MAX_START && cards.length === PAGE_SIZE) hitCeiling = true;
          for (const c of cards) {
            queryIds.add(c.jobId);
            if (rows.has(c.jobId)) continue;
            fresh++;
            rows.set(c.jobId, {
              id: `li-${c.jobId}`,
              url: `https://www.linkedin.com/jobs/view/${c.jobId}/`,
              // The role line ONLY — no company, no location, no "Promoted".
              // docs/refresh-task.md's Output block requires exactly this, and
              // vetoes.mjs is calibrated on 764 hand-judged titles.
              title: c.title,
              text: [c.title, c.company, c.location, c.posted].filter(Boolean).join(" · "),
              company: c.company || null,
              location: c.location || null,
              postedAt: c.posted || null,
            });
          }
          if (cards.length < PAGE_SIZE) break;      // last page
          await pause(DELAY_MS);
        }
      } catch (e) {
        failures.push(`${q} [${window}]: ${e.message}`);
      }
      // Every cap is severe now. When there were two windows this had a tolerable
      // case — a 7-day pass that capped only cost some row a lastSeen bump. That
      // pass is gone (and the "tolerable" reading of it turned out to be wrong
      // anyway: it cost 13 live ads their refresh). What is left is the discovery
      // pass, and a cap there means an ad published inside the window was
      // dropped and nothing downstream will ever see it.
      // A ceiling hit has two very different causes and they need different
      // fixes, so name which one this is instead of making a human diff the log.
      //
      // If `start=` were ever ignored, every page would return page 1 again: the
      // loop never sees a short page, runs to MAX_START, and reports got=100 with
      // at most 10 distinct ids (queryIds, not fresh; see above). A genuine cap
      // looks nothing like that: it accumulates distinct ids the whole way down.
      // This is the check the retired browse step needed a
      // row-count threshold to approximate, and it is exact rather than
      // statistical, which is why refresh-run.sh's JOBS_REFRESH_BROWSE_MIN_ROWS
      // no longer has to carry it (see the note there).
      if (hitCeiling) {
        truncated.push({ q, window, paging: queryIds.size <= PAGE_SIZE && got >= MAX_START + PAGE_SIZE });
      }
      perQuery.push({ q, window, got, fresh, hitCeiling });
      await pause(DELAY_MS);
    }
  }

  const allFailed = failures.length === queries.length * TIME_WINDOWS.length;
  const auth = rows.size === 0 || allFailed
    ? { linkedin: { state: "undetermined", reason: failures.length
        ? `guest search coverage degraded: ${failures[0]}`
        : "guest search returned zero rows across all queries" } }
    : { linkedin: { state: "ok" } };
  return { document: {
    collectedAt: now().toISOString(),
    lookbackHours: LOOKBACK_HOURS,
    auth,
    linkedinAlerts: [...rows.values()],
    queries: perQuery,
    truncatedQueries: truncated,
    queryFailures: failures,
  }, exitCode: allFailed ? 4 : truncated.length || failures.length ? 5 : 0 };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('fetch-linkedin.mjs [-o FILE] — daily discovery, 26-hour lookback; exits 4 on total failure, 5 on partial/capped coverage');
    return 0;
  }
  if (argv.length && (argv.length !== 2 || argv[0] !== '-o' || !argv[1])) throw new Error('Expected -o FILE or --help');
  const out = argv[1] ?? path.join(CACHE, 'browser-latest.json');
  const { document, exitCode } = await collectLinkedIn();
  const { linkedinAlerts, auth, queries: perQuery, truncatedQueries: truncated, queryFailures: failures } = document;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(document, null, 2) + "\n");
  console.log(
    `fetch-linkedin: queries=${LINKEDIN_QUERIES.length}x${TIME_WINDOWS.length} ` +
    `rows=${linkedinAlerts.length} lookback_hours=${LOOKBACK_HOURS} state=${auth.linkedin.state}` +
    (truncated.length ? ` truncated=${truncated.length}` : "") +
    (failures.length ? ` failed=${failures.length}` : ""));
  for (const { q, window, got, fresh, hitCeiling } of perQuery) {
    console.log(`  ${String(got).padStart(3)} seen ${String(fresh).padStart(3)} new  ` +
      `[${window}] ${q}${hitCeiling ? "  <-- CAPPED" : ""}`);
  }
  for (const t of truncated) {
    if (t.paging) {
      console.error(
        `  !! PAGING BROKEN: ${t.q} [${t.window}] — ran to ${MAX_START + PAGE_SIZE} ` +
        `results but almost none were new, which is what page 1 repeating looks ` +
        `like. The start= parameter is being ignored; this run collected roughly ` +
        `one page per query.`);
    } else {
      console.error(
        `  !! capped at ${MAX_START + PAGE_SIZE}: ${t.q} [${t.window}] — ads ` +
        `published inside the window were dropped and nothing downstream will ` +
        `ever see them. Narrow this query. Splitting it alone may not help: the ` +
        `endpoint ignores quotes (see the notes on LINKEDIN_QUERIES and TIME_WINDOWS).`);
    }
  }
  for (const f of failures) console.error(`  !! ${f}`);

  // Partial query failures remain usable but now trigger the same degraded
  // collection alert as caps, even when the surviving row count exceeds 15.
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`fetch-linkedin: ${error.message}`); process.exitCode = 4;
  });
}
