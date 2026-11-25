// The v2 merge: every rule docs/refresh-task.md sections "2. Liveness" and
// "3. Merge" used to ask an LLM to apply, as one pure, deterministic function.
//
//   merge({ jobs, verdicts, streaks, tracker, candidates, judged, liveness,
//           today, slot, sourcesQueried })
//   -> { jobs, verdictAdds, verdictReleases, streaks, cleanedDeadIds, diff,
//        warnings, stats, outcomes }
//
// Pure: no I/O, no clock, no randomness. The same inputs always give the same
// output, which is what makes a run reproducible from its inputs and lets
// run.mjs hash them for idempotency. Every timestamp it writes is `slot`.
//
// Shapes (jobs.json's own camelCase, not D1 columns — store.mjs converts):
//   jobs        [{ id, role, company, source, category, type, description,
//                  salaryLo, salaryHi, salaryPosted, benchmark, url, status,
//                  firstSeen, lastSeen, closed?, repostOf? }]
//   verdicts    { "<id>": { reason, judgeVersion: string|null, at } }   (the ledger)
//   streaks     { "<id>": <consecutive unseen runs> }
//   tracker     { "<id>": { st, at } }
//   candidates  collector rows that survived the vetoes (architecture-v2.md
//               "Candidate row"); ledgered ones are re-checked here anyway
//   judged      { verdicts: [judge verdict], judgeVersion } | null
//   liveness    { dead: [id], alive: [id] } | null  (null = the sweep failed)
//   sourcesQueried { Profession: bool, NoFluff: bool, LinkedIn: bool, Indeed: bool }
//               true only when that source was queried completely this run

import { ledgerLookup, LEGACY } from '../ledger.mjs';

export const ARCHIVE_DAYS = 14;          // public/app.js archives at ageSeen > 14
export const STREAK_RUNS = 3;
export const STREAK_DAYS = 3;
export const STATUS_BY_SOURCE = Object.freeze({
  LinkedIn: 'Értesítő', Profession: 'Értesítő', NoFluff: 'NFJ keresés', Indeed: 'Indeed',
});
export const POSITIVE = new Set(['saved', 'applied', 'interview', 'offer']);
export const NEGATIVE = new Set(['ignored', 'rejected']);
// A positive tracker status takes back the owner's own verdict and the judge's;
// it cannot overrule a fact about the ad (dead:) or a merge (dedupe:), and
// `legacy` carries no decision to take back.
export const RELEASABLE = ['tracker:', 'fit:'];
// Same id scheme validate.mjs enforces; keep the two in sync.
export const ID_PATTERN = /^(li-\d+|pr-\d+|nfj-[a-z0-9][a-z0-9-]*|in-[A-Za-z0-9]+)$/;
export const UNKNOWN_COMPANY = 'Ismeretlen cég';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIT_REASON = /^fit:[^\s<>]{1,80}$/;

// Same normalisation as the retired scripts/dedupe-jobs.mjs (the 2026-08-07 duplicate
// analysis): accents and company suffixes such as Kft./Zrt. do not count.
export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/\b(kft|zrt|nyrt|bt|ltd|hungary|magyarorszag|group|hungaria|kkt|inc|gmbh|services?|technologies)\b/g, '')
  .replace(/[^a-z0-9]+/g, '');
export const normKey = (role, company) => `${norm(role)}|${norm(company)}`;

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
export const isArchived = (row, today) => !!row.closed || daysBetween(row.lastSeen, today) > ARCHIVE_DAYS;
const streakTracked = (row) =>
  (row.source === 'Profession' && row.status === 'Értesítő') ||
  (row.source === 'NoFluff' && row.status === 'NFJ keresés');

/**
 * Tracker -> ledger. ignored/rejected adds `tracker:<st>` unless the id already
 * carries a real verdict (the first verdict is the one that kept it off the
 * list; `legacy` is claimed). A positive status releases tracker: and fit:.
 * -> { verdicts (effective ledger), adds: [{id, reason, judgeVersion, at}], releases: [id] }
 */
export function applyTracker(verdicts, tracker, at) {
  const ledger = { ...verdicts };
  const adds = [];
  const releases = [];
  for (const id of Object.keys(tracker ?? {}).sort()) {
    const st = tracker[id]?.st;
    const current = ledger[id];
    if (NEGATIVE.has(st)) {
      if (!current || current.reason === LEGACY) {
        ledger[id] = { reason: `tracker:${st}`, judgeVersion: null, at };
        adds.push({ id, ...ledger[id] });
      }
    } else if (POSITIVE.has(st) && current && RELEASABLE.some(p => current.reason.startsWith(p))) {
      delete ledger[id];
      releases.push(id);
    }
  }
  return { verdicts: ledger, adds, releases };
}

const ownerIgnored = (id, ledger, tracker) =>
  tracker[id]?.st === 'ignored' || String(ledger[id]?.reason ?? '').startsWith('tracker:ignored');

/**
 * The ledger as seen by a NEW candidate id: exact verdict first, then the NFJ
 * slug-variant fallback (ledger.mjs) — except that a variant of an ad the OWNER
 * ignored is a repost (owner decision 2026-11-24: shown and flagged, never
 * hidden), so it comes back as { repostOf } instead of a verdict.
 * -> (id) => { reason } | { repostOf } | null
 */
export function candidateLedger(ledger, tracker = {}) {
  const lookup = ledgerLookup(Object.fromEntries(Object.entries(ledger).map(([id, v]) => [id, v.reason])));
  return (id) => {
    if (Object.hasOwn(ledger, id)) return { reason: ledger[id].reason };
    const hit = lookup(id);
    if (!hit) return null;
    const sibling = hit.match(/\(slug variant of (\S+)\)$/)?.[1];
    if (sibling && ownerIgnored(sibling, ledger, tracker)) return { repostOf: sibling };
    return { reason: hit };
  };
}

/**
 * The ledger the v1 collectors get (.cache/rejected-ids.json). NFJ ids the owner
 * ignored are left out, so fetch-sources.mjs's slug fallback cannot drop their
 * reposts before merge sees them; merge still drops the exact ids.
 * -> { "<id>": "<reason>" }
 */
export function collectorLedger(ledger, tracker = {}) {
  return Object.fromEntries(Object.entries(ledger)
    .filter(([id]) => !(id.startsWith('nfj-') && ownerIgnored(id, ledger, tracker)))
    .map(([id, v]) => [id, v.reason]));
}

const tokens = (s) => new Set(String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(t => t.length > 1));
function similarRole(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared) >= 0.5;
}

/**
 * Rows the judge should see next to a candidate: exact normalised role+company
 * matches first, then same-company rows with a similar title. At most `limit`.
 */
export function findTwins(candidate, jobs, tracker = {}, limit = 5) {
  const key = normKey(candidate.role, candidate.company);
  const company = norm(candidate.company);
  const exact = [], near = [];
  for (const row of jobs) {
    if (row.id === candidate.id) continue;
    if (normKey(row.role, row.company) === key) exact.push(row);
    else if (company && norm(row.company) === company && similarRole(row.role, candidate.role)) near.push(row);
  }
  const byId = (a, b) => a.id.localeCompare(b.id);
  return [...exact.sort(byId), ...near.sort(byId)].slice(0, limit).map(row => ({
    id: row.id, role: row.role, company: row.company, status: row.status,
    tracker: tracker[row.id]?.st ?? null,
  }));
}

const isInt = (n) => Number.isInteger(n);
const text = (s) => typeof s === 'string' && s.trim().length > 0;

/** Mirror of validate.mjs's per-row checks; returns a reason or null. */
export function rowProblem(row) {
  if (!ID_PATTERN.test(row.id ?? '')) return 'malformed id';
  for (const k of ['role', 'company', 'category', 'description', 'benchmark']) if (!text(row[k])) return `missing ${k}`;
  if (!Object.hasOwn(STATUS_BY_SOURCE, row.source)) return 'bad source';
  if (!['Employee', 'Contract'].includes(row.type)) return 'bad type';
  if (!/^https:\/\//.test(row.url ?? '')) return 'url must be https';
  if (!isInt(row.salaryLo) || !isInt(row.salaryHi)) return 'salary must be integers';
  if (row.salaryLo > row.salaryHi) return 'salaryLo > salaryHi';
  if (row.salaryLo < 100000 || row.salaryHi > 10000000) return 'salary out of sane range';
  if (typeof row.salaryPosted !== 'boolean') return 'salaryPosted must be boolean';
  if (!DATE.test(row.firstSeen ?? '') || !DATE.test(row.lastSeen ?? '')) return 'bad dates';
  return null;
}

function buildRow(candidate, verdict, today) {
  const row = {
    id: candidate.id,
    role: String(candidate.role ?? '').trim(),
    // LinkedIn and Indeed can omit the company (Candidate row contract); the
    // row is still shown (owner decision 2026-11-24), with a visible placeholder.
    company: String(candidate.company ?? '').trim() || UNKNOWN_COMPANY,
    source: candidate.source,
    category: verdict.category,
    type: verdict.type,
    description: verdict.description,
    salaryLo: verdict.salaryLo,
    salaryHi: verdict.salaryHi,
    salaryPosted: verdict.salaryPosted,
    benchmark: verdict.benchmark,
    url: candidate.url,
    status: STATUS_BY_SOURCE[candidate.source],
    firstSeen: today,
    lastSeen: today,
  };
  // refresh-task.md "4. Salary": a visible NFJ band is copied verbatim, never
  // estimated over. Salary Match (not visible) stays the judge's estimate.
  const s = candidate.salary;
  if (candidate.source === 'NoFluff' && s?.visible && isInt(s.lo)) {
    row.salaryLo = s.lo;
    row.salaryHi = isInt(s.hi) ? s.hi : s.lo;
    row.salaryPosted = true;
    row.benchmark = 'hirdetett sáv';
    if (s.type === 'permanent') row.type = 'Employee';
    else if (s.type === 'b2b') row.type = 'Contract';
  }
  return row;
}

// Deterministic keeper order for same-run twins: a posted band beats an
// estimate, a probeable source (pr-/nfj-) beats one liveness cannot see well.
const keeperScore = (row) => (row.salaryPosted ? 50 : 0) + (/^(pr|nfj)-/.test(row.id) ? 25 : 0);

function streakWarning(rows, streaks, today) {
  const over = rows.filter(r => (streaks[r.id] ?? 0) >= STREAK_RUNS &&
    daysBetween(r.lastSeen, today) >= STREAK_DAYS)
    .sort((a, b) => streaks[b.id] - streaks[a.id] || a.id.localeCompare(b.id));
  if (!over.length) return null;
  const named = over.slice(0, 3).map(r => `${r.role} (${r.company}), ${streaks[r.id]} futás`);
  const rest = over.length - named.length;
  return `Streak-küszöb (${STREAK_RUNS} egymást követő napi futás, lastSeen legalább ${STREAK_DAYS} UTC-nappal korábban) ` +
    `fölött ${over.length} sor: ${named.join('; ')}${rest > 0 ? `; +${rest} további` : ''}.`;
}

export function merge({ jobs, verdicts = {}, streaks = {}, tracker = {}, candidates = [], judged = null,
  liveness = null, today, slot, sourcesQueried = {} }) {
  if (!DATE.test(today ?? '')) throw new Error('merge: today must be YYYY-MM-DD');
  if (typeof slot !== 'string' || !slot) throw new Error('merge: slot is required');
  const at = slot;
  const warnings = [];
  const outcomes = {};
  const stats = { previous: jobs.length, seen: 0, alive: 0, added: 0, deleted: 0, closed: 0,
    fitRejected: 0, deduped: 0, reposts: 0, unjudged: 0, ledgered: 0, invalid: 0 };

  // Exact duplicate ids are a bug worth reporting, never silently merged.
  const seenIds = new Set();
  const input = [];
  for (const row of jobs) {
    if (seenIds.has(row.id)) { warnings.push(`Duplikált id a bemenetben, a második példány eldobva: ${row.id}`); continue; }
    seenIds.add(row.id);
    input.push(row);
  }

  // 1. Tracker verdicts first, so this run's own filtering already honours them.
  const { verdicts: ledger, adds: trackerAdds, releases } = applyTracker(verdicts, tracker, at);
  // Existing rows: exact verdicts only — a slug sibling's verdict must not
  // freeze another row's lastSeen. New candidates: candidateLedger.
  const reasonOf = (id) => ledger[id]?.reason ?? null;
  const newLedger = candidateLedger(ledger, tracker);
  const present0 = new Set(input.map(r => r.id));
  const repostHint = new Map();
  const adds = new Map(trackerAdds.map(a => [a.id, a]));
  const addVerdict = (id, reason, judgeVersion = null) => {
    if (adds.has(id)) return;
    const current = ledger[id];
    if (current && current.reason !== LEGACY) return; // first verdict wins
    adds.set(id, { id, reason, judgeVersion, at });
  };

  // 2. Candidates: one per id, ledgered ones are not "seen" (their frozen
  //    lastSeen is what ages them into the archive).
  const byCandidate = new Map();
  for (const c of candidates) {
    if (!c || typeof c.id !== 'string' || byCandidate.has(c.id)) continue;
    if (!Object.hasOwn(STATUS_BY_SOURCE, c.source)) { outcomes[c.id] = 'invalid'; stats.invalid++; continue; }
    const hit = present0.has(c.id) ? (reasonOf(c.id) && { reason: reasonOf(c.id) }) : newLedger(c.id);
    if (hit?.reason) { outcomes[c.id] = 'ledgered'; stats.ledgered++; continue; }
    if (hit?.repostOf) repostHint.set(c.id, hit.repostOf);
    byCandidate.set(c.id, c);
  }
  const dead = new Set(liveness?.dead ?? []);
  const alive = new Set(liveness?.alive ?? []);

  // 3. Existing rows: liveness, bumps. Status is never changed.
  const out = [];
  const removed = [];
  const before = new Map(input.map(r => [r.id, JSON.stringify(r)]));
  for (const original of input) {
    const row = { ...original };
    const id = row.id;
    if (byCandidate.has(id)) outcomes[id] = 'seen';
    if (dead.has(id)) {
      // Owner decision 2026-11-24: an ad the owner touched (Mentett, or any
      // tracker status) is closed once and kept, status unchanged, no dead:
      // verdict. Only an untouched feed row is deleted.
      if (row.status === 'Mentett' || tracker[id]) {
        if (!row.closed) { row.closed = today; stats.closed++; }
      } else {
        // A confirmed-dead, untouched feed row carries no curation: delete and ledger it.
        removed.push(id);
        addVerdict(id, 'dead:liveness');
        stats.deleted++;
        continue;
      }
      out.push(row);
      continue;
    }
    // Legacy Mentett rows and ledgered rows are never bumped.
    if (row.status !== 'Mentett' && !reasonOf(id)) {
      if (byCandidate.has(id)) { if (row.lastSeen < today) row.lastSeen = today; stats.seen++; }
      else if (alive.has(id)) { if (row.lastSeen < today) row.lastSeen = today; stats.alive++; }
    }
    out.push(row);
  }

  // 4. Unseen streaks: machine feeds that return their full result set only,
  //    and only when that source was queried completely this run.
  const nextStreaks = {};
  for (const row of out) {
    if (!streakTracked(row) || row.closed || reasonOf(row.id) || byCandidate.has(row.id)) continue;
    const prev = Number.isInteger(streaks[row.id]) ? streaks[row.id] : 0;
    if (sourcesQueried[row.source] === true) nextStreaks[row.id] = prev + 1;
    else if (prev > 0) nextStreaks[row.id] = prev;
  }
  const warnStreak = streakWarning(out, nextStreaks, today);
  if (warnStreak) warnings.push(warnStreak);

  // 5. New candidates: judged keep -> appended unless a live cross-source twin
  //    exists; judged reject -> fit: verdict; no valid verdict -> retried next run.
  const present = new Set(out.map(r => r.id));
  const judgedById = new Map();
  for (const v of judged?.verdicts ?? []) {
    if (v && typeof v.id === 'string' && typeof v.keep === 'boolean' && !judgedById.has(v.id)) judgedById.set(v.id, v);
  }
  const judgeVersion = typeof judged?.judgeVersion === 'string' ? judged.judgeVersion : null;
  const keepers = [];
  const unjudged = [];
  for (const c of byCandidate.values()) {
    if (present.has(c.id) || removed.includes(c.id)) continue;
    const v = judgedById.get(c.id);
    if (!v) { unjudged.push(c.id); continue; }
    if (!v.keep) {
      // A fit: verdict is only ever ledgered with the judge version that made it.
      if (!judgeVersion) { unjudged.push(c.id); continue; }
      addVerdict(c.id, FIT_REASON.test(v.reason ?? '') ? v.reason : 'fit:unspecified', judgeVersion);
      outcomes[c.id] = 'fit'; stats.fitRejected++;
      continue;
    }
    const row = buildRow(c, v, today);
    const problem = rowProblem(row);
    if (problem) { unjudged.push(c.id); warnings.push(`Érvénytelen értékelés, a sor kimaradt (${c.id}: ${problem}); a következő futás újra megpróbálja.`); continue; }
    keepers.push({ row, duplicateOf: typeof v.duplicateOf === 'string' ? v.duplicateOf : null, hint: repostHint.get(c.id) ?? null });
  }
  for (const id of unjudged) { outcomes[id] ??= 'unjudged'; }
  stats.unjudged = unjudged.length;
  if (unjudged.length) {
    warnings.push(`${unjudged.length} új jelölt nem kapott érvényes értékelést; nem került be és nincs ledgerelve, a következő futás újra értékeli.`);
  }

  keepers.sort((a, b) => keeperScore(b.row) - keeperScore(a.row) || a.row.id.localeCompare(b.row.id));
  const urls = new Set(out.map(r => r.url));
  const byId = new Map(out.map(r => [r.id, r]));
  const live = (r) => !isArchived(r, today) && !dead.has(r.id);
  const added = [];
  for (const { row, duplicateOf, hint } of keepers) {
    const key = normKey(row.role, row.company);
    // Owner decision 2026-11-24: a repost of an ad the owner ignored is shown
    // and flagged, never suppressed — this outranks the duplicate rule. An NFJ
    // slug variant of an ignored id is one even when that row is long gone.
    const named = duplicateOf ? byId.get(duplicateOf) : null;
    const ignoredTwin = named && tracker[named.id]?.st === 'ignored' ? named :
      hint ? { id: hint } :
      out.filter(r => tracker[r.id]?.st === 'ignored' && normKey(r.role, r.company) === key)
        .sort((a, b) => String(tracker[b.id].at).localeCompare(String(tracker[a.id].at)) || a.id.localeCompare(b.id))[0];
    if (!ignoredTwin) {
      // refresh-task.md "3. Merge": a live, non-archived twin from a DIFFERENT
      // source means this is the same ad on another portal. Same-source twins
      // are genuine parallel openings; an archived twin makes this a repost.
      const twin = named && named.source !== row.source && live(named) ? named :
        out.filter(r => r.source !== row.source && live(r) && normKey(r.role, r.company) === key)
          .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (twin) {
        addVerdict(row.id, `dedupe:${twin.id}`);
        outcomes[row.id] = 'dedupe'; stats.deduped++;
        continue;
      }
    }
    if (urls.has(row.url)) {
      warnings.push(`Új sor kimaradt, mert az URL-je már egy másik sorhoz tartozik: ${row.id}`);
      outcomes[row.id] = 'url-conflict';
      continue;
    }
    if (ignoredTwin) { row.repostOf = ignoredTwin.id; stats.reposts++; outcomes[row.id] = 'repost'; }
    else outcomes[row.id] = 'added';
    out.push(row); byId.set(row.id, row); urls.add(row.url); added.push(row.id);
  }
  stats.added = added.length;
  stats.total = out.length;

  let updated = 0;
  for (const row of out) {
    const prev = before.get(row.id);
    if (prev !== undefined && prev !== JSON.stringify(row)) updated++;
  }
  return {
    jobs: out,
    verdictAdds: [...adds.values()],
    verdictReleases: releases,
    streaks: nextStreaks,
    cleanedDeadIds: removed,
    diff: { added, removed, updated },
    warnings,
    stats,
    outcomes,
  };
}
