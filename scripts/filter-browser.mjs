#!/usr/bin/env node
// Applies the deterministic vetoes and the rejected ledger to the
// browser-collected LinkedIn rows, and records what it dropped.
//
//   node scripts/filter-browser.mjs [<in>] [-o <out>]
//     in  = .cache/browser-latest.json   (the browse step's raw output)
//     out = .cache/browser-filtered.json (what the merge step reads)
//
// WHY THIS EXISTS
// ---------------
// The LinkedIn alerts feed never passes through fetch-sources.mjs — it is
// session-bound and arrives from the browse step instead. Until now that meant
// the mechanical rules were prose: docs/refresh-task.md instructed the merge
// agent to apply the gendered-tag and junior vetoes "by hand, before any
// judgement", and to drop ledgered ids itself. Two consequences, both bad:
// the rules could drift from the fetcher's (nothing compared them), and a
// dropped LinkedIn row left no trace anywhere, so "why is this job not on my
// dashboard?" was unanswerable for the source that supplies most of the list.
//
// Same rules, same reason strings, same droppedRows shape as the fetcher —
// the vetoes themselves live in scripts/vetoes.mjs precisely so there is one
// copy. That now includes the location rules: LinkedIn rows have carried a
// location since 2026-08-29 and this step ignored it until 2026-09-07, so
// provincial ads reached the merge agent and were rejected by hand run after
// run. See locationVetoLinkedIn in vetoes.mjs for why the parsing differs
// from Profession's even though the policy is identical.
//
// Failure is deliberately LOUD (non-zero exit). If this step is skipped or
// silently half-applied, the merge sees ledgered ads again, re-bumps their
// lastSeen and they never archive — the exact regression docs/refresh-task.md
// step 3 warns about.
//
// THE TITLE COUNT IS PART OF THAT LOUDNESS (added 2026-08-21)
// ----------------------------------------------------------
// judgeLinkedIn judges a role string. Given "" it returns "keep" for every
// row, so a browse step that writes no role/title turns both vetoes into
// no-ops while the ledger keeps working — the filter looks alive and reports
// dropped-language=0 dropped-title=0, which is indistinguishable from a clean
// feed. That ran undetected from 2026-08-12 to 2026-08-21: the rows arrived
// carrying only id, url and text, and 21 of 41 rows that should have been
// dropped reached the merge agent, which re-judged them by hand every run.
//
// So the kept/dropped counts are not enough on their own; `titled` says how
// many rows the vetoes could actually see. refresh-run.sh raises the
// browser-degradation alert when rows arrive and none of them are titled.
// Deliberately not fatal: the vetoes going quiet costs the merge some rework,
// while a hard exit here would cost the whole refresh (docs/refresh-task.md
// requires the title, so this is a browse-step regression, not corrupt data).

import fs from "node:fs";
import path from "node:path";
import { readLedger, ledgerLookup } from "./ledger.mjs";
import { judgeLinkedIn } from "./vetoes.mjs";

const argv = process.argv.slice(2);
const oIdx = argv.indexOf("-o");
const OUT_ARG = oIdx === -1 ? null : argv[oIdx + 1];
const IN_ARG = argv.filter((a, i) => a !== "-o" && i !== oIdx + 1)[0];

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const CACHE = path.join(ROOT, ".cache");
const IN = IN_ARG ?? path.join(CACHE, "browser-latest.json");
const OUT = OUT_ARG ?? path.join(CACHE, "browser-filtered.json");
const LEDGER = path.join(CACHE, "rejected-ids.json");

// The browse step is optional (JOBS_REFRESH_BROWSER_ENABLED). No input is the
// normal Phase-1 path, not a problem: say so and leave no stale output behind
// for the merge to mistake for this run's.
if (!fs.existsSync(IN)) {
  fs.rmSync(OUT, { force: true });
  console.log(`filter-browser: ${path.relative(ROOT, IN)} absent — nothing to filter`);
  process.exit(0);
}

let doc;
try {
  doc = JSON.parse(fs.readFileSync(IN, "utf8"));
} catch (e) {
  console.error(`filter-browser: cannot parse ${IN}: ${e.message}`);
  process.exit(3);
}
if (!Array.isArray(doc?.linkedinAlerts)) {
  console.error(`filter-browser: ${IN} has no linkedinAlerts array`);
  process.exit(3);
}

const ledger = readLedger(LEDGER);
// One lookup path with the fetcher, for the same reason the vetoes are
// shared: two copies of the membership test drift, and silently. The NFJ
// slug-variant fallback inside it is inert for li- ids.
const ledgerReason = ledgerLookup(ledger);
const dropped = { language: 0, title: 0, company: 0, location: 0, ledger: 0 };
const droppedRows = [];
const kept = [];
let malformed = 0;
let titled = 0;
let located = 0;

for (const row of doc.linkedinAlerts) {
  const id = row?.id;
  if (typeof id !== "string" || !id) { malformed++; continue; }
  // Resolved once: the vetoes and the droppedRows record must judge and
  // report the same string, and it is what `titled` counts.
  const role = row.role ?? row.title ?? "";
  if (role) titled++;
  // Same reason `titled` exists: a browse step that stops writing location
  // turns the location veto into a silent no-op, and dropped-location=0 then
  // looks exactly like a clean Budapest-only feed.
  const loc = row.location ?? null;
  if (loc) located++;
  // Ledger first: a verdict the user (or a past run) already made outranks a
  // regex, and it is the more informative reason to record.
  const why = ledgerReason(id);
  const reason = why ? `ledger:${why}` : judgeLinkedIn(role, row.company, loc);
  if (reason === "keep") { kept.push(row); continue; }
  dropped[reason.split(":")[0]]++;
  droppedRows.push({
    id,
    source: "LinkedIn",
    role: role || null,
    company: row.company ?? null,
    url: row.url ?? null,
    location: loc,
    reason,
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  collectedAt: doc.collectedAt ?? null,
  filteredAt: new Date().toISOString(),
  auth: doc.auth ?? {},
  lookbackHours: doc.lookbackHours ?? null,
  queryFailures: doc.queryFailures ?? [],
  truncatedQueries: doc.truncatedQueries ?? [],
  linkedinAlerts: kept,
  dropped,
  droppedRows,
  titled,
  located,
}, null, 2) + "\n");

console.log(
  `filter-browser: in=${doc.linkedinAlerts.length} kept=${kept.length} ` +
  `titled=${titled} located=${located} ` +
  `dropped-language=${dropped.language} dropped-title=${dropped.title} ` +
  `dropped-company=${dropped.company} dropped-location=${dropped.location} ` +
  `dropped-ledger=${dropped.ledger}` +
  (malformed ? ` malformed-skipped=${malformed}` : ""));

if (doc.linkedinAlerts.length > 0 && located === 0) {
  console.error(
    `filter-browser: WARNING — none of the ${doc.linkedinAlerts.length} rows ` +
    `carry a location, so the metro and foreign-location vetoes judged null ` +
    `and kept everything. The browse step has written location since ` +
    `2026-08-29 (scripts/fetch-linkedin.mjs); rows without it mean that ` +
    `regressed.`);
}

if (doc.linkedinAlerts.length > 0 && titled === 0) {
  console.error(
    `filter-browser: WARNING — none of the ${doc.linkedinAlerts.length} rows ` +
    `carry a role or title, so the language and title vetoes judged an empty ` +
    `string and kept everything. Only the ledger was applied. The browse step ` +
    `must write a "title" per row (docs/refresh-task.md, "Output — ` +
    `.cache/browser-latest.json").`);
}
