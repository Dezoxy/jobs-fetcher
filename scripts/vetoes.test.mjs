// Tests for the deterministic vetoes. `npm test` (node --test, no deps).
//
// vetoes.mjs is the one place where a regex edit silently changes what
// reaches the dashboard: every rule here was calibrated against hand-judged
// rows, and a widened pattern shows up as "the list got quieter", not as an
// error. These cases pin the calibration to the rows that produced it.
//
// The Jobgether case is the point of the file, not filler — see
// "Aggregator veto" in vetoes.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeLinkedIn, judgeProfession, companyVeto, titleVeto, locationVetoLinkedIn } from "./vetoes.mjs";

// The nine wherewework rows in jobs.json on 2026-08-29, verbatim. Every one
// of these titles hits CORE_ANCHOR, which is why the company rule has to run
// before the title rule.
const WHEREWEWORK_TITLES = [
  "Vezető DevOps mérnök",
  "DevOps mérnök",
  "DevOps mérnök (Docker)",
  "Platformmérnök (Azure)",
  "Platformmérnök (AWS)",
  "Platformmérnök (Ansible)",
  "Infrastruktúra-mérnök (Azure)",
  "Infrastruktúra-mérnök (AWS)",
  "Megoldásarchitekt",
];

test("aggregator: every wherewework row is dropped, whatever the title", () => {
  for (const role of WHEREWEWORK_TITLES) {
    assert.equal(judgeLinkedIn(role, "wherewework Jobs"), "company:aggregator", role);
  }
});

test("aggregator: the company rule outranks a CORE_ANCHOR title", () => {
  // "DevOps mérnök" anchors, so titleVeto alone lets it through. If these two
  // ever swap order the whole veto goes inert without failing anything.
  assert.equal(titleVeto("DevOps mérnök"), null);
  assert.equal(judgeLinkedIn("DevOps mérnök", "wherewework Jobs"), "company:aggregator");
});

test("aggregator: name matching is case- and suffix-tolerant, but anchored", () => {
  assert.equal(companyVeto("wherewework Jobs"), "aggregator");
  assert.equal(companyVeto("WhereWeWork"), "aggregator");
  assert.equal(companyVeto("wherewework.hu"), "aggregator");
  // Anchored at the start: a real employer whose name merely contains the
  // word is not an aggregator.
  assert.equal(companyVeto("Acme wherewework Kft."), null);
});

test("aggregator: Jobgether is NOT vetoed — it reposts real ads", () => {
  // The 2026-08-29 19:16 run picked the first of these as the day's best
  // find. A broad "job board" rule would have deleted it before triage.
  assert.equal(
    judgeLinkedIn("Infrastructure Engineer – Vulnerability, DevOps & Automation", "Jobgether"),
    "keep");
  assert.equal(
    judgeLinkedIn("Lead Site Reliability Engineer - Imunify Reliability Platform", "Jobgether"),
    "keep");
});

test("aggregator: ordinary employers are untouched", () => {
  assert.equal(judgeLinkedIn("DevOps Engineer", "Ericsson"), "keep");
  assert.equal(judgeLinkedIn("Senior Platform Engineer", "ALDI International IT Services"), "keep");
  assert.equal(companyVeto("Magyar Telekom Nyrt."), null);
});

test("aggregator: a missing company never invents a drop", () => {
  // Callers without a company must keep the pre-2026-08-29 behaviour.
  assert.equal(companyVeto(undefined), null);
  assert.equal(companyVeto(null), null);
  assert.equal(companyVeto(""), null);
  assert.equal(judgeLinkedIn("DevOps Engineer"), "keep");
  assert.equal(judgeLinkedIn("Junior DevOps Engineer"), "title:junior");
});

test("existing LinkedIn rules still hold", () => {
  assert.equal(judgeLinkedIn("Junior Cloud Engineer", "Ericsson"), "title:junior");
  assert.equal(judgeLinkedIn("DevOps Engineer (m/w/d)", "Ericsson"), "language:german-or-gender-tag");
  assert.equal(judgeLinkedIn("Cloud Engineer (gn)", "Ericsson"), "language:german-or-gender-tag");
  assert.equal(judgeLinkedIn("SAP Consultant", "Deloitte"), "title:sap");
  // CORE_ANCHOR rescues the soft vetoes — the calibrated examples.
  assert.equal(judgeLinkedIn("Platform Engineer (SAP BTP)", "Deloitte"), "keep");
  assert.equal(judgeLinkedIn("IAM Consultant", "Deloitte"), "keep");
});

test("judgeLinkedIn('') still keeps — the 2026-08-12..08-21 outage shape", () => {
  // Documented, not desired: an empty title makes the title vetoes inert.
  // fetch-linkedin.mjs prevents it upstream (titled === rowCount by
  // construction) and filter-browser.mjs warns loudly if it recurs. Pinned
  // here so a change to this behaviour is a deliberate one.
  assert.equal(judgeLinkedIn("", "Ericsson"), "keep");
  // The company rule does still fire on a titleless row.
  assert.equal(judgeLinkedIn("", "wherewework Jobs"), "company:aggregator");
});

test("judgeProfession is unchanged by the aggregator veto", () => {
  assert.equal(judgeProfession("DevOps Engineer", "Pest megye, Budapest"), "keep");
  assert.equal(judgeProfession("DevOps Engineer", "Hajdú-Bihar megye, Debrecen"), "location:provincial");
  assert.equal(judgeProfession("DevOps Engineer", "Németország, München"), "location:foreign");
  assert.equal(judgeProfession("DevOps Engineer", "Országos"), "keep");
  assert.equal(judgeProfession("Junior DevOps Engineer", "Pest megye, Budapest"), "title:junior");
});


// ---------------------------------------------------------------------------
// LinkedIn location veto (added 2026-09-07)
//
// The rows that motivated it, verbatim from the run notes: all three reached
// the merge agent and were rejected by hand because nothing read `location`.
const PROVINCIAL_ADS = [
  ["Global Manufacturing Facilities and Sustainability Leader", "HARMAN International",
   "Székesfehérvár, Fejér, Hungary"],                        // 2026-09-07, the only survivor that run
  ["Lead Engineer Digital Manufacturing Solutions", "Infineon Technologies",
   "Cegléd, Pest, Hungary"],                                 // 2026-09-05
  ["Systems Verification Engineer", "Gentherm",
   "Pilisszentiván, Pest, Hungary"],                         // 2026-09-05
];

test("location: the provincial ads that reached the merge agent are now dropped", () => {
  for (const [role, company, loc] of PROVINCIAL_ADS) {
    assert.equal(judgeLinkedIn(role, company, loc), "location:provincial", `${role} @ ${loc}`);
  }
});

test("location: Cegléd and Pilisszentiván are Pest county but not metro", () => {
  // The county segment must never be what decides this — both of these carry
  // "Pest" in the middle segment and are still provincial.
  assert.equal(locationVetoLinkedIn("Cegléd, Pest, Hungary"), "provincial");
  assert.equal(locationVetoLinkedIn("Pilisszentiván, Pest, Hungary"), "provincial");
  // ...while a genuine metro town in the same county is kept.
  assert.equal(locationVetoLinkedIn("Vecsés, Pest, Hungary"), null);
  assert.equal(locationVetoLinkedIn("Gödöllő, Pest, Hungary"), null);
});

test("location: every Budapest shape LinkedIn actually emits is kept", () => {
  // Counted from .cache/browser-latest.json, 73 rows, 2026-08-31.
  for (const loc of ["Budapest, Budapest, Hungary", "Budapest, Hungary",
                     "Budapest Metropolitan Area", "Budapest Metropolitan Area, Hungary"]) {
    assert.equal(locationVetoLinkedIn(loc), null, loc);
  }
});

test("location: a value with no city segment is kept, never guessed at", () => {
  // "Hungary" was 10 of those 73 rows — countrywide or remote, not provincial.
  assert.equal(locationVetoLinkedIn("Hungary"), null);
  assert.equal(locationVetoLinkedIn("Remote"), null);
  assert.equal(locationVetoLinkedIn(""), null);
  assert.equal(locationVetoLinkedIn(null), null);
  assert.equal(locationVetoLinkedIn(undefined), null);
});

test("location: foreign is caught in English, which FOREIGN_LOC cannot see", () => {
  // FOREIGN_LOC only knows the Hungarian spellings, so the country test has to
  // come from the last segment rather than from that regex.
  assert.equal(locationVetoLinkedIn("Munich, Bavaria, Germany"), "foreign");
  assert.equal(locationVetoLinkedIn("Vienna, Austria"), "foreign");
  // ...and the Hungarian spellings still work, wherever they appear.
  assert.equal(locationVetoLinkedIn("Bécs, Ausztria"), "foreign");
});

test("location: judgeLinkedIn runs it last, so earlier reasons are unchanged", () => {
  // Every row that was dropped before this rule existed must keep the reason it
  // already had — otherwise the ledger's stored reasons stop matching.
  assert.equal(judgeLinkedIn("Junior DevOps Engineer", "Acme", "Debrecen, Hajdú-Bihar, Hungary"),
    "title:junior");
  assert.equal(judgeLinkedIn("DevOps mérnök", "wherewework Jobs", "Cegléd, Pest, Hungary"),
    "company:aggregator");
  assert.equal(judgeLinkedIn("Cloud Engineer (m/w/d)", "Acme", "Cegléd, Pest, Hungary"),
    "language:german-or-gender-tag");
});

test("location: a Budapest row with a clean title still keeps", () => {
  assert.equal(judgeLinkedIn("Cloud Engineer", "Acme", "Budapest, Hungary"), "keep");
  // No location argument at all = the pre-2026-09-07 call shape, still keeps.
  assert.equal(judgeLinkedIn("Cloud Engineer", "Acme"), "keep");
});

test("location: Profession's parser is NOT the LinkedIn one", () => {
  // Profession puts the city SECOND ("<megye>, <város>"), LinkedIn puts it
  // FIRST. Sharing one parser would read the county as the city and drop
  // almost everything; this pins both readings.
  assert.equal(judgeProfession("Cloud Engineer", "Pest megye, Budapest"), "keep");
  assert.equal(judgeProfession("Cloud Engineer", "Hajdú-Bihar megye, Debrecen"), "location:provincial");
  // The same two strings read as LinkedIn locations would be judged on the
  // first segment instead — which is exactly why they are separate functions.
  assert.equal(locationVetoLinkedIn("Budapest, Budapest, Hungary"), null);
});
