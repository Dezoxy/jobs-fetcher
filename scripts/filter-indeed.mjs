#!/usr/bin/env node
// Applies the deterministic vetoes and the rejected ledger to Indeed rows.
//
//   node scripts/filter-indeed.mjs [<in>] [-o <out>]
//     in  = .cache/indeed-latest.json   (scripts/fetch-indeed.py)
//     out = .cache/indeed-filtered.json
//
// The rules are filter-browser.mjs's, for LinkedIn, through the same two
// functions: ledgerLookup (ledger.mjs) first, then judgeLinkedIn (vetoes.mjs)
// for the gender-tag, aggregator-company, title and location vetoes.
// judgeLinkedIn and not judgeProfession, because JobSpy writes Indeed's
// location as "<city>, <admin1 code>, Hungary" (e.g. "Budapest, PE, Hungary"),
// city first and country last: the LinkedIn shape locationVetoLinkedIn parses.
// judgeProfession reads split(",")[1] and would take "PE" for the city.
//
// Then one Indeed-only rule, veto:indeed-offtopic (added 2026-11-24). Indeed
// treats the OR groups in LINKEDIN_QUERIES loosely: on the first live run,
// `(site reliability OR sre)` returned Kitchen Helper, Host/Hostess, Depot
// Operator and Cash Application Analyst, and 23 of 30 rows survived the LinkedIn
// vetoes, most of them off-topic. A row is kept only when its title hits
// CORE_ANCHOR (vetoes.mjs) or INDEED_ROLE_FAMILY below, which is the query
// families themselves (engineer, architect, devops, platform, cloud,
// infrastructure, ai/genai/llm, azure/aws/gcp, sre) plus IT-qualified analyst
// and consultant titles and an explicit "IT". Conservative on purpose: any
// engineer title passes and the judge decides; an empty title is never vetoed.
// Like every veto here it is re-evaluated each run and never ledgered.
//
// filterIndeed() is pure so scripts/v2/run.mjs can call it directly. The CLI
// carries the collector's state/reason through unchanged: an 'undetermined'
// Indeed run is degraded collection, and its partial rows are still filtered.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLedger, ledgerLookup } from "./ledger.mjs";
import { CORE_ANCHOR, judgeLinkedIn } from "./vetoes.mjs";

export const INDEED_ROLE_FAMILY = new RegExp([
  "engineer", "mérnök", "architect", "architekt", "\\bdevops\\b", "\\bplatform\\b",
  "\\bcloud\\b", "\\b(?:gen)?ai\\b", "\\bllm\\b", "\\bazure\\b", "\\baws\\b", "\\bgcp\\b",
  "\\bsre\\b", "site reliability", "infrastructure", "informatik",
  "\\b(?:it|business|data|systems?|security|bi)\\s+analyst\\b",
  "\\b(?:it|cloud|devops|security|technical|technology|infrastructure|solutions?)\\s+consultant\\b",
  "\\btech(?:nical)?\\s+lead\\b", "\\b(?:cto|cio|ciso)\\b",
].join("|"), "i");
// "IT" as a word, case-sensitive: /\bit\b/i would match the English pronoun.
const IT_WORD = /\bIT\b/;

// returns "indeed-offtopic" or null; an empty title is never vetoed
export function indeedOfftopicVeto(role) {
  const t = role || "";
  if (!t || CORE_ANCHOR.test(t) || INDEED_ROLE_FAMILY.test(t) || IT_WORD.test(t)) return null;
  return "indeed-offtopic";
}

// -> { kept, dropped, droppedRows, titled, located, malformed }
// dropped counters: language | title | company | location | ledger | veto
export function filterIndeed(rows, ledgerReason) {
  const dropped = { language: 0, title: 0, company: 0, location: 0, ledger: 0, veto: 0 };
  const droppedRows = [];
  const kept = [];
  let titled = 0, located = 0, malformed = 0;
  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== "string" || !/^in-[A-Za-z0-9]+$/.test(id)) { malformed++; continue; }
    const role = row.role ?? "";
    if (role) titled++;
    const loc = row.location ?? null;
    if (loc) located++;
    const why = ledgerReason(id);
    let reason = why ? `ledger:${why}` : judgeLinkedIn(role, row.company, loc);
    if (reason === "keep" && indeedOfftopicVeto(role)) reason = "veto:indeed-offtopic";
    if (reason === "keep") { kept.push(row); continue; }
    dropped[reason.split(":")[0]]++;
    droppedRows.push({ id, source: "Indeed", role: role || null, company: row.company ?? null,
      url: row.url ?? null, location: loc, reason });
  }
  return { kept, dropped, droppedRows, titled, located, malformed };
}

export function main(argv = process.argv.slice(2)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cache = path.join(root, ".cache");
  const oIdx = argv.indexOf("-o");
  const out = oIdx === -1 ? path.join(cache, "indeed-filtered.json") : argv[oIdx + 1];
  const input = argv.filter((a, i) => a !== "-o" && i !== oIdx + 1)[0] ?? path.join(cache, "indeed-latest.json");

  // Absent input: the collector did not run. Leave no stale output behind.
  if (!fs.existsSync(input)) {
    fs.rmSync(out, { force: true });
    console.log(`filter-indeed: ${input} absent — nothing to filter`);
    return 0;
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(input, "utf8")); } catch (e) {
    console.error(`filter-indeed: cannot parse ${input}: ${e.message}`); return 3;
  }
  if (!Array.isArray(doc?.rows)) { console.error(`filter-indeed: ${input} has no rows array`); return 3; }

  const result = filterIndeed(doc.rows, ledgerLookup(readLedger(path.join(cache, "rejected-ids.json"))));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    collectedAt: doc.collectedAt ?? null,
    filteredAt: new Date().toISOString(),
    state: doc.state ?? "undetermined",
    ...(doc.reason ? { reason: doc.reason } : {}),
    truncatedQueries: doc.truncatedQueries ?? [],
    queryFailures: doc.queryFailures ?? [],
    rows: result.kept,
    dropped: result.dropped,
    droppedRows: result.droppedRows,
    titled: result.titled,
    located: result.located,
  }, null, 2) + "\n");
  const d = result.dropped;
  console.log(`filter-indeed: state=${doc.state} in=${doc.rows.length} kept=${result.kept.length} ` +
    `titled=${result.titled} located=${result.located} dropped-language=${d.language} ` +
    `dropped-title=${d.title} dropped-company=${d.company} dropped-location=${d.location} ` +
    `dropped-ledger=${d.ledger} dropped-offtopic=${d.veto}` + (result.malformed ? ` malformed-skipped=${result.malformed}` : ""));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
