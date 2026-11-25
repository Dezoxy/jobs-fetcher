// Orchestrator tests: the whole pipeline against a SQLite-backed D1, the real
// validate.mjs and notify-diff.mjs, and fakes for the network-bound steps
// (collectors, prefetch, judge, Telegram).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteD1, hasSqlite } from './sqlite-d1.testkit.mjs';
import { planImport, runImport } from './import.mjs';
import { loadState } from './store.mjs';
import {
  runRefresh, scheduleSlot, EXIT, RunFailure, interpretCollection, collectWithScripts,
  validateWithScript, notifyWithScript, sendTelegram, childEnv, fallbackSummary, checkRemovals,
  parseOwnerProfile, loadJudgeContext, defaultDeps,
} from './run.mjs';

const opts = { skip: !hasSqlite && 'sqlite3 CLI not available' };
const NOW = new Date('2026-11-25T13:05:00.000Z');
const SLOT = '2026-11-25T13:00:00.000Z';
const TODAY = '2026-11-25';
const quiet = () => {};

function row(i, over = {}) {
  return { id: `pr-${100 + i}`, role: `Rendszermérnök ${i}`, company: `Cég ${i} Kft.`, source: 'Profession', category: 'DevOps',
    type: 'Employee', description: 'leírás', salaryLo: 1200000, salaryHi: 1800000, salaryPosted: false, benchmark: 'DevOps Senior',
    url: `https://www.profession.hu/allas/x-${100 + i}`, status: 'Értesítő', firstSeen: '2026-11-01', lastSeen: '2026-11-20', ...over };
}
const BASE = Array.from({ length: 20 }, (_, i) => row(i));
const NEW = { id: 'li-4490000001', source: 'LinkedIn', role: 'Cloud Engineer', company: 'Új Cég', location: 'Budapest, Budapest, Hungary', url: 'https://www.linkedin.com/jobs/view/4490000001/' };
const keep = (id) => ({ id, keep: true, reason: null, category: 'DevOps', type: 'Employee', salaryLo: 1500000, salaryHi: 2100000,
  salaryPosted: false, benchmark: 'DevOps Senior', description: 'Jó illeszkedés.', duplicateOf: null });

async function seeded(jobs = BASE, extra = {}) {
  const cf = createSqliteD1();
  await runImport(cf, planImport({ jobsDoc: { jobs }, tracker: {}, importedAt: '2026-11-24T00:00:00.000Z', ...extra }), quiet);
  const order = [];
  const put = cf.kvPut.bind(cf);
  cf.kvPut = async (k, v) => { order.push(k); return put(k, v); };
  cf.kvOrder = order;
  return cf;
}
function deps(over = {}) {
  const calls = { collect: 0, judge: 0, notify: 0 };
  const d = {
    calls,
    collect: async () => { calls.collect++; return { candidates: [{ ...BASE[0] }, NEW], liveness: { dead: [], alive: [BASE[1].id] },
      sourcesQueried: { Profession: true, NoFluff: true, LinkedIn: true, Indeed: false }, warnings: [], degraded: false, anySource: true, emailDecided: new Set() }; },
    prefetch: async (c) => c.map(x => ({ ...x, adText: x.adText ?? 'hirdetés' })),
    judge: async (c) => { calls.judge++; return { verdicts: c.map(x => keep(x.id)), unjudged: [], judgeVersion: 'judge-1', model: 'm' }; },
    summarize: async () => ({ summary: 'Egy új sor: Cloud Engineer.', warnings: [] }),
    context: async () => ({ ownerProfile: 'o', targetRoles: 't', salaryBenchmarks: 's', today: TODAY }),
    validate: (snapshot, note) => validateWithScript(snapshot, note, quiet),
    notify: async () => { calls.notify++; return 'skipped'; },
    ...over,
  };
  return d;
}

test('scheduleSlot: the latest 13:00 UTC slot', () => {
  assert.equal(scheduleSlot(new Date('2026-11-25T12:59:59Z')), '2026-11-24T13:00:00.000Z');
  assert.equal(scheduleSlot(NOW), SLOT);
});

test('success: one batch commits, note then data go to KV, both pass validate.mjs', opts, async () => {
  const cf = await seeded();
  try {
    const d = deps();
    assert.equal(await runRefresh({ cf, deps: d, now: NOW, log: quiet }), EXIT.OK);
    assert.equal(cf.calls.batch, 3); // the import (tracker + jobs) + exactly one commit
    const state = await loadState(cf);
    assert.equal(state.jobs.length, 21);
    assert.equal(state.jobs.find(j => j.id === BASE[0].id).lastSeen, TODAY);
    assert.equal(state.jobs.find(j => j.id === BASE[1].id).lastSeen, TODAY); // alive
    assert.equal(state.jobs.at(-1).id, NEW.id);
    const [run] = await cf.query('jobs', 'SELECT * FROM runs');
    assert.equal(run.slot, SLOT);
    assert.match(run.payload_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(run.diff), { added: [NEW.id], removed: [], updated: 2 });
    assert.deepEqual(cf.kvOrder, ['last-run.json', 'jobs.json']);
    const published = JSON.parse(cf.kv.get('jobs.json'));
    assert.deepEqual(published.jobs, state.jobs);
    assert.equal(JSON.parse(cf.kv.get('last-run.json')).summary, 'Egy új sor: Cloud Engineer.');
    assert.equal(d.calls.notify, 1);
  } finally { cf.cleanup(); }
});

test('idempotent: a second invocation for the same slot exits 0, re-puts the snapshot, writes nothing', opts, async () => {
  const cf = await seeded();
  try {
    await runRefresh({ cf, deps: deps(), now: NOW, log: quiet });
    const before = cf.kv.get('jobs.json');
    cf.kv.clear();
    const logs = [];
    const d = deps();
    assert.equal(await runRefresh({ cf, deps: d, now: new Date('2026-11-25T20:00:00Z'), log: l => logs.push(l) }), EXIT.OK);
    assert.equal(d.calls.collect, 0);
    assert.equal(cf.calls.batch, 3);
    assert.ok(logs.some(l => /already_completed/.test(l)));
    assert.equal(cf.kv.get('jobs.json'), before); // healed from D1, byte-identical
  } finally { cf.cleanup(); }
});

test('a concurrent run that committed first turns our failed batch into already_completed', opts, async () => {
  const cf = await seeded();
  try {
    const batch = cf.batch.bind(cf);
    cf.batch = async (db, stmts) => {
      if (stmts.some(s => /INSERT INTO runs/.test(s.sql))) {
        await batch(db, [{ sql: "INSERT INTO runs VALUES (?, 'other-run', 'y', '{\"ranAt\":\"2026-11-25T13:00:00Z\",\"summary\":\"m\",\"warnings\":[]}', '{}')", params: [SLOT] }]);
      }
      return batch(db, stmts);
    };
    const logs = [];
    const d = deps();
    assert.equal(await runRefresh({ cf, deps: d, now: NOW, log: l => logs.push(l) }), EXIT.OK);
    assert.equal(d.calls.notify, 0); // the other run owns the notification
    assert.equal(JSON.parse(cf.kv.get('last-run.json')).summary, 'm'); // ITS result is published
    assert.ok(logs.some(l => /via=commit_conflict/.test(l)));
    assert.equal((await loadState(cf)).jobs.length, 20);
  } finally { cf.cleanup(); }
});

const deadSweep = (ids) => async () => ({ candidates: [], liveness: { dead: ids, alive: [] },
  sourcesQueried: {}, warnings: [], degraded: false, anySource: true, emailDecided: new Set() });

test('refuses to commit a run that removes more than max(5, 20% of probed rows)', opts, async () => {
  const cf = await seeded();
  try {
    // 20 rows seen within 20 days -> limit max(5, 4) = 5.
    const d = deps({ collect: deadSweep(BASE.slice(0, 6).map(r => r.id)) });
    await assert.rejects(runRefresh({ cf, deps: d, now: NOW, log: quiet }), /would remove 6 rows \(limit 5 = max\(5, 20% of 20 probed\)\)/);
    assert.deepEqual(await cf.query('jobs', 'SELECT * FROM runs'), []);
    assert.equal(cf.kv.size, 0);
  } finally { cf.cleanup(); }
});

test('refuses when liveness marks too many rows dead, even if none would be deleted', opts, async () => {
  const touched = Object.fromEntries(BASE.slice(0, 6).map(r => [r.id, { st: 'saved', at: 'x' }]));
  const cf = await seeded(BASE, { tracker: touched });
  try {
    const d = deps({ collect: deadSweep(BASE.slice(0, 6).map(r => r.id)) });
    await assert.rejects(runRefresh({ cf, deps: d, now: NOW, log: quiet }), /liveness marked 6 rows dead/);
  } finally { cf.cleanup(); }
});

test('removing exactly the limit is allowed, with cleanedDeadIds in the note', opts, async () => {
  const cf = await seeded();
  try {
    const d = deps({ collect: deadSweep(BASE.slice(0, 5).map(r => r.id)) });
    assert.equal(await runRefresh({ cf, deps: d, now: NOW, log: quiet }), EXIT.OK);
    assert.deepEqual(JSON.parse(cf.kv.get('last-run.json')).cleanedDeadIds, BASE.slice(0, 5).map(r => r.id));
  } finally { cf.cleanup(); }
});

test('removal guard: an all-dead sweep over today\'s real jobs.json is refused; old archived rows do not dilute it', async () => {
  const { merge } = await import('./merge.mjs');
  const real = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/jobs-2026-11-25.json', import.meta.url), 'utf8')).jobs;
  const today = real.map(j => j.lastSeen).sort().at(-1);
  const probed = real.filter(j => (Date.parse(today) - Date.parse(j.lastSeen)) / 86400000 <= 20);
  const r = merge({ jobs: real, liveness: { dead: probed.map(j => j.id), alive: [] }, today, slot: `${today}T13:00:00.000Z` });
  const msg = checkRemovals({ jobs: real, today, removed: r.diff.removed, dead: probed.map(j => j.id) });
  assert.ok(probed.length < real.length / 2, 'most of the 1,2xx rows are archived and never probed');
  assert.match(msg, new RegExp(`of ${probed.length} probed`));
  // A normal day (a handful dead) passes.
  assert.equal(checkRemovals({ jobs: real, today, removed: r.diff.removed.slice(0, 3), dead: probed.slice(0, 3).map(j => j.id) }), null);
});

test('every run re-puts the last committed snapshot first, even one that then fails', opts, async () => {
  const cf = await seeded();
  try {
    await runRefresh({ cf, deps: deps(), now: NOW, log: quiet });
    const published = cf.kv.get('jobs.json');
    cf.kv.clear(); cf.kvOrder.length = 0;
    const d = deps({ collect: async () => { throw new Error('collector crash'); } });
    await assert.rejects(runRefresh({ cf, deps: d, now: new Date('2026-11-26T13:05:00Z'), log: quiet }), /collector crash/);
    assert.deepEqual(cf.kvOrder, ['last-run.json', 'jobs.json']);
    assert.equal(cf.kv.get('jobs.json'), published);
  } finally { cf.cleanup(); }
});

test('our own batch landed but its response was lost: committed once, published, notified once', opts, async () => {
  const cf = await seeded();
  try {
    const batch = cf.batch.bind(cf);
    let first = true;
    cf.batch = async (db, stmts) => {
      if (db === 'jobs' && first && stmts.some(s => /INSERT INTO runs/.test(s.sql))) {
        first = false; await batch(db, stmts); throw new Error('Cloudflare API 502');
      }
      return batch(db, stmts);
    };
    const logs = [];
    const d = deps();
    assert.equal(await runRefresh({ cf, deps: d, now: NOW, log: l => logs.push(l) }), EXIT.OK);
    assert.ok(logs.some(l => /commit_confirmed/.test(l)));
    assert.equal(d.calls.notify, 1);
    assert.equal(JSON.parse(cf.kv.get('jobs.json')).jobs.length, 21);
  } finally { cf.cleanup(); }
});

test('a missing tracker import marker is a failure, before anything is published', opts, async () => {
  const cf = createSqliteD1();
  try {
    await runImport(cf, planImport({ jobsDoc: { jobs: BASE }, importedAt: '2026-11-24T00:00:00.000Z' }), quiet);
    await assert.rejects(runRefresh({ cf, deps: deps(), now: NOW, log: quiet }), /tracker_imported/);
    assert.equal(cf.kv.size, 0);
  } finally { cf.cleanup(); }
});

test('judge failure: degraded (exit 8), committed, new candidate neither added nor ledgered', opts, async () => {
  const cf = await seeded();
  try {
    const d = deps({ judge: async () => { throw new Error('claude unavailable'); } });
    assert.equal(await runRefresh({ cf, deps: d, now: NOW, log: quiet }), EXIT.DEGRADED);
    const state = await loadState(cf);
    assert.equal(state.jobs.length, 20);
    assert.deepEqual(state.verdicts, {});
    assert.match(JSON.parse(cf.kv.get('last-run.json')).warnings.join('\n'), /claude unavailable/);
  } finally { cf.cleanup(); }
});

test('degraded collection is published with exit 8', opts, async () => {
  const cf = await seeded();
  try {
    const base = deps();
    const d = deps({ collect: async () => ({ ...(await base.collect()), degraded: true, warnings: ['LinkedIn: hiányos.'] }) });
    assert.equal(await runRefresh({ cf, deps: d, now: NOW, log: quiet }), EXIT.DEGRADED);
    assert.ok(cf.kv.has('jobs.json'));
  } finally { cf.cleanup(); }
});

test('validate failure: nothing is committed or published', opts, async () => {
  const cf = await seeded();
  try {
    const d = deps({ validate: async () => { throw new RunFailure('validate.mjs rejected the result (exit 1)'); } });
    await assert.rejects(runRefresh({ cf, deps: d, now: NOW, log: quiet }), /validate.mjs rejected/);
    assert.deepEqual(await cf.query('jobs', 'SELECT * FROM runs'), []);
    assert.equal(cf.kv.size, 0);
  } finally { cf.cleanup(); }
});

test('an HTML or over-long summary falls back to the deterministic one', opts, async () => {
  const cf = await seeded();
  try {
    const d = deps({ summarize: async () => ({ summary: '<b>bold</b>', warnings: ['extra figyelmeztetés'] }) });
    await runRefresh({ cf, deps: d, now: NOW, log: quiet });
    const note = JSON.parse(cf.kv.get('last-run.json'));
    assert.match(note.summary, /^Automatikus összefoglaló: 1 új sor/);
    assert.deepEqual(note.warnings, ['extra figyelmeztetés']);
  } finally { cf.cleanup(); }
});

test('KV failure after commit fails the run; the next invocation heals the snapshot from D1', opts, async () => {
  const cf = await seeded();
  try {
    const put = cf.kvPut;
    cf.kvPut = async () => { throw new Error('KV down'); };
    await assert.rejects(runRefresh({ cf, deps: deps(), now: NOW, log: quiet }), /KV down/);
    cf.kvPut = put;
    assert.equal(await runRefresh({ cf, deps: deps(), now: NOW, log: quiet }), EXIT.OK);
    assert.equal(JSON.parse(cf.kv.get('jobs.json')).jobs.length, 21);
  } finally { cf.cleanup(); }
});

test('an empty jobs table is a failure (import first), not a first run', opts, async () => {
  const cf = createSqliteD1();
  try {
    await cf.batch('tracker', [{ sql: "INSERT INTO meta VALUES ('tracker_imported', 'x')" }]);
    await assert.rejects(runRefresh({ cf, deps: deps(), now: NOW, log: quiet }), /import\.mjs first/);
  } finally { cf.cleanup(); }
});

test('e-mail candidates: decided ones and ones older than 7 days are consumed, undecided recent ones stay', opts, async () => {
  const cf = await seeded();
  try {
    await cf.batch('jobs', [{ sql: `INSERT INTO email_candidates (id, received_at) VALUES
      ('${NEW.id}', '2026-11-25T08:00:00Z'), ('li-5', '2026-11-25T08:00:00Z'), ('li-6', '2026-11-10T08:00:00Z'), ('li-7', '2026-11-25T08:00:00Z')` }]);
    const base = deps();
    const d = deps({ collect: async () => ({ ...(await base.collect()), emailDecided: new Set(['li-7']) }) });
    await runRefresh({ cf, deps: d, now: NOW, log: quiet });
    const rows = await cf.query('jobs', 'SELECT id, consumed_slot FROM email_candidates ORDER BY id');
    assert.deepEqual(rows, [{ id: NEW.id, consumed_slot: SLOT }, { id: 'li-5', consumed_slot: null },
      { id: 'li-6', consumed_slot: SLOT }, { id: 'li-7', consumed_slot: SLOT }]);
  } finally { cf.cleanup(); }
});

test('the judge sees only new, unledgered candidates, with twins and ad text', opts, async () => {
  const cf = await seeded(BASE, { tracker: { [BASE[2].id]: { st: 'ignored', at: '2026-11-20T00:00:00Z' } } });
  try {
    let seen;
    const twin = { ...NEW, id: 'li-4490000002', role: BASE[2].role, company: BASE[2].company, url: 'https://www.linkedin.com/jobs/view/4490000002/' };
    const base = deps();
    const d = deps({
      collect: async () => ({ ...(await base.collect()), candidates: [BASE[0], NEW, twin, { ...BASE[2] }] }),
      judge: async (c) => { seen = c; return { verdicts: c.map(x => keep(x.id)), judgeVersion: 'j', model: 'm' }; },
    });
    await runRefresh({ cf, deps: d, now: NOW, log: quiet });
    assert.deepEqual(seen.map(c => c.id), [NEW.id, twin.id]);
    assert.equal(seen[1].adText, 'hirdetés');
    assert.deepEqual(seen[1].possibleTwins.map(t => [t.id, t.tracker]), [[BASE[2].id, 'ignored']]);
    const state = await loadState(cf);
    assert.equal(state.jobs.find(j => j.id === twin.id).repostOf, BASE[2].id);
    assert.equal(state.verdicts[BASE[2].id].reason, 'tracker:ignored');
  } finally { cf.cleanup(); }
});

// ---- collection interpretation

const ledger = { 'li-900': { reason: 'tracker:ignored', judgeVersion: null, at: 'x' } };
const emptyState = { jobs: [], emailCandidates: [] };
const SOURCES = { coverage: { profession: { units: 4, failed: 0 }, nfj: { units: 2, failed: 0 } }, errors: [],
  profession: [{ id: 'pr-1', role: 'DevOps', company: 'A', url: 'https://www.profession.hu/allas/a-1', location: 'Pest megye, Budapest' }],
  nfj: [{ id: 'nfj-x-1', role: 'SRE', company: 'B', url: 'https://nofluffjobs.com/hu/job/x-1', salaryLo: 1000000, salaryHi: 1500000, salaryType: 'b2b', salaryCurrency: 'HUF', salaryVisible: true, posted: '2026-11-20' },
    { id: 'nfj-y-1', role: 'SRE', company: 'C', url: 'https://nofluffjobs.com/hu/job/y-1', salaryLo: 4000, salaryHi: 5000, salaryType: 'b2b', salaryCurrency: 'EUR', salaryVisible: true }] };
const FILTERED = { auth: { linkedin: { state: 'ok' } }, linkedinAlerts: Array.from({ length: 20 }, (_, i) => ({ id: `li-${i + 1}`, title: 'Cloud Engineer', company: 'X', location: 'Budapest, Budapest, Hungary', url: `https://www.linkedin.com/jobs/view/${i + 1}/`, postedAt: '2026-11-25' })),
  droppedRows: [], titled: 20, located: 20, queryFailures: [], truncatedQueries: [] };
const interp = (over) => interpretCollection({ sources: SOURCES, sourcesRc: 0, dead: { dead: [], alive: [] }, linkedin: { rc: 0, frc: 0 },
  filtered: FILTERED, indeedRun: null, indeed: null, ledger, state: emptyState, fetchDetail: async () => { throw new Error('unused'); }, ...over });

test('collection: rows map to contract candidates; NFJ salary is only "visible" for a HUF band', async () => {
  const c = await interp({});
  assert.equal(c.degraded, false);
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(c.sourcesQueried, { Profession: true, NoFluff: true, LinkedIn: true, Indeed: false });
  const byId = Object.fromEntries(c.candidates.map(x => [x.id, x]));
  assert.deepEqual(byId['nfj-x-1'].salary, { lo: 1000000, hi: 1500000, type: 'b2b', visible: true });
  assert.equal(byId['nfj-y-1'].salary.visible, false);
  assert.equal(byId['li-1'].role, 'Cloud Engineer');
});

test('collection: a source with failed units is not "queried" (streaks frozen) and fetch failure degrades', async () => {
  const partial = await interp({ sources: { ...SOURCES, coverage: { profession: { units: 4, failed: 1 }, nfj: { units: 2, failed: 0 } }, errors: ['profession "x": HTTP 500'] }, sourcesRc: 1 });
  assert.equal(partial.sourcesQueried.Profession, false);
  assert.equal(partial.degraded, true);
  assert.match(partial.warnings[0], /HTTP 500/);
  const none = await interp({ sources: null, sourcesRc: 1 });
  assert.equal(none.degraded, true);
  assert.equal(none.candidates.filter(x => x.source !== 'LinkedIn').length, 0);
});

test('collection: LinkedIn degradations from refresh-run.sh steps 4-4c raise warnings and exit 8', async () => {
  const capped = await interp({ linkedin: { rc: 5, frc: 0 }, filtered: { ...FILTERED, truncatedQueries: [{ q: 'architect' }] } });
  assert.equal(capped.degraded, true);
  assert.match(capped.warnings[0], /plafon/);
  const few = await interp({ filtered: { ...FILTERED, linkedinAlerts: FILTERED.linkedinAlerts.slice(0, 3), titled: 0, located: 3 } });
  assert.match(few.warnings[0], /csak 3 sor/);
  assert.match(few.warnings[0], /sincs címe/);
  const down = await interp({ linkedin: { rc: 4 }, filtered: null });
  assert.equal(down.degraded, true);
  assert.match(down.warnings[0], /LinkedIn gyűjtés sikertelen/);
  const off = await interp({ linkedin: { skipped: true }, filtered: null });
  assert.equal(off.degraded, false);
});

test('collection: Indeed comes from filter-indeed.mjs output; undetermined keeps its rows and degrades', async () => {
  const row = { id: 'in-Aa1', source: 'Indeed', role: 'Cloud Engineer', company: 'D', location: 'Budapest, PE, Hungary',
    url: 'https://hu.indeed.com/viewjob?jk=Aa1', adText: 'JobSpy description' };
  const c = await interp({ indeedRun: { rc: 0, frc: 0 }, indeed: { state: 'ok', rows: [row], truncatedQueries: [], queryFailures: [] } });
  const got = c.candidates.find(x => x.id === 'in-Aa1');
  assert.equal(got.adText, 'JobSpy description');
  assert.equal(c.sourcesQueried.Indeed, true);
  assert.equal(c.degraded, false);
  const partial = await interp({ indeedRun: { rc: 0, frc: 0 }, indeed: { state: 'undetermined', reason: 'blocked', rows: [row] } });
  assert.equal(partial.degraded, true);
  assert.ok(partial.candidates.some(x => x.id === 'in-Aa1'));
  assert.match(partial.warnings.join(), /Indeed: állapot: undetermined \(blocked\)/);
  const failed = await interp({ indeedRun: { rc: 2 }, indeed: null });
  assert.equal(failed.degraded, true);
  assert.match(failed.warnings.join(), /Indeed gyűjtés sikertelen/);
  assert.equal((await interp({})).warnings.some(w => /Indeed/.test(w)), false); // not installed: silent
});

test('collection: e-mail candidates resolve through the LinkedIn guest detail', async () => {
  const existing = { id: 'li-500', role: 'R', company: 'C', source: 'LinkedIn', url: 'https://www.linkedin.com/jobs/view/500/' };
  const details = {
    'li-501': { state: 'gone', why: 'http-404' },
    'li-502': { state: 'unknown', why: 'http-429' },
    'li-503': { state: 'ok', role: 'Junior Analyst', company: 'X', location: 'Budapest, Budapest, Hungary', adText: '' },
    'li-504': { state: 'ok', role: 'Platform Engineer', company: 'Y', location: 'Budapest, Budapest, Hungary', adText: 'ad body' },
  };
  const c = await interp({ state: { jobs: [existing], emailCandidates: ['li-900', 'li-500', 'li-501', 'li-502', 'li-503', 'li-504', 'li-1'].map(id => ({ id, receivedAt: 'x' })) },
    fetchDetail: async id => details[id] });
  assert.deepEqual([...c.emailDecided].sort(), ['li-501', 'li-503', 'li-900']);
  const byId = Object.fromEntries(c.candidates.map(x => [x.id, x]));
  assert.equal(byId['li-500'].url, existing.url);
  assert.deepEqual([byId['li-504'].role, byId['li-504'].adText, byId['li-504'].url], ['Platform Engineer', 'ad body', 'https://www.linkedin.com/jobs/view/504/']);
  assert.equal(byId['li-502'], undefined);
  assert.equal(c.candidates.filter(x => x.id === 'li-1').length, 1); // the feed's copy only
});

test('collection: no liveness file means a warning, liveness null, and a degraded run', async () => {
  const c = await interp({ dead: null });
  assert.equal(c.liveness, null);
  assert.equal(c.degraded, true);
  assert.match(c.warnings.at(-1), /liveness/);
});

test('collectWithScripts materialises jobs.json and the ledger, runs the scripts secret-free, and reads their output', async () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-v2-fake-scripts-'));
  const w = (name, body) => fs.writeFileSync(path.join(fake, name), body);
  w('fetch-sources.mjs', `import fs from 'node:fs';
    const ledger = JSON.parse(fs.readFileSync('.cache/rejected-ids.json', 'utf8'));
    const env = Object.keys(process.env).filter(k => /TOKEN|SECRET|CLOUDFLARE/.test(k));
    fs.writeFileSync('.cache/sources-latest.json', JSON.stringify({ coverage: { profession: { units: 1, failed: 0 }, nfj: { units: 1, failed: 0 } }, errors: env,
      profession: [{ id: 'pr-7', role: Object.keys(ledger.ids).join(','), company: process.env.JOBS_SALARY_FLOOR_HUF ?? 'no-floor', url: 'https://www.profession.hu/allas/7' }], nfj: [] }));`);
  w('check-liveness.mjs', `import fs from 'node:fs';
    const ids = JSON.parse(fs.readFileSync('public/data/jobs.json', 'utf8')).jobs.map(j => j.id);
    const retry = process.argv.includes('--retry-unknown');
    if (process.env.JOBS_SALARY_FLOOR_HUF) ids.push('floor-leaked');
    fs.writeFileSync('.cache/dead-ids.json', JSON.stringify({ dead: [], alive: retry ? [...ids, 'retried'] : ids, unknown: [] }));`);
  w('fetch-linkedin.mjs', `import fs from 'node:fs'; fs.writeFileSync('.cache/browser-latest.json', '{}'); process.exit(5);`);
  w('filter-browser.mjs', `import fs from 'node:fs'; fs.writeFileSync('.cache/browser-filtered.json', JSON.stringify(${JSON.stringify(FILTERED)}));`);
  w('fetch-indeed.py', `import json, pathlib
pathlib.Path('.cache/indeed-latest.json').write_text(json.dumps({'state': 'ok', 'rows': []}))`);
  w('filter-indeed.mjs', `import fs from 'node:fs';
    const doc = JSON.parse(fs.readFileSync('.cache/indeed-latest.json', 'utf8'));
    fs.writeFileSync('.cache/indeed-filtered.json', JSON.stringify({ ...doc, rows: [{ id: 'in-Zz9', source: 'Indeed', role: 'SRE', company: 'Q', url: 'https://hu.indeed.com/viewjob?jk=Zz9' }] }));`);
  w('validate.test.mjs', 'throw new Error("tests are not copied")');
  const withIgnoredNfj = { ...ledger, 'nfj-sre-acme-budapest': { reason: 'tracker:ignored', judgeVersion: null, at: 'x' } };
  try {
    const c = await collectWithScripts({ previous: { jobs: [{ id: 'pr-1' }] }, ledger: withIgnoredNfj,
      state: { ...emptyState, tracker: { 'nfj-sre-acme-budapest': { st: 'ignored', at: 'x' } } },
      env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: 'secret', TELEGRAM_BOT_TOKEN: 'secret' }, log: quiet, scriptsDir: fake,
      salaryFloor: 900000 });
    const pr = c.candidates.find(x => x.id === 'pr-7');
    assert.equal(pr.role, 'li-900'); // the ledger reached the fetcher, minus the owner-ignored NFJ id
    assert.equal(pr.company, '900000'); // the profile's salary floor reached fetch-sources (and only it: see liveness)
    assert.ok(c.candidates.some(x => x.id === 'in-Zz9')); // fetch-indeed.py -> filter-indeed.mjs -> candidates
    assert.equal(c.sourcesQueried.Indeed, true);
    assert.deepEqual(c.liveness.alive, ['pr-1', 'retried']); // jobs.json reached liveness, then the retry pass ran
    assert.equal(c.warnings.some(x => /TOKEN|SECRET|CLOUDFLARE/.test(x)), false); // children saw no secrets
    assert.equal(c.degraded, true); // LinkedIn exit 5
    assert.equal(c.candidates.filter(x => x.source === 'LinkedIn').length, 20);
  } finally { fs.rmSync(fake, { recursive: true, force: true }); }
});

const PROFILE = '# Judge profile\n\n- Location: Budapest area.\n- Salary floor: 900000 HUF gross per month (Employee jobs).\n- Known gaps: none listed.\n';

test('parseOwnerProfile returns the salary floor and fails closed on a truncated or malformed profile', () => {
  assert.deepEqual(parseOwnerProfile(PROFILE), { salaryFloor: 900000 });
  const floor = '- Salary floor: 900000 HUF gross per month';
  for (const bad of ['', PROFILE.replace(floor, '- Salary floor: about 900k'), PROFILE.replace(floor, floor.slice(2)),
    PROFILE.replace(floor, '- Salary floor: 900 HUF gross per month'),
    PROFILE.replace(/^- Location:.*\n/m, ''), PROFILE.replace(/^- Known gaps:.*\n/m, '')])
    assert.throws(() => parseOwnerProfile(bad), RunFailure, JSON.stringify(bad));
});

test('defaultDeps.collect: the profile floor reaches fetch-sources; a bad profile fails before any child runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-v2-cv-'));
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-v2-fake-scripts-'));
  try {
    fs.mkdirSync(path.join(root, 'profile'));
    fs.writeFileSync(path.join(fake, 'fetch-sources.mjs'), `import fs from 'node:fs';
      fs.writeFileSync('.cache/sources-latest.json', JSON.stringify({ coverage: {}, errors: [], nfj: [],
        profession: [{ id: 'pr-1', role: 'R', company: process.env.JOBS_SALARY_FLOOR_HUF ?? 'no-floor', url: 'https://www.profession.hu/allas/1' }] }));`);
    const collect = (profile) => {
      fs.writeFileSync(path.join(root, 'profile/judge-profile.md'), profile);
      return defaultDeps({ PATH: process.env.PATH, JOBS_EMPLOYEE_CV_ROOT: root }, NOW, quiet)
        .collect({ previous: { jobs: [] }, ledger: {}, state: emptyState, env: { PATH: process.env.PATH }, log: quiet, scriptsDir: fake });
    };
    await assert.rejects(collect(PROFILE.replace(/^- Salary floor:.*\n/m, '')), RunFailure);
    const c = await collect(PROFILE.replace('900000', '1100000'));
    assert.equal(c.candidates.find(x => x.id === 'pr-1')?.company, '1100000');
  } finally {
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(fake, { recursive: true, force: true });
  }
});

test('loadJudgeContext reads the three employee-cv files; a missing profile fails the run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-v2-cv-'));
  try {
    const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
    put('profile/target-roles.md', 'roles'); put('research/market/salary-benchmarks.md', 'bands');
    await assert.rejects(loadJudgeContext({ JOBS_EMPLOYEE_CV_ROOT: root }, TODAY), /judge-profile\.md/);
    put('profile/judge-profile.md', 'profile');
    assert.deepEqual(await loadJudgeContext({ JOBS_EMPLOYEE_CV_ROOT: root }, TODAY),
      { ownerProfile: 'profile', targetRoles: 'roles', salaryBenchmarks: 'bands', today: TODAY });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('childEnv passes no credentials', () => {
  assert.deepEqual(Object.keys(childEnv({ PATH: '/bin', HOME: '/h', CLOUDFLARE_API_TOKEN: 'x', TELEGRAM_BOT_TOKEN: 'y', CLAUDE_CODE_OAUTH_TOKEN: 'z' })).sort(), ['HOME', 'PATH']);
});

// ---- validate / notify / Telegram

test('validateWithScript accepts Indeed rows with repostOf and rejects a malformed note', async () => {
  const jobs = [row(1), { ...row(2), id: 'in-abc', source: 'Indeed', status: 'Indeed', repostOf: row(1).id }];
  const snapshot = { schemaVersion: 1, generatedAt: NOW.toISOString(), source: 's', jobs };
  await validateWithScript(snapshot, { ranAt: NOW.toISOString(), summary: 'ok', warnings: [] }, quiet);
  await assert.rejects(validateWithScript(snapshot, { ranAt: NOW.toISOString(), summary: '<b>x</b>' }, quiet), /validate\.mjs rejected/);
  await assert.rejects(validateWithScript({ ...snapshot, jobs: [{ ...jobs[1], repostOf: 'in-abc' }] }, { ranAt: NOW.toISOString(), summary: 'ok' }, quiet), /rejected/);
});

test('notifyWithScript: notify-diff decides, Telegram only when enabled and changed', async () => {
  const prev = { schemaVersion: 1, generatedAt: 'x', jobs: [row(1)] };
  const next = { schemaVersion: 1, generatedAt: 'y', jobs: [row(1), row(2)] };
  const note = { ranAt: 'x', summary: 'Összegzés', warnings: [] };
  let sent;
  const env = { JOBS_REFRESH_NOTIFY_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' };
  assert.equal(await notifyWithScript({ previous: prev, next, runNote: note }, env, { send: async (_, m) => { sent = m; return 'sent'; }, log: quiet }), 'sent');
  assert.match(sent, /Álláslista frissült/);
  assert.match(sent, /Új \(1\)/);
  assert.equal(await notifyWithScript({ previous: prev, next: prev, runNote: note }, env, { send: async () => 'sent', log: quiet }), 'skipped');
  assert.equal(await notifyWithScript({ previous: prev, next, runNote: note }, {}, { send: async () => 'sent', log: quiet }), 'disabled');
});

test('sendTelegram: sent / unconfirmed / failed, never logging the token', async () => {
  const env = { TELEGRAM_BOT_TOKEN: '123:SECRET', TELEGRAM_CHAT_ID: '42' };
  const logs = [];
  const log = l => logs.push(l);
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) });
  assert.equal(await sendTelegram(env, 'hi', { fetchImpl: okFetch, log }), 'sent');
  let n = 0;
  const reset = async () => { n++; throw Object.assign(new TypeError('fetch failed 123:SECRET'), { cause: { code: 'ECONNRESET' } }); };
  assert.equal(await sendTelegram(env, 'hi', { fetchImpl: reset, log, retryDelayMs: 0 }), 'unconfirmed');
  assert.equal(n, 1);
  n = 0;
  const dns = async () => { n++; throw Object.assign(new TypeError('x'), { cause: { code: 'ENOTFOUND' } }); };
  assert.equal(await sendTelegram(env, 'hi', { fetchImpl: dns, log, retryDelayMs: 0 }), 'failed');
  assert.equal(n, 3);
  const bad = async () => ({ ok: false, status: 400, json: async () => ({ ok: false }) });
  assert.equal(await sendTelegram(env, 'hi', { fetchImpl: bad, log }), 'unconfirmed');
  assert.ok(logs.length >= 4 && logs.every(l => !l.includes('SECRET') && !l.includes('123:')));
});

test('fallbackSummary is plain text under the validator limits', () => {
  const s = fallbackSummary({ added: 1, seen: 2, alive: 3, deleted: 4, closed: 5, fitRejected: 6, deduped: 7, total: 8 });
  assert.ok(s.length < 1500 && !s.includes('<'));
});

// ---- LinkedIn guest detail (e-mail candidates)

test('LinkedIn guest detail: parsed fields, gone, closed, throttled, unparseable', async () => {
  const { parseDetail, fetchLinkedInDetail } = await import('./linkedin-detail.mjs');
  const html = `<h2 class="top-card-layout__title topcard__title">Platform Engineer</h2>
    <a class="topcard__org-name-link topcard__flavor--black-link" href="#">  Acme &amp; Co </a>
    <span class="topcard__flavor topcard__flavor--bullet">Budapest, Budapest, Hungary</span>
    <div class="show-more-less-html__markup"><p>Kubernetes</p><ul><li>Terraform</li></ul></div>`;
  assert.deepEqual(parseDetail(html), { role: 'Platform Engineer', company: 'Acme & Co', location: 'Budapest, Budapest, Hungary', adText: 'Kubernetes\nTerraform' });
  const res = (status, body = '') => async () => ({ status, text: async () => body });
  assert.equal((await fetchLinkedInDetail('li-1', { fetchImpl: res(200, html) })).state, 'ok');
  assert.deepEqual(await fetchLinkedInDetail('li-1', { fetchImpl: res(404) }), { state: 'gone', why: 'http-404' });
  assert.equal((await fetchLinkedInDetail('li-1', { fetchImpl: res(200, `${html} No longer accepting applications`) })).state, 'gone');
  assert.deepEqual(await fetchLinkedInDetail('li-1', { fetchImpl: res(429) }), { state: 'unknown', why: 'http-429' });
  assert.deepEqual(await fetchLinkedInDetail('li-1', { fetchImpl: res(200, '<html></html>') }), { state: 'unknown', why: 'unparseable' });
  assert.deepEqual(await fetchLinkedInDetail('li-x', { fetchImpl: res(200, html) }), { state: 'gone', why: 'malformed-id' });
});
