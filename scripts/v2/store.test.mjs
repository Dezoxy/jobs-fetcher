// SQL-level tests: the generated statements run against real SQLite (sqlite3
// CLI), with D1's limits checked on every statement. Skipped without sqlite3.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteD1, hasSqlite } from './sqlite-d1.testkit.mjs';
import { toRow, fromRow, chunkJson, commitStatements, loadState, readSnapshot, serialize, renderSnapshot } from './store.mjs';
import { planImport, runImport, parseLedger, main as importMain } from './import.mjs';
import { exportJson } from './export-json.mjs';
import { buildBundle, uploadBundle } from './backup.mjs';
import { merge } from './merge.mjs';
import { D1_MAX_PARAMS, D1_MAX_SQL_BYTES } from './d1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/jobs-2026-11-25.json'), 'utf8'));
const opts = { skip: !hasSqlite && 'sqlite3 CLI not available' };
const AT = '2026-11-24T20:00:00.000Z';

test('toRow/fromRow round-trips every real row exactly, key order included', () => {
  for (const j of real.jobs) assert.equal(JSON.stringify(fromRow(toRow(j))), JSON.stringify(j));
  const withRepost = { ...real.jobs[0], repostOf: 'li-1' };
  assert.equal(JSON.stringify(fromRow(toRow(withRepost))), JSON.stringify(withRepost));
});

test('chunkJson keeps every chunk under the byte budget and loses nothing', () => {
  const items = real.jobs.map(toRow);
  const chunks = chunkJson(items, 50_000);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.flat().length, items.length);
  for (const c of chunks) assert.ok(Buffer.byteLength(JSON.stringify(c)) <= 50_000);
  assert.throws(() => chunkJson([{ x: 'y'.repeat(100) }], 50), /larger/);
});

test('import plan: every statement within D1 limits; bad rows are refused', () => {
  const plan = planImport({ jobsDoc: real, ledger: { 'li-1': 'tracker:ignored' }, streaks: { 'pr-1': 2, bad: -1 },
    tracker: { 'li-1': { st: 'ignored', at: AT }, 'li-2': { st: 'bogus', at: AT } }, importedAt: AT });
  assert.deepEqual(plan.counts, { jobs: real.jobs.length, verdicts: 1, streaks: 1, tracker: 1, trackerSkipped: 1 });
  for (const s of [...plan.jobsStatements, ...plan.trackerStatements]) {
    assert.ok(s.params.length <= D1_MAX_PARAMS);
    assert.ok(Buffer.byteLength(s.sql) + s.params.reduce((n, p) => n + Buffer.byteLength(String(p)), 0) <= D1_MAX_SQL_BYTES);
  }
  assert.throws(() => planImport({ jobsDoc: { jobs: [{ ...real.jobs[0], salaryLo: 'x' }] }, importedAt: AT }), /salary/);
  assert.throws(() => planImport({ jobsDoc: { jobs: [real.jobs[0], real.jobs[0]] }, importedAt: AT }), /duplicate/);
  assert.deepEqual(parseLedger(['li-1']), { 'li-1': 'legacy' });
  assert.deepEqual(parseLedger({ ids: { 'li-1': '' } }), { 'li-1': 'legacy' });
});

test('import -> loadState -> export reproduces today\'s jobs.json', opts, async () => {
  const cf = createSqliteD1();
  try {
    const tracker = { 'li-3341900618': { st: 'ignored', at: '2026-11-01T10:00:00.000Z' } };
    await runImport(cf, planImport({ jobsDoc: real, ledger: { 'li-3341900618': 'tracker:ignored' }, streaks: { 'pr-1': 3 }, tracker, importedAt: AT }));
    const state = await loadState(cf);
    assert.deepEqual(state.jobs, real.jobs);
    assert.deepEqual(state.verdicts, { 'li-3341900618': { reason: 'tracker:ignored', judgeVersion: null, at: AT } });
    assert.deepEqual(state.streaks, { 'pr-1': 3 });
    assert.deepEqual(state.tracker, tracker);
    await assert.rejects(runImport(cf, planImport({ jobsDoc: real, importedAt: AT }), () => {}), /refusing to import/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-v2-export-'));
    await exportJson(cf, dir);
    const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    assert.deepEqual(read('jobs.json').jobs, real.jobs);
    assert.equal(fs.existsSync(path.join(dir, 'last-run.json')), false);
    // v1 rollback files, in the shapes ledger.mjs and refresh-task.md use.
    assert.deepEqual(read('rejected-ids.json'), { ids: { 'li-3341900618': 'tracker:ignored' } });
    assert.deepEqual(read('unseen-streaks.json'), { 'pr-1': 3 });
    fs.rmSync(dir, { recursive: true });
  } finally { cf.cleanup(); }
});

test('import CLI --dry-run needs no credentials and writes nothing; ledger, streaks and tracker must be explicit', async () => {
  const lines = [];
  const jobsFile = path.join(ROOT, 'tests/fixtures/jobs-2026-11-25.json');
  const flags = ['--no-ledger', '--no-streaks', '--no-tracker'];
  assert.equal(await importMain(['--jobs', jobsFile, ...flags, '--dry-run'], {}, new Date(AT), l => lines.push(l)), 0);
  assert.match(lines[0], new RegExp(`jobs=${real.jobs.length} verdicts=0 streaks=0 tracker=none`));
  assert.match(lines[1], /--dry-run, nothing written/);
  for (const missing of flags) {
    await assert.rejects(importMain(['--jobs', jobsFile, ...flags.filter(f => f !== missing), '--dry-run'], {}, new Date(AT), () => {}),
      new RegExp(missing.replace('--no-', '--')));
  }
});

test('import: tracker first with its marker last; an imported tracker is skipped; a non-empty jobs-data refuses before any write', opts, async () => {
  const cf = createSqliteD1();
  try {
    const jobs = { jobs: real.jobs.slice(0, 5) };
    const logs = [];
    // Re-run after a failed jobs batch: tracker done, jobs-data still empty.
    cf.failNextBatch = false;
    const batch = cf.batch.bind(cf);
    let failJobs = true;
    cf.batch = async (db, s) => { if (db === 'jobs' && failJobs) { failJobs = false; throw new Error('jobs batch lost'); } return batch(db, s); };
    const plan = planImport({ jobsDoc: jobs, tracker: { 'li-1': { st: 'saved', at: AT } }, importedAt: AT });
    assert.equal(plan.trackerStatements.at(-1).sql, 'INSERT INTO meta (key, value) VALUES (?, ?)');
    await assert.rejects(runImport(cf, plan, l => logs.push(l)), /jobs batch lost/);
    assert.deepEqual(await cf.query('tracker', 'SELECT key, value FROM meta'), [{ key: 'tracker_imported', value: AT }]);
    const again = await runImport(cf, planImport({ jobsDoc: jobs, tracker: { 'li-2': { st: 'ignored', at: AT } }, importedAt: AT }), l => logs.push(l));
    assert.deepEqual(again, { tracker: 'skipped', jobs: 'imported' });
    assert.match(logs.at(-1), /already imported .* tracker part skipped/);
    assert.deepEqual(await cf.query('tracker', 'SELECT id FROM tracker'), [{ id: 'li-1' }]);
    await assert.rejects(runImport(cf, planImport({ jobsDoc: jobs, tracker: {}, importedAt: AT }), () => {}), /jobs-data\.jobs already holds 5 rows/);
  } finally { cf.cleanup(); }
});

test('commit batch: applies deletes, upserts, verdicts, streaks, e-mail consumption and the run row atomically', opts, async () => {
  const cf = createSqliteD1();
  try {
    const rows = real.jobs.slice(0, 50);
    await runImport(cf, planImport({ jobsDoc: { jobs: rows }, ledger: { [rows[1].id]: 'tracker:ignored' }, streaks: { [rows[2].id]: 1 }, importedAt: AT }));
    await cf.batch('jobs', [{ sql: "INSERT INTO email_candidates (id, received_at) VALUES ('li-77', '2026-11-24T08:00:00Z'), ('li-78', '2026-11-24T08:00:00Z')" }]);
    const state = await loadState(cf);
    const newRow = { ...rows[3], id: 'in-abc123', source: 'Indeed', status: 'Indeed', url: 'https://hu.indeed.com/viewjob?jk=abc123', repostOf: rows[1].id };
    const result = merge({ jobs: state.jobs, verdicts: state.verdicts, streaks: state.streaks, tracker: { [rows[4].id]: { st: 'rejected', at: AT } },
      candidates: [{ id: rows[5].id, source: rows[5].source, role: rows[5].role, company: rows[5].company, url: rows[5].url }],
      liveness: { dead: [rows.find(r => r.status !== 'Mentett').id], alive: [] }, today: '2026-11-25', slot: '2026-11-25T13:00:00.000Z',
      sourcesQueried: { Profession: true } });
    result.jobs.push(newRow); result.diff.added.push(newRow.id);
    const runNote = { ranAt: AT, summary: 'ok', warnings: [] };
    const stmts = commitStatements({ slot: '2026-11-25T13:00:00.000Z', payloadSha256: 'f'.repeat(64), committedAt: AT, runNote, result,
      consumedEmailIds: ['li-77'], previousIds: new Map(state.jobs.map(j => [j.id, JSON.stringify(j)])) });
    for (const s of stmts) assert.ok(s.params.length <= D1_MAX_PARAMS);
    await cf.batch('jobs', stmts);
    const after = await loadState(cf);
    assert.deepEqual(after.jobs, result.jobs);
    assert.equal(after.verdicts[rows[4].id].reason, 'tracker:rejected');
    assert.ok(Object.values(after.verdicts).some(v => v.reason === 'dead:liveness'));
    assert.deepEqual(after.streaks, result.streaks);
    assert.deepEqual(after.emailCandidates.map(e => e.id), ['li-78']);
    const snap = await readSnapshot(cf);
    assert.deepEqual(snap.runNote, runNote);
    assert.equal(snap.jobs.generatedAt, AT);
    assert.equal(snap.jobs.jobs.find(j => j.id === 'in-abc123').repostOf, rows[1].id);

    // Same slot again: the runs primary key fails the first statement and the
    // WHOLE batch rolls back — not one of the later writes survives.
    const again = commitStatements({ slot: '2026-11-25T13:00:00.000Z', payloadSha256: 'e'.repeat(64), committedAt: AT, runNote,
      result: { ...result, diff: { added: [], removed: [], updated: 0 }, jobs: [], verdictAdds: [{ id: 'li-9', reason: 'fit:x', judgeVersion: 'j', at: AT }], verdictReleases: [], streaks: {} },
      previousIds: new Map() });
    await assert.rejects(cf.batch('jobs', again), /UNIQUE constraint failed: runs.slot/);
    const unchanged = await loadState(cf);
    assert.deepEqual(unchanged.streaks, result.streaks);
    assert.equal(unchanged.verdicts['li-9'], undefined);
  } finally { cf.cleanup(); }
});

test('the schema CHECKs reject a bad source and a duplicate url', opts, async () => {
  const cf = createSqliteD1();
  try {
    const { upsertJobs } = await import('./store.mjs');
    await assert.rejects(cf.batch('jobs', upsertJobs([{ ...real.jobs[0], source: 'Monster' }])), /CHECK constraint/);
    await assert.rejects(cf.batch('jobs', upsertJobs([real.jobs[0], { ...real.jobs[1], url: real.jobs[0].url }])), /UNIQUE constraint failed: jobs.url/);
    assert.deepEqual(await cf.query('jobs', 'SELECT count(*) AS n FROM jobs'), [{ n: 0 }]);
  } finally { cf.cleanup(); }
});

test('backup bundle carries every table of both databases and uploads write-once with verification', opts, async () => {
  const cf = createSqliteD1();
  try {
    await runImport(cf, planImport({ jobsDoc: { jobs: real.jobs.slice(0, 10) }, ledger: { 'li-1': 'fit:x' },
      tracker: { 'li-1': { st: 'saved', at: AT } }, importedAt: AT }));
    const { bundle, counts } = await buildBundle(cf, new Date(AT));
    const doc = JSON.parse(bundle);
    assert.equal(doc.schema, 2);
    assert.deepEqual(Object.keys(doc.databases['jobs-data']), ['jobs', 'verdicts', 'streaks', 'runs', 'email_candidates']);
    assert.deepEqual(counts, { jobs: 10, verdicts: 1, streaks: 0, runs: 0, email_candidates: 0, tracker: 1, meta: 1 });
    assert.deepEqual(Object.keys(doc.databases['jobs-tracker']), ['tracker', 'meta']);
    const blobs = new Map();
    const container = { getBlockBlobClient: name => ({ name,
      async uploadData(bytes, o) { assert.equal(o.conditions.ifNoneMatch, '*'); if (blobs.has(name)) throw new Error('exists'); blobs.set(name, Buffer.from(bytes)); },
      async downloadToBuffer() { return blobs.get(name); } }) };
    const name = await uploadBundle(container, bundle, new Date(AT));
    assert.match(name, /^backups\/2026-11-24T20:00:00\.000Z-[0-9a-f]{64}\.json$/);
    const corrupt = { getBlockBlobClient: n => ({ name: n, async uploadData() {}, async downloadToBuffer() { return Buffer.from('x'); } }) };
    await assert.rejects(uploadBundle(corrupt, bundle), /verification failed/);
  } finally { cf.cleanup(); }
});

test('renderSnapshot/serialize produce the v1 document shape', () => {
  const doc = renderSnapshot(real.jobs, real.generatedAt);
  assert.deepEqual(Object.keys(doc), ['schemaVersion', 'generatedAt', 'source', 'jobs']);
  assert.ok(serialize(doc).endsWith('}\n'));
});
