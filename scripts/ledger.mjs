// The rejected-ids ledger: which ids must never be offered again, and WHY.
//
// Shape (schema 2, 2026-08-11):
//   { "ids": { "<id>": "<reason>", ... } }
//
// It used to be a flat array of id strings, which made "why is this job not on
// my dashboard?" unanswerable after the fact — the id was there, the reason
// was nowhere. fetch-sources.mjs has always accepted the object form (it reads
// Object.keys(raw.ids)), so only the writers needed to change; a flat array on
// disk still loads, with every entry marked "legacy".
//
// Reasons are short, greppable, and prefixed by who decided:
//   tracker:ignored   the user hid it on the dashboard
//   tracker:rejected  the user marked it rejected
//   dedupe:<keeper>   a cross-source duplicate, merged into <keeper>
//   fit:<note>        the refresh agent's fit filter (see docs/refresh-task.md)
//
// Deliberately NOT in here: the fetcher's deterministic vetoes. A mechanical
// rule re-evaluates itself on every run for free, and ledgering its output
// would freeze the verdict — loosening a veto later would have no effect on
// anything it had already dropped. Those go to sources-latest.json's
// droppedRows instead, which is rewritten each run.

import fs from "node:fs";
import path from "node:path";

export const LEGACY = "legacy";

/** -> { "<id>": "<reason>" }; missing/malformed file yields {} */
export function readLedger(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
  if (Array.isArray(raw)) return Object.fromEntries(raw.map((id) => [id, LEGACY]));
  const ids = raw?.ids;
  if (!ids || typeof ids !== "object" || Array.isArray(ids)) return {};
  return Object.fromEntries(Object.entries(ids)
    .map(([id, why]) => [id, typeof why === "string" && why ? why : LEGACY]));
}

/** Ids only — for the fetcher, which just needs the membership test. */
export function readLedgerIds(file) {
  return new Set(Object.keys(readLedger(file)));
}

// NFJ re-slugs a re-published ad: the same title+company+city comes back as
// "<slug>-1", "<slug>-2", … Keyed on the exact id, the ledger's suppression
// leaks on every repost — observed 2026-08-24, when
// nfj-intelligence-senior-analyst-assistant-vice-president-citi-budapest-1
// arrived as a fresh candidate while the un-suffixed id had been ledgered
// since July. A verdict on an ad is a verdict on that ad, not on one URL it
// happened to have.
//
// Scoped to `nfj-` on purpose. Profession and LinkedIn ids END in their
// numeric key (pr-2961759, li-4456677054), so the same normalisation would
// reduce them to "pr-"/"li-" and suppress both corpora wholesale.
//
// Trade-off, accepted: NFJ also uses the suffix to disambiguate two genuinely
// distinct simultaneous openings (snapsoft-budapest-1 vs -4 are different
// roles). Those only collide here when title, company AND city are identical
// — at which point one verdict fairly covers the other, the same reasoning
// dedupe-jobs.mjs applies across sources. The fallback never masquerades as
// an exact hit: it appends " (slug variant of <id>)" to the reason, so
// droppedRows says which past verdict was reused and a wrong reuse is
// greppable rather than invisible.
const NFJ_PREFIX = "nfj-";
const slugBase = (id) => id.replace(/-\d+$/, "");
const driftable = (id) => id.startsWith(NFJ_PREFIX) && slugBase(id) !== NFJ_PREFIX;

/**
 * Build the ledger's membership test: exact id first, then — for NFJ ids only
 * — the slug-variant fallback described above.
 * -> (id) => "<reason>" | null
 */
export function ledgerLookup(ledger) {
  const byBase = new Map();
  // Sorted so a base claimed by several variants resolves to the same entry
  // every run. A prefix sorts before its extensions, so when the ledger holds
  // the un-suffixed original it wins; otherwise the lowest variant does.
  for (const id of Object.keys(ledger).filter(driftable).sort()) {
    const base = slugBase(id);
    if (!byBase.has(base)) byBase.set(base, id);
  }
  return (id) => {
    if (typeof id !== "string" || !id) return null;
    if (id in ledger) return ledger[id];
    if (!driftable(id)) return null;
    const hit = byBase.get(slugBase(id));
    return hit ? `${ledger[hit]} (slug variant of ${hit})` : null;
  };
}

/**
 * Merge `additions` ({id: reason}) into the ledger and write it back.
 * An id already present keeps its original reason — the first verdict is the
 * one that actually kept it off the list, and overwriting it would rewrite
 * history on every tracker import. The one exception is LEGACY: entries
 * carried over from the flat-array era have no reason to preserve, so the
 * first real verdict claims them and the backlog explains itself over time.
 * -> { before, after, added, upgraded }
 */
export function mergeLedger(file, additions) {
  const existing = readLedger(file);
  const before = Object.keys(existing).length;
  let added = 0, upgraded = 0;
  for (const [id, why] of Object.entries(additions)) {
    if (existing[id] === LEGACY && why !== LEGACY) { existing[id] = why; upgraded++; continue; }
    if (id in existing) continue;
    existing[id] = why;
    added++;
  }
  writeLedger(file, existing);
  return { before, after: before + added, added, upgraded };
}

function writeLedger(file, ledger) {
  const sorted = Object.fromEntries(
    Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ids: sorted }, null, 2) + "\n");
}

// The ledger keeps the FIRST verdict, the tracker keeps the LATEST one, and
// until 2026-09-15 nothing reconciled the two: an ad hidden on the dashboard
// and later marked "Elmentve" stayed ledgered, so the refresh never bumped its
// lastSeen and a live, saved ad archived at 14 days. Found on MOL, OTP and MBH
// architect rows saved on 2026-09-04 that the liveness probe confirmed alive
// on every run since.
//
// Only a `tracker:` verdict is released. The user can take back their own
// decision; they cannot overrule a fact about the ad — `dead:` is the probe
// having proven it gone (two such saved rows existed on 2026-09-15), and
// `dedupe:` would bring a merged duplicate back. `fit:` and `legacy` stay too:
// a saved row blocked by one is surfaced in the import's output, not guessed at.
export const RELEASABLE_PREFIX = "tracker:";

/**
 * Split `ids` against the ledger into the ones a positive tracker status
 * releases and the ones held by a verdict the user cannot undo.
 * -> { released: [id], held: { "<id>": "<reason>" } }
 */
export function planRelease(ledger, ids) {
  const released = [];
  const held = {};
  for (const id of ids) {
    if (!(id in ledger)) continue;
    if (ledger[id].startsWith(RELEASABLE_PREFIX)) released.push(id);
    else held[id] = ledger[id];
  }
  return { released, held };
}

/** Apply planRelease to the ledger file; writes only when something is released. */
export function releaseLedger(file, ids, { dryRun = false } = {}) {
  const existing = readLedger(file);
  const plan = planRelease(existing, ids);
  if (!dryRun && plan.released.length) {
    for (const id of plan.released) delete existing[id];
    writeLedger(file, existing);
  }
  return plan;
}

/** Same merge, but computes the numbers without touching disk (--dry-run). */
export function previewLedger(file, additions) {
  const existing = readLedger(file);
  const before = Object.keys(existing).length;
  const added = Object.keys(additions).filter((id) => !(id in existing)).length;
  const upgraded = Object.entries(additions)
    .filter(([id, why]) => existing[id] === LEGACY && why !== LEGACY).length;
  return { before, after: before + added, added, upgraded };
}
