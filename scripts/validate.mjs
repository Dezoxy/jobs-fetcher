#!/usr/bin/env node
// Guard rail: run before every commit. A broken jobs.json means a broken site,
// and Workers Builds will happily deploy broken data.
import fs from "node:fs";
import path from "node:path";

// Optional path argument for fixtures (scripts/validate.test.mjs); last-run.json
// is read from the same directory.
const P = process.argv[2] ?? "public/data/jobs.json";
let bad = 0;
const fail = (m) => { console.error("FAIL " + m); bad++; };

if (!fs.existsSync(P)) { console.error("FAIL missing " + P); process.exit(1); }

let doc;
try { doc = JSON.parse(fs.readFileSync(P, "utf8")); }
catch (e) { console.error("FAIL invalid JSON: " + e.message); process.exit(1); }

if (doc.schemaVersion !== 1) fail("unexpected schemaVersion: " + doc.schemaVersion);
if (!Array.isArray(doc.jobs) || doc.jobs.length === 0) fail("jobs must be a non-empty array");
if (!doc.generatedAt || isNaN(new Date(doc.generatedAt))) fail("generatedAt is not a valid date");

const REQ = ["id","role","company","source","category","type","description",
             "salaryLo","salaryHi","salaryPosted","benchmark","url","status","firstSeen","lastSeen"];
const SOURCES = new Set(["LinkedIn","Profession","NoFluff","Indeed"]);
const TYPES   = new Set(["Employee","Contract"]);
const STATUS  = new Set(["Mentett","Értesítő","NFJ keresés","Indeed"]);
const DATE    = /^\d{4}-\d{2}-\d{2}$/;
// in-<Indeed job key> added 2026-11-24 (docs/architecture-v2.md).
const ID      = /^(li-\d+|pr-\d+|nfj-[a-z0-9][a-z0-9-]*|in-[A-Za-z0-9]+)$/;

const ids = new Set(), urls = new Set();
for (const [i, j] of (doc.jobs ?? []).entries()) {
  const at = `jobs[${i}] (${j?.role ?? "?"} @ ${j?.company ?? "?"})`;
  for (const k of REQ) if (j[k] === undefined || j[k] === null) fail(`${at}: missing "${k}"`);
  if (ids.has(j.id)) fail(`${at}: duplicate id "${j.id}"`); else ids.add(j.id);
  // Id format guard, added 2026-07-29: a run once stored NFJ ids truncated
  // to 64 chars with a trailing space, which silently broke run-over-run
  // matching (36 rows had to be migrated). Ids must be exactly the scheme
  // the sources produce: li-<digits> | pr-<digits> | nfj-<lowercase url slug>
  // | in-<Indeed job key>.
  if (!ID.test(j.id ?? ""))
    fail(`${at}: malformed id "${j.id}"`);
  if (urls.has(j.url)) fail(`${at}: duplicate url`); else urls.add(j.url);
  if (!SOURCES.has(j.source)) fail(`${at}: bad source "${j.source}"`);
  if (!TYPES.has(j.type))     fail(`${at}: bad type "${j.type}"`);
  if (!STATUS.has(j.status))  fail(`${at}: bad status "${j.status}"`);
  if (!/^https:\/\//.test(j.url ?? "")) fail(`${at}: url must be https`);
  if (!Number.isInteger(j.salaryLo) || !Number.isInteger(j.salaryHi)) fail(`${at}: salary must be integers`);
  else if (j.salaryLo > j.salaryHi) fail(`${at}: salaryLo > salaryHi`);
  else if (j.salaryLo < 100000 || j.salaryHi > 10000000) fail(`${at}: salary out of sane range`);
  if (typeof j.salaryPosted !== "boolean") fail(`${at}: salaryPosted must be boolean`);
  for (const k of ["firstSeen","lastSeen"]) if (!DATE.test(j[k] ?? "")) fail(`${at}: ${k} must be YYYY-MM-DD`);
  // optional: closed = the day the liveness probe confirmed the ad gone
  if (j.closed !== undefined && !DATE.test(j.closed ?? "")) fail(`${at}: closed must be YYYY-MM-DD when present`);
  // optional: repostOf = id of an owner-ignored twin; the row is shown, flagged.
  // null and absent are equivalent; D1 stores it as repost_of (nullable).
  if (j.repostOf != null && (typeof j.repostOf !== "string" || !ID.test(j.repostOf) || j.repostOf === j.id))
    fail(`${at}: repostOf must be another job id when present`);
  // The D1 column name must never leak into jobs.json: store.mjs maps it.
  if (j.repost_of !== undefined) fail(`${at}: repost_of is the D1 column name; jobs.json uses repostOf`);
  if (DATE.test(j.firstSeen) && DATE.test(j.lastSeen) && j.firstSeen > j.lastSeen)
    fail(`${at}: firstSeen after lastSeen`);
}

// ---- optional: public/data/last-run.json (the refresh task's own note) ----
// Absent is fine. Present but malformed is not: the Telegram workflow reads it,
// and a broken file there would either break the message or leak raw JSON.
const R = path.join(path.dirname(P), "last-run.json");
if (fs.existsSync(R)) {
  let run;
  try { run = JSON.parse(fs.readFileSync(R, "utf8")); }
  catch (e) { fail(`${R}: invalid JSON: ${e.message}`); }
  if (run) {
    if (typeof run.summary !== "string" || !run.summary.trim())
      fail(`${R}: "summary" must be a non-empty string`);
    else if (run.summary.length > 1500)
      fail(`${R}: "summary" is ${run.summary.length} chars — keep it under 1500`);
    if (!run.ranAt || isNaN(new Date(run.ranAt)))
      fail(`${R}: "ranAt" is not a valid ISO timestamp`);
    if (run.warnings !== undefined &&
        (!Array.isArray(run.warnings) || run.warnings.some((w) => typeof w !== "string")))
      fail(`${R}: "warnings" must be an array of strings`);
    // Absent is fine and means "this run deleted nothing on purpose" — the
    // notifier then treats every vanished row as unexplained, which is the
    // safe direction to fail. A malformed value is not fine: it would be
    // silently ignored there and turn a real deletion into a false alarm.
    if (run.cleanedDeadIds !== undefined &&
        (!Array.isArray(run.cleanedDeadIds) ||
         run.cleanedDeadIds.some((id) => typeof id !== "string" || !id.trim())))
      fail(`${R}: "cleanedDeadIds" must be an array of non-empty id strings`);
    if (/<[a-z/]/i.test(run.summary))
      fail(`${R}: "summary" must be plain text — the notifier escapes HTML, tags will show literally`);
  }
}

if (bad) { console.error(`\n${bad} problem(s) — not safe to deploy.`); process.exit(1); }

const by = (k) => doc.jobs.reduce((a, j) => ((a[j[k]] = (a[j[k]] || 0) + 1), a), {});
console.log(`OK  ${doc.jobs.length} jobs, ${ids.size} unique ids`);
console.log("    status:", JSON.stringify(by("status")));
console.log("    source:", JSON.stringify(by("source")));
console.log("    posted salary:", doc.jobs.filter((j) => j.salaryPosted).length);
