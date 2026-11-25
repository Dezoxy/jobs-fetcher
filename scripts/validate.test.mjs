// validate.mjs against fixture documents: Indeed rows and repostOf. `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALIDATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "validate.mjs");

const job = (over = {}) => ({
  id: "li-4441024544", role: "DevOps Engineer", company: "Example Bank Zrt.", source: "LinkedIn",
  category: "DevOps", type: "Employee", description: "Kubernetes platform.",
  salaryLo: 1400000, salaryHi: 1950000, salaryPosted: true, benchmark: "posted",
  url: "https://www.linkedin.com/jobs/view/4441024544/", status: "Értesítő",
  firstSeen: "2026-11-24", lastSeen: "2026-11-24", ...over,
});
const indeed = (over = {}) => job({ id: "in-03dbabc44a4b0866", source: "Indeed", status: "Indeed",
  url: "https://hu.indeed.com/viewjob?jk=03dbabc44a4b0866", ...over });

function validate(jobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-"));
  const file = path.join(dir, "jobs.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, generatedAt: "2026-11-25T13:00:00Z", jobs }));
  return spawnSync(process.execPath, [VALIDATE, file], { encoding: "utf8" });
}

test("accepts an Indeed row and a flagged repost; null repostOf is absent", () => {
  const run = validate([job({ repostOf: null }), indeed({ repostOf: "li-4441024544" })]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /"Indeed":1/);
});

test("rejects malformed Indeed ids", () => {
  for (const id of ["in-", "in-03dbabc4_4a4b", "in-03dbabc4-4a4b", "indeed-03dbabc44a4b0866"]) {
    const run = validate([indeed({ id })]);
    assert.equal(run.status, 1, id);
    assert.match(run.stderr, /malformed id/);
  }
});

test("rejects a bad repostOf", () => {
  for (const repostOf of [42, "", "nope", "in-03dbabc44a4b0866"]) {
    const run = validate([indeed({ repostOf })]);
    assert.equal(run.status, 1, String(repostOf));
    assert.match(run.stderr, /repostOf must be another job id/);
  }
});

test("Indeed source and status are not interchangeable with the others", () => {
  assert.equal(validate([indeed({ source: "indeed" })]).status, 1);
  assert.equal(validate([indeed({ status: "Indeed keresés" })]).status, 1);
});

test("rejects the D1 column name repost_of in jobs.json", () => {
  const run = validate([job(), indeed({ repost_of: "li-4441024544" })]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /jobs\.json uses repostOf/);
});
