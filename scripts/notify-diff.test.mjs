// notify-diff.mjs with Indeed rows and a flagged repost. `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NOTIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), "notify-diff.mjs");
const today = new Date().toISOString().slice(0, 10);

const job = (id, over = {}) => ({
  id, role: "Cloud Engineer", company: "Example Zrt.", source: "LinkedIn", category: "DevOps",
  type: "Employee", description: "x", salaryLo: 1400000, salaryHi: 1900000, salaryPosted: false,
  benchmark: "b", url: `https://example.com/${id}`, status: "Értesítő", firstSeen: today, lastSeen: today, ...over,
});

function notify(prevJobs, nextJobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-"));
  const write = (name, jobs) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), jobs }));
    return file;
  };
  const changed = path.join(dir, "changed");
  const run = spawnSync(process.execPath, [NOTIFY, write("old.json", prevJobs), write("new.json", nextJobs)],
    { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", NOTIFY_CHANGED_FILE: changed } });
  return { ...run, changed: fs.readFileSync(changed, "utf8").trim() };
}

test("new Indeed rows are listed like any other source, reposts flagged", () => {
  const base = job("li-1");
  const run = notify([base], [base,
    job("in-03dbabc44a4b0866", { role: "DevOps Engineer", source: "Indeed", status: "Indeed",
      url: "https://hu.indeed.com/viewjob?jk=03dbabc44a4b0866" }),
    job("in-f28c99b08a89eb8b", { role: "SRE", source: "Indeed", status: "Indeed",
      url: "https://hu.indeed.com/viewjob?jk=f28c99b08a89eb8b", repostOf: "li-1" }),
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.changed, "true");
  assert.match(run.stdout, /<b>Új \(2\)<\/b>/);
  assert.match(run.stdout, /⭐ <a href="https:\/\/hu\.indeed\.com\/viewjob\?jk=03dbabc44a4b0866">DevOps Engineer<\/a>\n/);
  assert.match(run.stdout, />SRE<\/a> ↻ újrafeladás\n/);
});
