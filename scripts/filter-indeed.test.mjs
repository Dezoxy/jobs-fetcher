// Indeed rows go through the LinkedIn vetoes and the ledger. `npm test`.
//
// The location strings are the shape JobSpy 1.5.0 produced against
// hu.indeed.com on 2026-11-24: "<city>, <admin1 code>, Hungary".

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filterIndeed, indeedOfftopicVeto, main } from "./filter-indeed.mjs";

const row = (id, role, location = "Budapest, PE, Hungary", company = "Example Zrt.") =>
  ({ id, source: "Indeed", role, company, location, url: `https://hu.indeed.com/viewjob?jk=${id.slice(3)}` });
const none = () => null;

test("keeps a Budapest DevOps row and reads the city, not the admin1 code", () => {
  const { kept, dropped } = filterIndeed([row("in-a1", "DevOps Engineer")], none);
  assert.equal(kept.length, 1);
  assert.equal(Object.values(dropped).reduce((a, b) => a + b), 0);
});

test("applies the title, language, company and location vetoes", () => {
  const rows = [
    row("in-b1", "Junior Cloud Engineer"),
    row("in-b2", "Platform Engineer (f/m/x)"),
    row("in-b3", "DevOps mérnök", undefined, "wherewework.hu"),
    row("in-b4", "Manufacturing Project Engineer", "Páty, PE, Hungary"),
    row("in-b5", "Cloud Engineer", "Wien, W, Austria"),
    row("in-b6", "SAP Consultant"),
  ];
  const { kept, droppedRows } = filterIndeed(rows, none);
  assert.deepEqual(kept, []);
  assert.deepEqual(droppedRows.map((r) => r.reason), [
    "title:junior", "language:german-or-gender-tag", "company:aggregator",
    "location:provincial", "location:foreign", "title:sap",
  ]);
  assert.ok(droppedRows.every((r) => r.source === "Indeed"));
});

test("ledger verdict outranks the vetoes; malformed ids are skipped", () => {
  const ledger = { "in-c1": "tracker:ignored" };
  const { kept, dropped, droppedRows, malformed } = filterIndeed(
    [row("in-c1", "DevOps Engineer"), row("in-c2", "DevOps Engineer"), { id: "in-bad_key", role: "x" }],
    (id) => ledger[id] ?? null);
  assert.deepEqual(kept.map((r) => r.id), ["in-c2"]);
  assert.equal(dropped.ledger, 1);
  assert.equal(droppedRows[0].reason, "ledger:tracker:ignored");
  assert.equal(malformed, 1);
});

test("CLI carries an undetermined state through and filters the partial rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filter-indeed-"));
  const input = path.join(dir, "in.json"), out = path.join(dir, "out.json");
  fs.writeFileSync(input, JSON.stringify({ collectedAt: "2026-11-25T13:00:00Z", state: "undetermined",
    reason: "indeed collection degraded: 403", rows: [row("in-d1", "SRE"), row("in-d2", "Junior SRE")] }));
  const log = console.log;
  console.log = () => {};
  try { assert.equal(main([input, "-o", out]), 0); } finally { console.log = log; }
  const doc = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(doc.state, "undetermined");
  assert.equal(doc.reason, "indeed collection degraded: 403");
  assert.deepEqual(doc.rows.map((r) => r.id), ["in-d1"]);
  assert.equal(doc.dropped.title, 1);
});

// Titles from the 2026-11-24 live run that the LinkedIn vetoes let through.
const OFFTOPIC = ["Kitchen Helper", "Host/Hostess", "Depot Operator", "Administrative Services Officer",
  "Supply Chain CI Manager", "Supply Chain Future Leader Program (Budapest)", "Cash Application Analyst",
  "Product Owner", "Specialist - External Supply & Corporate Quality"];
const ON_TOPIC = ["DevOps Engineer", "Senior Devops Engineer (100% Remote, Worldwide)", "IT Application Engineer",
  "Engineering Manager, Performance Engineering", "(fluent English) Cyber Threat Intelligence Analyst (remote)",
  "Senior Business Analyst", "IT Implementation Project Manager, Operations Digitalization",
  "Solution Architect", "Megoldásarchitekt", "Platformmérnök (Azure)", "Rendszergazda", "Site Reliability Lead",
  "GenAI Specialist", "AWS Cloud Specialist", "Data Analyst", "IT Consultant (Sales Solutions)", "Technical Lead", "CISO",
  "Informatikus", "LLM Ops Specialist", "Kubernetes Specialist"];

test("off-topic veto drops the live noise and keeps tech titles", () => {
  for (const t of OFFTOPIC) assert.equal(indeedOfftopicVeto(t), "indeed-offtopic", t);
  for (const t of ON_TOPIC) assert.equal(indeedOfftopicVeto(t), null, t);
  // "it" the pronoun and an unreadable title never count
  assert.equal(indeedOfftopicVeto("Make it happen Coordinator"), "indeed-offtopic");
  assert.equal(indeedOfftopicVeto(""), null);
});

test("off-topic veto runs after the ledger and the LinkedIn vetoes, with its own reason", () => {
  const ledger = { "in-e1": "tracker:ignored" };
  const { kept, dropped, droppedRows } = filterIndeed([
    row("in-e1", "Kitchen Helper"), row("in-e2", "Junior Host"), row("in-e3", "Host/Hostess"),
    row("in-e4", "Cloud Engineer"),
  ], (id) => ledger[id] ?? null);
  assert.deepEqual(kept.map((r) => r.id), ["in-e4"]);
  assert.deepEqual(droppedRows.map((r) => r.reason),
    ["ledger:tracker:ignored", "title:junior", "veto:indeed-offtopic"]);
  assert.equal(dropped.veto, 1);
});
