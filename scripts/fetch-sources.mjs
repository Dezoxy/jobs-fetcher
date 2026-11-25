#!/usr/bin/env node
// Sessionless source fetcher for the job-list-refresh task.
//
// Replaces two of the three browser-based Collect branches:
//   - Profession.hu alert results  -> keyword search RSS feeds (?rss=1)
//   - NFJ category subscriptions   -> HU site SSR transfer-state JSON
//
// It deliberately does NOT touch LinkedIn or any saved-jobs list: those
// require the logged-in browser session and stay in the scheduled task.
//
// Output: .cache/sources-latest.json (git-ignored) + a one-line summary
// on stdout. The scheduled task reads the file and does the merging,
// salary judgement and fit filtering — this script only collects facts.
//
// Design notes (each the result of a live probe on 2026-07-28/29):
//   - Profession: the ?rss=1 feeds looked complete but are actually CAPPED
//     AT 15 ITEMS and ignore the page segment (probed 2026-07-29), with
//     promoted ads pinned first — new ads can be pushed out of the feed
//     entirely. The HTML listing pages are the real sessionless source:
//     they paginate (/allasok/<page>,<categoryId>,0,<keyword>), can be
//     scoped to the two IT categories (25 = IT üzemeltetés/Telekom,
//     10 = IT programozás/Fejlesztés — cures the construction/"azúr"
//     keyword noise the 2026-07-29 run reported), and every result <li>
//     carries structured data attributes: data-prof-id, data-item-name,
//     data-item-brand (company!), data-category*, data-link.
//     Feeds are fetched per keyword because the search box is single-phrase.
//     Over-generic keywords ("it", bare "architect"/"architekt"/"platform",
//     bare "infrastruktúra") are excluded: the alert-parity loss is covered
//     by the broad category alert plus the fit filter.
//   - NFJ: POST /api/search/posting ignores the region and returns Polish
//     rows regardless of the region=hu query param (probed three body
//     variants). The HU site pages are SSR'd with an Angular transfer-state
//     <script id="serverApp-state"> blob whose search entry carries
//     postings with regions:["hu"] and posted salaries. The entry key is a
//     build-dependent hash, so we locate it by shape (has .postings array),
//     never by name.

import fs from "node:fs";
import path from "node:path";
import { httpGet } from "./http.mjs";
import { readLedger, ledgerLookup } from "./ledger.mjs";
// The deterministic vetoes live in vetoes.mjs so the browser-collected
// LinkedIn path runs the same rules — see that file.
import { titleVeto, judgeProfession, GERMAN_ROLE } from "./vetoes.mjs";

// Posted-salary floor (HUF gross per month) from the owner's private
// employee-cv judge-profile.md, passed by scripts/v2/run.mjs. Unset (a local
// `npm run fetch`): no prefilter here; the judge still applies the floor.
const SALARY_FLOOR = Number(process.env.JOBS_SALARY_FLOOR_HUF) || null;

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_DIR = path.join(ROOT, ".cache");
const OUT = path.join(OUT_DIR, "sources-latest.json");

const UA = "jobs-dashboard-fetch/1.0 (private dashboard; contact: owner)";
const TIMEOUT_MS = 20000;
// Two retries, not the three fetch-linkedin.mjs uses: the failure this
// script actually met is fixed at the transport level below, so anything
// left here is a genuine transient and a third attempt only adds load.
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 750;
// Share of a source's fetch units that may fail before the whole run is
// treated as failed rather than thin. See the guard at the bottom of this
// file for why it is measured per source and why it exists at all.
const MAX_FAILED_UNIT_RATIO = 0.25;

// ---------------------------------------------------------------- config

// One entry per Profession keyword alert; keywords mirror the configured
// alerts (see employee-cv/profile/target-roles.md, "Configured alerts").
const PROFESSION_FEEDS = {
  sysadmin: ["rendszerüzemeltető", "systems engineer", "system engineer", "rendszergazda"],
  devops: ["devops engineer", "cloud engineer", "azure"],
  architect: [
    "it solution architect", "solution architect", "enterprise architect",
    "system architect", "cloud architect", "software architect",
    "platform architect", "megoldásarchitekt", "megoldástervező",
    "rendszertervező", "it architekt", "infrastruktúra architekt", "ai engineer",
  ],
  // New direction approved 2026-07-28 (security/IAM gap):
  security: ["security engineer", "iam", "információbiztonság", "kiberbiztonság"],
};

// NFJ subscription categories; HU site slugs, filtered to Budapest+remote
// exactly like the task prompt did in the browser.
const NFJ_CATEGORIES = [
  "devops", "architecture", "rendszergazda", "artificial-intelligence",
  "security", "cloud", "erp",
];
const NFJ_CRITERIA = "criteria=city%3Dbudapest,remote";


const dropped = { location: 0, language: 0, title: 0, ledger: 0 };

// Every mechanically dropped candidate is recorded here with the rule that
// killed it, and shipped in sources-latest.json as `droppedRows` (added
// 2026-08-11). Before that the vetoes only incremented a counter, so
// "why is this job not on my dashboard?" had no answer anywhere in the
// system — the ad was simply absent, indistinguishable from never having
// been published. The counters stay: they are the anomaly signal the task
// doc reads, and a list is no substitute for a number you can compare
// against the previous run.
//
// This is a per-run artifact on purpose, NOT a ledger entry. A mechanical
// rule re-evaluates itself every six hours for free; writing its verdict to
// the ledger would freeze it, and loosening a veto later would silently fail
// to release anything the old rule had already dropped.
const droppedRows = [];
function noteDrop(reason, row) {
  dropped[reason.split(":")[0]]++;
  droppedRows.push({ ...row, reason });
}

// Collection coverage, per source. A "unit" is one independently-failing fetch:
// a Profession keyword+category group, or an NFJ category. Counted separately
// from `errors` because not every error costs a unit — a posting with no URL
// slug pushes an error and loses one row, not a whole category.
const coverage = {
  profession: { units: 0, failed: 0 },
  nfj: { units: 0, failed: 0 },
};


// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every request goes through scripts/http.mjs, which never reuses a
// connection. Read the comment at the top of that file before switching this
// back to fetch(): keep-alive reuse is what silently emptied this feed for
// eight consecutive runs from 2026-09-04 19:19.
async function get(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { status, text } = await httpGet(url, {
        headers: { "User-Agent": UA, "Accept-Language": "hu-HU" },
        timeoutMs: TIMEOUT_MS,
      });
      // Profession answers 404 for a keyword+category combination with zero
      // results (probed 2026-07-29: "megoldástervező" in category 25). That is
      // an empty result set, not an error.
      if (status === 404) return null;
      if (status < 200 || status > 299) throw new Error(`HTTP ${status} for ${url}`);
      return text;
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw e;
      await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

const decodeEntities = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'");

// -------------------------------------------------------------- Profession

// Search-result <li> parser. Each result item looks like:
//   <li class="advertisement-result-list-item" data-prof-id="2936905"
//       data-link="https://www.profession.hu/allas/...?keyword=..."
//       data-item-name="Azure System Specialist"
//       data-item-brand="MOL Nyrt."
//       data-category1="IT üzemeltetés, Telekommunikáció"
//       data-category2="Hálózati és Rendszermérnök"
//       data-category6="Pest_megye,_Budapest" ...>
function parseListing(html) {
  const out = [];
  const li = /<li class="advertisement-result-list-item"([\s\S]*?)>/g;
  let m;
  while ((m = li.exec(html))) {
    const attrs = m[1];
    const attr = (name) => {
      const a = attrs.match(new RegExp(`${name}="([^"]*)"`));
      return a ? decodeEntities(a[1]).trim() : null;
    };
    out.push({
      adId: attr("data-prof-id"),
      profCategoryId: attr("data-prof-category"),
      role: attr("data-item-name"),
      company: attr("data-item-brand"),
      link: attr("data-link"),
      category1: attr("data-category1"),
      category2: attr("data-category2"),
      location: (attr("data-category6") || "").replace(/_/g, " "),
    });
  }
  const count = html.match(/(\d+)\s*álláshirdetés/);
  return { items: out, totalCount: count ? parseInt(count[1], 10) : null };
}

const PROFESSION_CATEGORIES = [25, 10]; // IT üzemeltetés/Telekom, IT programozás/Fejlesztés
const PAGE_SIZE = 20;
const MAX_PAGES = 10; // safety valve per keyword+category

// Tiny concurrency pool: ~100 listing pages sequentially would blow past
// the scheduled task's patience; 6 parallel keyword+category groups keep
// the whole run in the 10–20 s range while staying polite to the site.
async function pool(jobs, limit) {
  const queue = [...jobs];
  await Promise.all(Array.from({ length: limit }, async () => {
    while (queue.length) await queue.shift()();
  }));
}

async function fetchProfession(errors) {
  const byAdId = new Map();
  const groups = [];
  for (const [alert, keywords] of Object.entries(PROFESSION_FEEDS))
    for (const kw of keywords)
      for (const cat of PROFESSION_CATEGORIES) groups.push({ alert, kw, cat });
  coverage.profession.units = groups.length;

  await pool(groups.map(({ alert, kw, cat }) => async () => {
    try {
      let page = 1, pages = 1;
      do {
        const url = `https://www.profession.hu/allasok/${page},${cat},0,${encodeURIComponent(kw)}`;
        const html = await get(url);
        if (html === null) break; // 404 = zero results for this combo
        const { items, totalCount } = parseListing(html);
        if (page === 1 && totalCount) pages = Math.min(MAX_PAGES, Math.ceil(totalCount / PAGE_SIZE));
        if (items.length === 0) break;
        for (const it of items) {
          if (!it.adId || !it.link) continue;
          // The page appends a "results from other categories" teaser block
          // whose items are NOT in the requested category — that is where
          // the construction/property-guard noise came from. Keep only
          // items tagged with the category we asked for.
          if (it.profCategoryId !== String(cat)) continue;
          // Strip query and any trailing "/pro" (promoted) segment so the
          // canonical URL stays stable whether or not the ad is promoted.
          const cleanUrl = it.link.split("?")[0].replace(/\/(pro)?\/?$/, "");
          // Dropped ads are cached as null so a re-encounter under another
          // keyword+category neither re-judges nor re-counts them — before
          // this (2026-08-07) every `dropped` counter tallied the same ad
          // once per listing page it appeared on, which made the counts
          // useless as the anomaly signal the task doc asks them to be.
          if (byAdId.has(it.adId)) {
            const prev = byAdId.get(it.adId);
            if (prev && !prev.matchedKeywords.includes(kw)) prev.matchedKeywords.push(kw);
            continue;
          }
          const verdict = judgeProfession(it.role, it.location);
          if (verdict !== "keep") {
            noteDrop(verdict, {
              id: `pr-${it.adId}`, source: "Profession",
              role: it.role, company: it.company, url: cleanUrl, location: it.location || null,
            });
            byAdId.set(it.adId, null);
            continue;
          }
          byAdId.set(it.adId, {
            id: `pr-${it.adId}`,
            source: "Profession",
            role: it.role,
            company: it.company,
            url: cleanUrl,
            location: it.location || null,
            profCategory: [it.category1, it.category2].filter(Boolean),
            alert,
            matchedKeywords: [kw],
          });
        }
        page++;
      } while (page <= pages);
    } catch (e) {
      coverage.profession.failed++;
      errors.push(`profession "${kw}" cat ${cat}: ${e.message}`);
    }
  }), 10);

  return [...byAdId.values()].filter(Boolean); // nulls = ads vetoed on first sight
}

// -------------------------------------------------------------------- NFJ

function extractState(html) {
  const m = html.match(/<script id="serverApp-state" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("serverApp-state not found (SSR layout changed?)");
  const raw = m[1]
    .replace(/&q;/g, '"').replace(/&a;/g, "&").replace(/&s;/g, "'")
    .replace(/&l;/g, "<").replace(/&g;/g, ">");
  const state = JSON.parse(raw);
  // Locate the search-result entry by shape, not by its build-hash key.
  for (const v of Object.values(state)) {
    if (v && typeof v === "object" && Array.isArray(v.postings) && "totalCount" in v) return v;
  }
  throw new Error("no search-result entry with .postings in serverApp-state");
}

async function fetchNfj(errors) {
  const byId = new Map();
  coverage.nfj.units = NFJ_CATEGORIES.length;
  for (const cat of NFJ_CATEGORIES) {
    try {
      let page = 1, totalPages = 1;
      do {
        const url = `https://nofluffjobs.com/hu/${cat}?${NFJ_CRITERIA}${page > 1 ? `&page=${page}` : ""}`;
        const entry = extractState(await get(url));
        totalPages = Math.max(1, entry.totalPages || 1);
        for (const p of entry.postings || []) {
          if (!(p.regions || []).includes("hu")) continue; // hard region guard
          // Id stability rule: jobs.json keys NFJ rows as nfj-<url slug>
          // (lowercase). The SSR posting.id is a different, mixed-case
          // variant (…-Budapest-5), so ids minted from it never match rows
          // stored by earlier runs — the 2026-07-29 run had to re-pair 41
          // rows by URL. Always derive the id from the URL slug instead.
          const slug = String(p.url || "").toLowerCase().replace(/^\/+|\/+$/g, "");
          if (!slug) { errors.push(`nfj: posting without url slug (${p.id})`); continue; }
          // Dedup before judging (same null-caching as Profession): a posting
          // listed under several categories must be judged and counted once.
          if (byId.has(slug)) {
            const prev = byId.get(slug);
            if (prev && !prev.categories.includes(cat)) prev.categories.push(cat);
            continue;
          }
          const drop = (reason) => {
            noteDrop(reason, {
              id: `nfj-${slug}`, source: "NoFluff", role: p.title, company: p.name,
              url: `https://nofluffjobs.com/hu/job/${slug}`, location: null,
            });
            byId.set(slug, null);
          };
          // German-language ads are explicitly out of scope (preferences.md).
          if (GERMAN_ROLE.test(p.title || "")) { drop("language:german-or-gender-tag"); continue; }
          const langs = (p.tiles?.values || [])
            .filter((t) => t.type === "jobLanguage").map((t) => t.value);
          if (langs.length && langs.every((l) => l === "de")) { drop("language:de-only"); continue; }
          // Same title vetoes as Profession — see titleVeto above.
          const veto = titleVeto(p.title);
          if (veto) { drop(`title:${veto}`); continue; }
          // Posted-salary floor: every row whose disclosed band topped out
          // under the owner's floor was hidden by the user (16/16 on the
          // 2026-08-07 export). Only a *visible* band can be judged here —
          // estimated salaries are the fit filter's problem, not the fetcher's.
          if (SALARY_FLOOR && p.salary?.disclosedAt === "VISIBLE" &&
              (p.salary?.to ?? p.salary?.from) != null &&
              (p.salary?.to ?? p.salary?.from) < SALARY_FLOOR &&
              p.salary?.currency === "HUF") { drop("title:salary-floor"); continue; }
          byId.set(slug, {
            id: `nfj-${slug}`,
            source: "NoFluff",
            role: p.title,
            company: p.name,
            url: `https://nofluffjobs.com/hu/job/${slug}`,
            salaryLo: p.salary?.from ?? null,
            salaryHi: p.salary?.to ?? p.salary?.from ?? null,
            salaryType: p.salary?.type ?? null, // "permanent" -> Employee, "b2b" -> Contract
            salaryCurrency: p.salary?.currency ?? null,
            salaryVisible: p.salary?.disclosedAt === "VISIBLE",
            seniority: p.seniority || [],
            fullyRemote: !!p.fullyRemote,
            posted: p.posted ? new Date(p.posted).toISOString().slice(0, 10) : null,
            categories: [cat],
          });
        }
        page++;
      } while (page <= totalPages);
    } catch (e) {
      coverage.nfj.failed++;
      errors.push(`nfj category "${cat}": ${e.message}`);
    }
  }
  return [...byId.values()].filter(Boolean); // nulls = postings vetoed on first sight
}

// ------------------------------------------------------------------- main

// Negative cache. Full-text keyword search over two whole IT categories
// yields ~1000 rows; without a ledger of already-rejected ids the refresh
// task would re-judge the same noise on every run. The task appends the
// ids it rejects to this file, each with a reason (see scripts/ledger.mjs
// for the format and the reason vocabulary); we drop them here so they
// never reach the task again. Losing the file costs one heavy re-judging
// run, nothing more — which is why .cache/ (git-ignored, host-persistent)
// is an acceptable home for it.
const REJECTED = path.join(OUT_DIR, "rejected-ids.json");
const rejected = readLedger(REJECTED); // { "<id>": "<reason>" } — see scripts/ledger.mjs
// Exact id, then the NFJ slug-variant fallback — a re-published ad must not
// come back as a fresh candidate. See ledgerLookup in scripts/ledger.mjs.
const ledgerReason = ledgerLookup(rejected);

const errors = [];
const [professionAll, nfjAll] = await Promise.all([fetchProfession(errors), fetchNfj(errors)]);

// Ledger drops are recorded alongside the mechanical ones, carrying the
// verdict that put them there ("tracker:ignored", "dedupe:pr-123", …), so the
// dropped list answers "why is this not on my dashboard?" for every candidate
// this run saw — not just the ones a regex killed.
const keep = (rows) => rows.filter((p) => {
  const why = ledgerReason(p.id);
  if (!why) return true;
  noteDrop(`ledger:${why}`, {
    id: p.id, source: p.source, role: p.role, company: p.company,
    url: p.url, location: p.location ?? null,
  });
  return false;
});
const profession = keep(professionAll);
const nfj = keep(nfjAll);

const doc = {
  fetchedAt: new Date().toISOString(),
  rejectedFiltered: professionAll.length + nfjAll.length - profession.length - nfj.length,
  dropped, // { location, language, title, ledger } — pre-filter counts
  // Every candidate this run dropped, with the rule that dropped it. Rewritten
  // each run: a still-listed ad is re-fetched and re-judged every six hours,
  // so the current file always explains the ads you can still find on the
  // portal. `jq -r '.droppedRows[] | select(.id=="pr-123")' .cache/sources-latest.json`
  droppedRows,
  // Per-source fetch coverage. Read this before trusting a thin run: a low
  // count with failed units is a broken fetch, not a quiet job market.
  coverage,
  // Newest ads have the highest numeric id; the HTML listing carries no
  // posting date, so this is the best available recency ordering.
  profession: profession.sort((a, b) => Number(b.id.slice(3)) - Number(a.id.slice(3))),
  nfj: nfj.sort((a, b) => (b.posted || "").localeCompare(a.posted || "")),
  errors,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");

console.log(
  `fetch-sources: profession=${profession.length} nfj=${nfj.length} ` +
  `rejected-filtered=${doc.rejectedFiltered} ` +
  `dropped-location=${dropped.location} dropped-language=${dropped.language} ` +
  `dropped-title=${dropped.title} dropped-ledger=${dropped.ledger} ` +
  `errors=${errors.length} ` +
  `units-failed=profession:${coverage.profession.failed}/${coverage.profession.units},` +
  `nfj:${coverage.nfj.failed}/${coverage.nfj.units}` +
  (errors.length ? `\n  - ${errors.join("\n  - ")}` : "")
);
// Fail loudly when a source loses more than MAX_FAILED_UNIT_RATIO of its units.
//
// Added 2026-09-07. Until then the only fatal outcome was "both sources empty",
// so a run could lose 46 of 48 Profession groups and still exit 0. That is
// exactly what the keep-alive defect did (see scripts/http.mjs) for eight
// consecutive runs from 2026-09-04 19:19: the merge agent recorded the damage
// in public/data/last-run.json, nothing reads that file, jobs.json sat frozen
// at 955 rows for 30 hours, and the first hard failure arrived only once NFJ
// happened to go empty on the same run. Three days of a silently truncated
// candidate set is a worse outcome than a refresh that refuses to run.
//
// Measured PER SOURCE rather than across the pooled total, because a pooled
// ratio cannot see a whole source die: all 7 NFJ categories failing is 7 of 55
// units, 13%, and would slip under any threshold loose enough to tolerate
// ordinary Profession flakiness.
//
// This is deliberately a hard stop, not a warning: it exits before the merge,
// so the run makes no commit and the dashboard keeps yesterday's data rather
// than absorbing an undercount that later runs would treat as the new baseline.
// .cache/sources-latest.json is already written above, so the failed run is
// still fully inspectable.
const degraded = Object.entries(coverage)
  .filter(([, c]) => c.units > 0 && c.failed / c.units > MAX_FAILED_UNIT_RATIO)
  .map(([src, c]) => `${src} lost ${c.failed}/${c.units} units ` +
    `(${Math.round((c.failed / c.units) * 100)}% > ${Math.round(MAX_FAILED_UNIT_RATIO * 100)}%)`);

if (degraded.length) {
  console.error(`fetch-sources: collection degraded — ${degraded.join("; ")}`);
  process.exit(1);
}

// Both sources empty is fatal even at full coverage: every unit answered
// cleanly with nothing, which has never been a real state of this market.
if (profession.length === 0 && nfj.length === 0) process.exit(1);
