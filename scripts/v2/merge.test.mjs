// One test per merge rule (docs/refresh-task.md "2. Liveness", "3. Merge",
// "4. Salary", plus the 2026-11-24 owner decisions in docs/architecture-v2.md),
// and a regression run over the real jobs.json frozen at cutover (tests/fixtures/jobs-2026-11-25.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { merge, applyTracker, findTwins, normKey, rowProblem, ID_PATTERN, candidateLedger, collectorLedger } from './merge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TODAY = '2026-11-25';
const SLOT = '2026-11-25T13:00:00.000Z';

let seq = 0;
function job(over = {}) {
  seq++;
  const source = over.source ?? 'Profession';
  const id = over.id ?? (source === 'LinkedIn' ? `li-${1000 + seq}` : source === 'NoFluff' ? `nfj-ad-${seq}` : source === 'Indeed' ? `in-${seq}abc` : `pr-${1000 + seq}`);
  return {
    id, role: `Role ${seq}`, company: `Company ${seq}`, source, category: 'DevOps', type: 'Employee',
    description: 'leírás', salaryLo: 1200000, salaryHi: 1800000, salaryPosted: false, benchmark: 'DevOps Senior',
    url: `https://example.com/${id}`,
    status: { LinkedIn: 'Értesítő', Profession: 'Értesítő', NoFluff: 'NFJ keresés', Indeed: 'Indeed' }[source],
    firstSeen: '2026-11-01', lastSeen: '2026-11-20', ...over,
  };
}
const cand = (row, over = {}) => ({ id: row.id, source: row.source, role: row.role, company: row.company,
  location: 'Budapest', url: row.url, ...over });
const keepVerdict = (id, over = {}) => ({ id, keep: true, reason: null, category: 'DevOps', type: 'Employee',
  salaryLo: 1500000, salaryHi: 2000000, salaryPosted: false, benchmark: 'DevOps Senior', description: 'jó', duplicateOf: null, ...over });
const run = (args) => merge({ today: TODAY, slot: SLOT, verdicts: {}, streaks: {}, tracker: {}, candidates: [],
  judged: null, liveness: null, sourcesQueried: {}, ...args });
const byId = (result, id) => result.jobs.find(j => j.id === id);

// ---- 3. Merge: existing rows ----

test('seen row: lastSeen bumped to today, firstSeen kept', () => {
  const a = job();
  const r = run({ jobs: [a], candidates: [cand(a)] });
  assert.equal(byId(r, a.id).lastSeen, TODAY);
  assert.equal(byId(r, a.id).firstSeen, a.firstSeen);
  assert.deepEqual(r.diff, { added: [], removed: [], updated: 1 });
});

test('seen row: status and every other field are never rewritten', () => {
  const a = job({ status: 'Értesítő', category: 'Security' });
  const r = run({ jobs: [a], candidates: [cand(a, { role: 'Totally different title' })] });
  assert.deepEqual(byId(r, a.id), { ...a, lastSeen: TODAY });
});

test('lastSeen is never moved backwards', () => {
  const a = job({ lastSeen: '2026-11-30' });
  const r = run({ jobs: [a], candidates: [cand(a)] });
  assert.equal(byId(r, a.id).lastSeen, '2026-11-30');
});

test('missing row that is not proven dead is left untouched', () => {
  const a = job();
  const r = run({ jobs: [a], liveness: { dead: [], alive: [] } });
  assert.deepEqual(r.jobs, [a]);
  assert.equal(r.diff.updated, 0);
});

test('ledgered row in the feed is not bumped and not counted as seen', () => {
  const a = job();
  const r = run({ jobs: [a], candidates: [cand(a)], verdicts: { [a.id]: { reason: 'fit:no-k8s', judgeVersion: 'j1', at: 'x' } } });
  assert.equal(byId(r, a.id).lastSeen, a.lastSeen);
  assert.equal(r.outcomes[a.id], 'ledgered');
});

test('ledger lookup reuses an NFJ verdict for a re-slugged repost (-1 suffix)', () => {
  const row = job({ source: 'NoFluff', id: 'nfj-cloud-engineer-acme-budapest-1' });
  const r = run({ jobs: [], candidates: [cand(row)],
    verdicts: { 'nfj-cloud-engineer-acme-budapest': { reason: 'fit:salary-floor', judgeVersion: null, at: 'x' } },
    judged: { judgeVersion: 'j1', verdicts: [keepVerdict(row.id)] } });
  assert.equal(r.outcomes[row.id], 'ledgered');
  assert.equal(r.jobs.length, 0);
});

test('slug-variant fallback never applies to li-/pr- ids', () => {
  const row = job({ source: 'LinkedIn', id: 'li-4456677054' });
  const r = run({ jobs: [], candidates: [cand(row)], verdicts: { 'li-4456677': { reason: 'fit:x', judgeVersion: null, at: 'x' } },
    judged: { judgeVersion: 'j1', verdicts: [keepVerdict(row.id)] } });
  assert.equal(r.outcomes[row.id], 'added');
});

// ---- 2. Liveness ----

test('liveness alive bumps lastSeen even when the row is in no feed', () => {
  const a = job({ source: 'LinkedIn' });
  const r = run({ jobs: [a], liveness: { dead: [], alive: [a.id] } });
  assert.equal(byId(r, a.id).lastSeen, TODAY);
  assert.equal(r.stats.alive, 1);
});

test('liveness alive never bumps a ledgered row', () => {
  const a = job({ source: 'LinkedIn' });
  const r = run({ jobs: [a], liveness: { dead: [], alive: [a.id] }, tracker: { [a.id]: { st: 'ignored', at: 't' } } });
  assert.equal(byId(r, a.id).lastSeen, a.lastSeen);
});

test('dead row is never bumped, even when a feed still lists it', () => {
  const a = job({ status: 'Mentett' });
  const r = run({ jobs: [a], candidates: [cand(a)], liveness: { dead: [a.id], alive: [] } });
  assert.equal(byId(r, a.id).lastSeen, a.lastSeen);
});

test('dead Értesítő and NFJ keresés rows are deleted, ledgered dead: and listed in cleanedDeadIds', () => {
  const a = job({ source: 'Profession' });
  const b = job({ source: 'NoFluff' });
  const r = run({ jobs: [a, b], streaks: { [a.id]: 2 }, liveness: { dead: [a.id, b.id], alive: [] }, sourcesQueried: { Profession: true, NoFluff: true } });
  assert.deepEqual(r.jobs, []);
  assert.deepEqual(r.cleanedDeadIds, [a.id, b.id]);
  assert.deepEqual(r.diff.removed, [a.id, b.id]);
  assert.deepEqual(r.verdictAdds.map(v => [v.id, v.reason, v.at]), [[a.id, 'dead:liveness', SLOT], [b.id, 'dead:liveness', SLOT]]);
  assert.deepEqual(r.streaks, {});
});

test('dead row that is already ledgered is still deleted, and keeps its first verdict', () => {
  const a = job();
  const r = run({ jobs: [a], verdicts: { [a.id]: { reason: 'tracker:ignored', judgeVersion: null, at: 'x' } }, liveness: { dead: [a.id], alive: [] } });
  assert.deepEqual(r.cleanedDeadIds, [a.id]);
  assert.deepEqual(r.verdictAdds, []);
});

test('dead Mentett row is kept and gets closed=today once; an existing closed is never changed', () => {
  const a = job({ status: 'Mentett' });
  const b = job({ status: 'Mentett', closed: '2026-10-01' });
  const r = run({ jobs: [a, b], liveness: { dead: [a.id, b.id], alive: [] } });
  assert.equal(byId(r, a.id).closed, TODAY);
  assert.equal(byId(r, b.id).closed, '2026-10-01');
  assert.deepEqual(r.cleanedDeadIds, []);
  assert.equal(r.stats.closed, 1);
});

test('dead feed row with a positive tracker status is closed once and kept: no delete, no dead: verdict, status kept', () => {
  const a = job({ source: 'LinkedIn' });
  const b = job({ source: 'Profession', closed: '2026-11-02' });
  const tracker = { [a.id]: { st: 'applied', at: 't' }, [b.id]: { st: 'saved', at: 't' } };
  const r = run({ jobs: [a, b], tracker, liveness: { dead: [a.id, b.id], alive: [] } });
  assert.deepEqual(byId(r, a.id), { ...a, closed: TODAY });
  assert.equal(byId(r, b.id).closed, '2026-11-02');
  assert.deepEqual(r.cleanedDeadIds, []);
  assert.deepEqual(r.verdictAdds, []);
  assert.equal(r.stats.closed, 1);
});

test('dead feed row the owner ignored is also kept closed (touched), so later reposts still find it', () => {
  const a = job();
  const r = run({ jobs: [a], tracker: { [a.id]: { st: 'ignored', at: 't' } }, liveness: { dead: [a.id], alive: [] } });
  assert.equal(byId(r, a.id).closed, TODAY);
  assert.deepEqual(r.cleanedDeadIds, []);
  assert.deepEqual(r.verdictAdds.map(v => v.reason), ['tracker:ignored']);
});

test('no liveness (sweep failed) means no deletes, no closes, no alive bumps', () => {
  const a = job();
  const r = run({ jobs: [a], liveness: null });
  assert.deepEqual(r.jobs, [a]);
});

// ---- Legacy Mentett ----

test('legacy Mentett rows are never bumped (feed or alive), never restatused, never deleted', () => {
  const a = job({ status: 'Mentett', source: 'LinkedIn' });
  const r = run({ jobs: [a], candidates: [cand(a)], liveness: { dead: [], alive: [a.id] } });
  assert.deepEqual(byId(r, a.id), a);
});

test('legacy Mentett rows are never streak-tracked and old entries are pruned', () => {
  const a = job({ status: 'Mentett', source: 'Profession' });
  const r = run({ jobs: [a], streaks: { [a.id]: 9 }, sourcesQueried: { Profession: true } });
  assert.deepEqual(r.streaks, {});
});

// ---- Streaks ----

test('streak: unseen Profession/NFJ row increments only when its source was queried', () => {
  const a = job({ source: 'Profession' });
  const b = job({ source: 'NoFluff' });
  const r = run({ jobs: [a, b], streaks: { [a.id]: 1, [b.id]: 4 }, sourcesQueried: { Profession: true, NoFluff: false } });
  assert.deepEqual(r.streaks, { [a.id]: 2, [b.id]: 4 });
});

test('streak: a seen row loses its entry', () => {
  const a = job();
  const r = run({ jobs: [a], candidates: [cand(a)], streaks: { [a.id]: 5 }, sourcesQueried: { Profession: true } });
  assert.deepEqual(r.streaks, {});
});

test('streak: LinkedIn, Indeed and ledgered rows are exempt and pruned; unknown ids are pruned', () => {
  const li = job({ source: 'LinkedIn' });
  const ind = job({ source: 'Indeed' });
  const led = job({ source: 'Profession' });
  const r = run({ jobs: [li, ind, led], streaks: { [li.id]: 3, [ind.id]: 3, [led.id]: 3, 'pr-1': 7 },
    verdicts: { [led.id]: { reason: 'tracker:ignored', judgeVersion: null, at: 'x' } },
    sourcesQueried: { Profession: true, LinkedIn: true, Indeed: true, NoFluff: true } });
  assert.deepEqual(r.streaks, {});
});

test('streak warning needs 3 runs AND lastSeen at least 3 UTC days old', () => {
  const fresh = job({ lastSeen: '2026-11-24' });
  const old = job({ lastSeen: '2026-11-22' });
  const r = run({ jobs: [fresh, old], streaks: { [fresh.id]: 5, [old.id]: 2 }, sourcesQueried: { Profession: true } });
  assert.equal(r.streaks[old.id], 3);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /fölött 1 sor/);
  assert.match(r.warnings[0], new RegExp(old.company));
  assert.doesNotMatch(r.warnings[0], new RegExp(`${fresh.company}\\)`));
});

test('streak warning is bounded: one line, three names, "+N további"', () => {
  const rows = Array.from({ length: 40 }, () => job({ lastSeen: '2026-11-01' }));
  const streaks = Object.fromEntries(rows.map((r, i) => [r.id, 10 + i]));
  const r = run({ jobs: rows, streaks, sourcesQueried: { Profession: true } });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /fölött 40 sor/);
  assert.match(r.warnings[0], /\+37 további/);
  assert.equal((r.warnings[0].match(/futás/g) ?? []).length, 4); // the header + three names
});

// ---- New candidates ----

test('judged keep: appended with firstSeen = lastSeen = today and the status for its source', () => {
  const rows = ['LinkedIn', 'Profession', 'NoFluff', 'Indeed'].map(source => job({ source }));
  const r = run({ jobs: [], candidates: rows.map(x => cand(x)),
    judged: { judgeVersion: 'j1', verdicts: rows.map(x => keepVerdict(x.id)) } });
  assert.deepEqual(r.jobs.map(j => [j.source, j.status, j.firstSeen, j.lastSeen]).sort(), [
    ['Indeed', 'Indeed', TODAY, TODAY], ['LinkedIn', 'Értesítő', TODAY, TODAY],
    ['NoFluff', 'NFJ keresés', TODAY, TODAY], ['Profession', 'Értesítő', TODAY, TODAY]]);
  for (const j of r.jobs) assert.equal(rowProblem(j), null);
});

test('judged keep:false -> fit: verdict with judge_version, no row', () => {
  const a = job();
  const r = run({ jobs: [], candidates: [cand(a)], judged: { judgeVersion: 'judge-2026-11-24', verdicts: [{ id: a.id, keep: false, reason: 'fit:no-kubernetes' }] } });
  assert.deepEqual(r.jobs, []);
  assert.deepEqual(r.verdictAdds, [{ id: a.id, reason: 'fit:no-kubernetes', judgeVersion: 'judge-2026-11-24', at: SLOT }]);
});

test('judged keep:false with a malformed reason is ledgered as fit:unspecified', () => {
  const a = job();
  const r = run({ jobs: [], candidates: [cand(a)], judged: { judgeVersion: 'j', verdicts: [{ id: a.id, keep: false, reason: 'nope <b>' }] } });
  assert.equal(r.verdictAdds[0].reason, 'fit:unspecified');
});

test('judged keeper whose portal omitted the company is added as "Ismeretlen cég"', () => {
  for (const company of [null, undefined, '  ']) {
    const row = job({ source: 'Indeed' });
    const r = run({ jobs: [], candidates: [cand(row, { company })], judged: { judgeVersion: 'j1', verdicts: [keepVerdict(row.id)] } });
    assert.equal(r.outcomes[row.id], 'added');
    assert.equal(byId(r, row.id).company, 'Ismeretlen cég');
    assert.equal(rowProblem(byId(r, row.id)), null);
  }
});

test('judged keep:false without a judge version is never ledgered: the candidate stays unjudged', () => {
  const row = job({ source: 'LinkedIn' });
  const r = run({ jobs: [], candidates: [cand(row)], judged: { judgeVersion: null, verdicts: [{ ...keepVerdict(row.id), keep: false, reason: 'fit:x' }] } });
  assert.deepEqual(r.verdictAdds, []);
  assert.equal(r.outcomes[row.id], 'unjudged');
});

test('no or invalid verdict: candidate is neither added nor ledgered (retried next run)', () => {
  const a = job(), b = job();
  const r = run({ jobs: [], candidates: [cand(a), cand(b)], judged: { judgeVersion: 'j', verdicts: [keepVerdict(b.id, { salaryLo: 'lots' })] } });
  assert.deepEqual(r.jobs, []);
  assert.deepEqual(r.verdictAdds, []);
  assert.equal(r.outcomes[a.id], 'unjudged');
  assert.equal(r.outcomes[b.id], 'unjudged');
  assert.equal(r.stats.unjudged, 2);
});

test('legacy ledger entry is claimed by the first real verdict', () => {
  const a = job();
  const r = run({ jobs: [], candidates: [cand(a)], verdicts: {}, judged: { judgeVersion: 'j', verdicts: [{ id: a.id, keep: false, reason: 'fit:x' }] } });
  assert.equal(r.verdictAdds.length, 1);
  const t = applyTracker({ [a.id]: { reason: 'legacy', judgeVersion: null, at: 'old' } }, { [a.id]: { st: 'ignored', at: 't' } }, SLOT);
  assert.equal(t.verdicts[a.id].reason, 'tracker:ignored');
});

// ---- 4. Salary ----

test('NFJ visible salary is copied verbatim over the judge estimate, type from salaryType', () => {
  const a = job({ source: 'NoFluff' });
  const b = job({ source: 'NoFluff' });
  const r = run({ jobs: [], candidates: [
    cand(a, { salary: { lo: 1300000, hi: 1800000, type: 'b2b', visible: true } }),
    cand(b, { salary: { lo: 900000, hi: 1000000, type: 'permanent', visible: false } })],
  judged: { judgeVersion: 'j', verdicts: [keepVerdict(a.id), keepVerdict(b.id)] } });
  const ra = byId(r, a.id), rb = byId(r, b.id);
  assert.deepEqual([ra.salaryLo, ra.salaryHi, ra.salaryPosted, ra.benchmark, ra.type], [1300000, 1800000, true, 'hirdetett sáv', 'Contract']);
  assert.deepEqual([rb.salaryLo, rb.salaryHi, rb.salaryPosted, rb.benchmark], [1500000, 2000000, false, 'DevOps Senior']);
});

// ---- Cross-source duplicates ----

test('cross-source duplicate of a live row: not appended, ledgered dedupe:<twin>', () => {
  const live = job({ source: 'LinkedIn', role: 'Senior DevOps Engineer', company: 'Acme Kft.', lastSeen: '2026-11-24' });
  const newPr = job({ source: 'Profession', role: 'senior devops engineer', company: 'ACME Zrt.' });
  const r = run({ jobs: [live], candidates: [cand(newPr)], judged: { judgeVersion: 'j', verdicts: [keepVerdict(newPr.id)] } });
  assert.equal(r.jobs.length, 1);
  assert.deepEqual(r.verdictAdds.map(v => [v.id, v.reason]), [[newPr.id, `dedupe:${live.id}`]]);
});

test('same-source same-title rows are not duplicates', () => {
  const live = job({ source: 'LinkedIn', role: 'DevOps Engineer', company: 'Deutsche Telekom', lastSeen: '2026-11-24' });
  const twin = job({ source: 'LinkedIn', role: 'DevOps Engineer', company: 'Deutsche Telekom' });
  const r = run({ jobs: [live], candidates: [cand(twin)], judged: { judgeVersion: 'j', verdicts: [keepVerdict(twin.id)] } });
  assert.equal(r.jobs.length, 2);
});

test('an archived (or closed) twin does not block: a reappearance is a repost worth seeing', () => {
  const stale = job({ source: 'LinkedIn', role: 'Cloud Architect', company: 'X', lastSeen: '2026-11-01' });
  const closed = job({ source: 'NoFluff', role: 'Cloud Architect', company: 'X', status: 'Mentett', closed: '2026-11-20', lastSeen: '2026-11-24' });
  const fresh = job({ source: 'Profession', role: 'Cloud Architect', company: 'X' });
  const r = run({ jobs: [stale, closed], candidates: [cand(fresh)], judged: { judgeVersion: 'j', verdicts: [keepVerdict(fresh.id)] } });
  assert.equal(r.outcomes[fresh.id], 'added');
});

test('a twin proven dead this run does not block either', () => {
  const twin = job({ source: 'LinkedIn', role: 'SRE', company: 'Y', lastSeen: '2026-11-24' });
  const fresh = job({ source: 'Profession', role: 'SRE', company: 'Y' });
  const r = run({ jobs: [twin], candidates: [cand(fresh)], liveness: { dead: [twin.id], alive: [] },
    judged: { judgeVersion: 'j', verdicts: [keepVerdict(fresh.id)] } });
  assert.equal(r.outcomes[fresh.id], 'added');
});

test('judge duplicateOf names a live cross-source twin the normaliser cannot see', () => {
  const live = job({ source: 'NoFluff', role: 'Platform Engineer (Azure)', company: 'Big Bank', lastSeen: '2026-11-24' });
  const fresh = job({ source: 'LinkedIn', role: 'Azure Platform Engineer', company: 'Big Bank Nyrt' });
  const r = run({ jobs: [live], candidates: [cand(fresh)], judged: { judgeVersion: 'j', verdicts: [keepVerdict(fresh.id, { duplicateOf: live.id })] } });
  assert.deepEqual(r.verdictAdds.map(v => v.reason), [`dedupe:${live.id}`]);
});

test('judge duplicateOf pointing at a same-source or unknown row is ignored', () => {
  const same = job({ source: 'LinkedIn', role: 'A', company: 'B', lastSeen: '2026-11-24' });
  const fresh = job({ source: 'LinkedIn', role: 'A2', company: 'B' });
  const other = job({ source: 'LinkedIn' });
  const r = run({ jobs: [same], candidates: [cand(fresh), cand(other)], judged: { judgeVersion: 'j',
    verdicts: [keepVerdict(fresh.id, { duplicateOf: same.id }), keepVerdict(other.id, { duplicateOf: 'li-999999' })] } });
  assert.equal(r.outcomes[fresh.id], 'added');
  assert.equal(r.outcomes[other.id], 'added');
});

test('two new cross-source twins in one run: the posted-salary one is kept, the other deduped', () => {
  const li = job({ source: 'LinkedIn', role: 'Security Engineer', company: 'Z' });
  const nfj = job({ source: 'NoFluff', role: 'Security Engineer', company: 'Z' });
  const r = run({ jobs: [], candidates: [cand(li), cand(nfj, { salary: { lo: 1500000, hi: 2000000, type: 'permanent', visible: true } })],
    judged: { judgeVersion: 'j', verdicts: [keepVerdict(li.id), keepVerdict(nfj.id)] } });
  assert.deepEqual(r.diff.added, [nfj.id]);
  assert.deepEqual(r.verdictAdds.map(v => [v.id, v.reason]), [[li.id, `dedupe:${nfj.id}`]]);
});

test('normalisation ignores case, accents and company suffixes', () => {
  assert.equal(normKey('Rendszermérnök', 'Példa Kft.'), normKey('RENDSZERMERNOK', 'Pelda Zrt'));
  assert.notEqual(normKey('DevOps Engineer', 'A'), normKey('DevOps Engineer', 'B'));
});

// ---- Owner decisions 2026-11-24 ----

test('tracker ignored/rejected -> tracker: verdict; existing real verdicts are kept', () => {
  const t = applyTracker({ 'li-2': { reason: 'fit:x', judgeVersion: 'j', at: 'a' } },
    { 'li-1': { st: 'ignored', at: 't' }, 'li-2': { st: 'rejected', at: 't' }, 'li-3': { st: 'rejected', at: 't' } }, SLOT);
  assert.deepEqual(t.adds.map(a => [a.id, a.reason]), [['li-1', 'tracker:ignored'], ['li-3', 'tracker:rejected']]);
  assert.equal(t.verdicts['li-2'].reason, 'fit:x');
});

test('positive tracker status releases tracker: AND fit:, never dead:/dedupe:/legacy', () => {
  const verdicts = {
    'li-1': { reason: 'tracker:ignored', judgeVersion: null, at: 'a' },
    'li-2': { reason: 'fit:no-k8s', judgeVersion: 'j', at: 'a' },
    'li-3': { reason: 'dead:liveness', judgeVersion: null, at: 'a' },
    'li-4': { reason: 'dedupe:pr-1', judgeVersion: null, at: 'a' },
    'li-5': { reason: 'legacy', judgeVersion: null, at: 'a' },
  };
  const tracker = Object.fromEntries(['li-1', 'li-2', 'li-3', 'li-4', 'li-5'].map((id, i) => [id, { st: ['saved', 'applied', 'interview', 'offer', 'saved'][i], at: 't' }]));
  const r = run({ jobs: [], verdicts, tracker });
  assert.deepEqual(r.verdictReleases, ['li-1', 'li-2']);
});

test('a released row that the feed lists again is bumped in the same run', () => {
  const a = job({ source: 'LinkedIn' });
  const r = run({ jobs: [a], candidates: [cand(a)], verdicts: { [a.id]: { reason: 'tracker:ignored', judgeVersion: null, at: 'x' } },
    tracker: { [a.id]: { st: 'saved', at: 't' } } });
  assert.equal(byId(r, a.id).lastSeen, TODAY);
});

test('repost of an owner-ignored ad is shown with repostOf, not suppressed (even cross-source and live)', () => {
  const ignored = job({ source: 'LinkedIn', role: 'Cloud Engineer', company: 'Adesso Kft.', lastSeen: '2026-11-24' });
  const repost = job({ source: 'LinkedIn', role: 'Cloud engineer', company: 'adesso' });
  const cross = job({ source: 'Profession', role: 'Cloud Engineer', company: 'Adesso Zrt.' });
  const r = run({ jobs: [ignored], tracker: { [ignored.id]: { st: 'ignored', at: '2026-11-20' } },
    candidates: [cand(repost), cand(cross)], judged: { judgeVersion: 'j', verdicts: [keepVerdict(repost.id), keepVerdict(cross.id)] } });
  assert.equal(byId(r, repost.id).repostOf, ignored.id);
  assert.equal(byId(r, cross.id).repostOf, ignored.id);
  assert.equal(r.stats.reposts, 2);
  assert.equal(rowProblem(byId(r, repost.id)), null);
});

test('repost flag follows judge duplicateOf when it names an ignored row', () => {
  const ignored = job({ source: 'NoFluff', role: 'IAM Specialist', company: 'Bank', lastSeen: '2026-11-24' });
  const fresh = job({ source: 'LinkedIn', role: 'Identity & Access Engineer', company: 'Bank' });
  const r = run({ jobs: [ignored], tracker: { [ignored.id]: { st: 'ignored', at: 't' } }, candidates: [cand(fresh)],
    judged: { judgeVersion: 'j', verdicts: [keepVerdict(fresh.id, { duplicateOf: ignored.id })] } });
  assert.equal(byId(r, fresh.id).repostOf, ignored.id);
});

test('NFJ repost (slug variant) of an owner-ignored ad is shown with repostOf, even when the original row is gone', () => {
  const orig = 'nfj-cloud-engineer-acme-budapest';
  const row = job({ source: 'NoFluff', id: `${orig}-1`, role: 'Cloud Engineer', company: 'Acme' });
  const verdicts = { [orig]: { reason: 'tracker:ignored', judgeVersion: null, at: 'x' } };
  const r = run({ jobs: [], candidates: [cand(row)], verdicts, tracker: { [orig]: { st: 'ignored', at: 't' } },
    judged: { judgeVersion: 'j1', verdicts: [keepVerdict(row.id)] } });
  assert.equal(r.outcomes[row.id], 'repost');
  assert.equal(byId(r, row.id).repostOf, orig);
  // A slug sibling's non-owner verdict (fit:) still hides it, as in v1.
  const fit = run({ jobs: [], candidates: [cand(row)], verdicts: { [orig]: { reason: 'fit:salary', judgeVersion: 'j', at: 'x' } },
    judged: { judgeVersion: 'j1', verdicts: [keepVerdict(row.id)] } });
  assert.equal(fit.outcomes[row.id], 'ledgered');
});

test('an existing NFJ row is bumped even when a slug sibling is ledgered (exact verdicts only for existing rows)', () => {
  const a = job({ source: 'NoFluff', id: 'nfj-sre-beta-budapest-2' });
  const r = run({ jobs: [a], candidates: [cand(a)], verdicts: { 'nfj-sre-beta-budapest': { reason: 'tracker:ignored', judgeVersion: null, at: 'x' } },
    sourcesQueried: { NoFluff: true } });
  assert.equal(byId(r, a.id).lastSeen, TODAY);
  assert.equal(r.outcomes[a.id], 'seen');
});

test('candidateLedger / collectorLedger: owner-ignored NFJ ids never hide reposts upstream', () => {
  const ledger = { 'nfj-a-b': { reason: 'tracker:ignored' }, 'nfj-c-d': { reason: 'fit:x' }, 'li-1': { reason: 'tracker:ignored' } };
  const look = candidateLedger(ledger, {});
  assert.deepEqual(look('nfj-a-b'), { reason: 'tracker:ignored' });
  assert.deepEqual(look('nfj-a-b-3'), { repostOf: 'nfj-a-b' });
  assert.deepEqual(look('nfj-c-d-1'), { reason: 'fit:x (slug variant of nfj-c-d)' });
  assert.equal(look('nfj-z'), null);
  assert.deepEqual(collectorLedger(ledger, {}), { 'nfj-c-d': 'fit:x', 'li-1': 'tracker:ignored' });
});

test('findTwins: exact normalised matches first, then similar same-company titles, with tracker state', () => {
  const a = job({ role: 'Cloud Engineer', company: 'Acme Kft.' });
  const b = job({ role: 'Senior Cloud Engineer', company: 'Acme' });
  const c = job({ role: 'Accountant', company: 'Acme' });
  const twins = findTwins({ id: 'li-1', role: 'cloud engineer', company: 'ACME Zrt.' }, [c, b, a], { [a.id]: { st: 'ignored', at: 't' } });
  assert.deepEqual(twins.map(t => [t.id, t.tracker]), [[a.id, 'ignored'], [b.id, null]]);
});

// ---- Invariants ----

test('an exact duplicate id in the input is a reported bug, second copy dropped', () => {
  const a = job();
  const r = run({ jobs: [a, { ...a, role: 'other' }] });
  assert.equal(r.jobs.length, 1);
  assert.match(r.warnings[0], /Duplikált id/);
});

test('a new row whose url is already used by another row is skipped with a warning', () => {
  const a = job();
  const b = job({ url: a.url });
  const r = run({ jobs: [a], candidates: [cand(b)], judged: { judgeVersion: 'j', verdicts: [keepVerdict(b.id)] } });
  assert.equal(r.outcomes[b.id], 'url-conflict');
  assert.equal(r.jobs.length, 1);
});

test('pure: same inputs give byte-identical output, inputs are not mutated', () => {
  const rows = [job(), job({ source: 'LinkedIn' }), job({ status: 'Mentett' })];
  const frozen = JSON.stringify(rows);
  const args = { jobs: rows, candidates: [cand(rows[0])], liveness: { dead: [rows[2].id], alive: [rows[1].id] }, sourcesQueried: { Profession: true } };
  assert.equal(JSON.stringify(run(args)), JSON.stringify(run(args)));
  assert.equal(JSON.stringify(rows), frozen);
});

test('id pattern accepts the four sources and nothing loose', () => {
  for (const ok of ['li-123', 'pr-9', 'nfj-a-b-1', 'in-0a1b2c3d4e5f6789']) assert.match(ok, ID_PATTERN);
  for (const ok2 of ['in-ABC', 'in-a1B2']) assert.match(ok2, ID_PATTERN);
  for (const bad of ['in-', 'in-a_b', 'nfj-Upper', 'li-12a', 'x-1']) assert.doesNotMatch(bad, ID_PATTERN);
});

// ---- Regression over the real data ----

const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/jobs-2026-11-25.json'), 'utf8'));

test('regression: today\'s jobs.json through a no-op run changes only lastSeen', () => {
  const feedRows = real.jobs.filter(j => j.status !== 'Mentett');
  const r = run({ jobs: real.jobs, candidates: feedRows.map(j => cand(j)),
    liveness: { dead: [], alive: real.jobs.map(j => j.id) },
    sourcesQueried: { Profession: true, NoFluff: true, LinkedIn: true, Indeed: true } });
  assert.equal(r.jobs.length, real.jobs.length);
  assert.deepEqual(r.jobs.map(j => j.id), real.jobs.map(j => j.id));
  r.jobs.forEach((j, i) => {
    const { lastSeen, ...rest } = j;
    const { lastSeen: was, ...restWas } = real.jobs[i];
    assert.deepEqual(rest, restWas, j.id);
    assert.equal(lastSeen, real.jobs[i].status === 'Mentett' ? was : (was > TODAY ? was : TODAY));
  });
  assert.deepEqual(r.verdictAdds, []);
  assert.deepEqual(r.verdictReleases, []);
  assert.deepEqual(r.diff.removed, []);
  assert.deepEqual(r.diff.added, []);
  assert.deepEqual(r.streaks, {});
});

test('regression: today\'s jobs.json with no candidates changes only streaks', () => {
  const r = run({ jobs: real.jobs, liveness: { dead: [], alive: [] }, sourcesQueried: { Profession: true, NoFluff: true } });
  assert.deepEqual(r.jobs, real.jobs);
  assert.equal(r.diff.updated, 0);
  const tracked = real.jobs.filter(j => (j.source === 'Profession' && j.status === 'Értesítő') || j.status === 'NFJ keresés');
  assert.deepEqual(Object.keys(r.streaks).sort(), tracked.map(j => j.id).sort());
  assert.ok(Object.values(r.streaks).every(n => n === 1));
  assert.ok(r.warnings.length <= 1);
});
