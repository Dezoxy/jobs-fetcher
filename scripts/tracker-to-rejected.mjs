#!/usr/bin/env node
// Feedback loop: a dashboard tracker export -> .cache/rejected-ids.json.
//
//   node scripts/tracker-to-rejected.mjs <jobs-tracker-YYYY-MM-DD.json> [--dry-run]
//
// Export the file from the dashboard footer ("Exportálás"), then run this.
//
// Why this exists (measured 2026-08-07 on a 519-id export against a 764-row
// jobs.json): 508 of those ids were rows still in jobs.json, and only **5** of
// the 519 were in the rejected ledger. Every "Nem érdekel" click was landing in
// localStorage and nowhere else, so the fetcher kept re-offering those ads and
// the fit filter kept re-judging them every six hours. The tracker was a
// read-only opinion; this makes it an input.
//
// Scope: `ignored` and `rejected` only. Those are the two negative markers in
// public/app.js (see TRACKER_LABELS / the isVisible comment) — every other
// status is neutral or positive and must never reach the ledger.
//
// The reverse direction (added 2026-09-15): a positive status — saved,
// applied, interview, offer — releases that id's earlier `tracker:` verdict
// from the ledger, so changing your mind on the dashboard actually reaches the
// refresh. See planRelease in scripts/ledger.mjs for why only `tracker:`.
//
// This script does NOT touch public/data/jobs.json. Ledgered rows that are
// still in the file stop being refreshed, so their `lastSeen` freezes and the
// UI's own 14-day staleness rule archives them. That is the intended path:
// deleting curated rows outright would be irreversible, and their disappearance
// would fire notify-diff.mjs's "Eltűnt a fájlból — ez nem várt" alarm, which is
// exactly the signal that must stay trustworthy.
import fs from "node:fs";
import path from "node:path";
import { mergeLedger, previewLedger, releaseLedger } from "./ledger.mjs";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const SRC = argv.find((a) => !a.startsWith("--"));
if (!SRC) {
  console.error("usage: tracker-to-rejected.mjs <tracker-export.json> [--dry-run]");
  process.exit(2);
}

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const LEDGER = path.join(ROOT, ".cache", "rejected-ids.json");
const JOBS = path.join(ROOT, "public", "data", "jobs.json");

// Must match the negative half of TRACKER_STATUSES in public/app.js.
const NEGATIVE = new Set(["ignored", "rejected"]);
const POSITIVE = new Set(["saved", "applied", "interview", "offer"]);

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};

const tracker = readJson(SRC, null);
if (!tracker || typeof tracker !== "object" || Array.isArray(tracker)) {
  console.error(`${SRC} is not a tracker export ({ "<id>": { "st": ..., "at": ... } })`);
  process.exit(2);
}

// Carry the tracker's own verdict into the ledger as the reason — "the user
// hid it" and "the user rejected it" are different facts and the ledger is
// now the only place either of them survives.
const negativeEntries = Object.entries(tracker)
  .filter(([, v]) => v && typeof v === "object" && NEGATIVE.has(v.st));
const negatives = negativeEntries.map(([id]) => id);
const additions = Object.fromEntries(negativeEntries.map(([id, v]) => [id, `tracker:${v.st}`]));

// Release before the early exit below: a tracker with no negatives left can
// still carry a reversal.
const positives = Object.entries(tracker)
  .filter(([, v]) => v && typeof v === "object" && POSITIVE.has(v.st))
  .map(([id]) => id);
const release = releaseLedger(LEDGER, positives, { dryRun: DRY });
const heldIds = Object.keys(release.held);
console.log(`released from ledger (positive tracker status): ${release.released.length}` +
  (release.released.length ? ` — ${release.released.join(", ")}` : ""));
if (heldIds.length) {
  console.log(`positive status but held by a non-tracker verdict: ${heldIds.length} — ` +
    heldIds.map((id) => `${id} (${release.held[id]})`).join(", "));
}

if (negatives.length === 0) {
  console.log("No `ignored` / `rejected` entries in the export — nothing to ledger.");
  process.exit(0);
}

// Ledger I/O lives in scripts/ledger.mjs — it reads the legacy flat array as
// well as the current { ids: { "<id>": "<reason>" } } shape, and always writes
// the latter. An id already ledgered keeps its first reason.
const counts = DRY ? previewLedger(LEDGER, additions) : mergeLedger(LEDGER, additions);

// Reporting only — jobs.json is never written here.
const jobs = readJson(JOBS, null)?.jobs ?? [];
const byId = new Map(jobs.map((j) => [j.id, j]));
const stillPresent = negatives.filter((id) => byId.has(id));
const byStatus = {};
for (const id of stillPresent) {
  const s = byId.get(id).status ?? "?";
  byStatus[s] = (byStatus[s] ?? 0) + 1;
}

console.log(`negative tracker entries: ${negatives.length} (ignored + rejected)`);
console.log(`ledger: ${counts.before} -> ${counts.after} (+${counts.added} new` +
  (counts.upgraded ? `, ${counts.upgraded} legacy entries gained a reason` : "") + ")");
console.log(`already ledgered: ${negatives.length - counts.added}`);
console.log(`still rows in jobs.json: ${stillPresent.length}`, byStatus);
console.log(
  stillPresent.length
    ? `\nThose ${stillPresent.length} rows stop being refreshed from now on and archive ` +
      `themselves 14 days after their last sighting. They must not be streak-tracked ` +
      `in the meantime — see docs/refresh-task.md, step 3.`
    : "");
if (DRY) console.log("--dry-run: nothing written.");
