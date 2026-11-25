// D1 <-> jobs.json shapes, state loading, the commit batch, and the snapshot.
// Shared by run.mjs, import.mjs, export-json.mjs and backup.mjs so there is
// exactly one mapping between the D1 columns and the published JSON.
//
// Write rules (docs/architecture-v2.md): never more than 100 bound parameters
// per statement — every list goes in as ONE JSON string parameter expanded with
// json_each(?) — and each such JSON parameter is kept under JSON_CHUNK_BYTES so
// a statement stays inside D1's 100 KB statement limit whichever way D1 counts
// bound values.

export const JSON_CHUNK_BYTES = 90_000;
export const SNAPSHOT_SOURCE = 'LinkedIn alerts, Profession.hu alerts, No Fluff Jobs subscriptions, Indeed Hungary';

// jobs.json field order is part of the published contract (and of the
// round-trip test): v1 fields first, then the optional ones.
export function toRow(job) {
  return {
    id: job.id, role: job.role, company: job.company, source: job.source,
    category: job.category, type: job.type, description: job.description,
    salary_lo: job.salaryLo, salary_hi: job.salaryHi, salary_posted: job.salaryPosted ? 1 : 0,
    benchmark: job.benchmark, url: job.url, status: job.status,
    first_seen: job.firstSeen, last_seen: job.lastSeen,
    closed: job.closed ?? null, repost_of: job.repostOf ?? null,
  };
}

export function fromRow(row) {
  const job = {
    id: row.id, role: row.role, company: row.company, source: row.source,
    category: row.category, type: row.type, description: row.description,
    salaryLo: Number(row.salary_lo), salaryHi: Number(row.salary_hi), salaryPosted: Number(row.salary_posted) === 1,
    benchmark: row.benchmark, url: row.url, status: row.status,
    firstSeen: row.first_seen, lastSeen: row.last_seen,
  };
  if (row.closed) job.closed = row.closed;
  if (row.repost_of) job.repostOf = row.repost_of;
  return job;
}

/** Split items into arrays whose JSON encoding stays under maxBytes. */
export function chunkJson(items, maxBytes = JSON_CHUNK_BYTES) {
  const chunks = [];
  let current = [], size = 2;
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + 2 > maxBytes) throw new Error(`A single item is larger than ${maxBytes} bytes`);
    if (current.length && size + bytes > maxBytes) { chunks.push(current); current = []; size = 2; }
    current.push(item); size += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const JOB_COLUMNS = ['id', 'role', 'company', 'source', 'category', 'type', 'description',
  'salary_lo', 'salary_hi', 'salary_posted', 'benchmark', 'url', 'status',
  'first_seen', 'last_seen', 'closed', 'repost_of'];

// `WHERE true` is required: without it SQLite parses ON CONFLICT as part of the SELECT's join.
const upsertJobsSql = `INSERT INTO jobs (${JOB_COLUMNS.join(', ')})
SELECT ${JOB_COLUMNS.map(c => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?) WHERE true
ON CONFLICT(id) DO UPDATE SET ${JOB_COLUMNS.slice(1).map(c => `${c} = excluded.${c}`).join(', ')}`;

export function upsertJobs(jobs) {
  return chunkJson(jobs.map(toRow)).map(chunk => ({ sql: upsertJobsSql, params: [JSON.stringify(chunk)] }));
}
export function deleteIds(table, ids) {
  if (!['jobs', 'verdicts', 'streaks'].includes(table)) throw new Error('deleteIds: unknown table');
  return chunkJson(ids).map(chunk => ({
    sql: `DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(chunk)],
  }));
}
export function upsertVerdicts(adds) {
  const rows = adds.map(a => ({ id: a.id, reason: a.reason, judge_version: a.judgeVersion ?? null, at: a.at }));
  return chunkJson(rows).map(chunk => ({
    sql: `INSERT INTO verdicts (id, reason, judge_version, at)
SELECT json_extract(value, '$.id'), json_extract(value, '$.reason'), json_extract(value, '$.judge_version'), json_extract(value, '$.at')
FROM json_each(?) WHERE true
ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, judge_version = excluded.judge_version, at = excluded.at`,
    params: [JSON.stringify(chunk)],
  }));
}
export function replaceStreaks(streaks) {
  const rows = Object.entries(streaks).sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => ({ id, count }));
  return [{ sql: 'DELETE FROM streaks', params: [] }, ...chunkJson(rows).map(chunk => ({
    sql: `INSERT INTO streaks (id, count)
SELECT json_extract(value, '$.id'), json_extract(value, '$.count') FROM json_each(?)`,
    params: [JSON.stringify(chunk)],
  }))];
}
export function consumeEmailCandidates(ids, slot) {
  return chunkJson(ids).map(chunk => ({
    sql: 'UPDATE email_candidates SET consumed_slot = ? WHERE consumed_slot IS NULL AND id IN (SELECT value FROM json_each(?))',
    params: [slot, JSON.stringify(chunk)],
  }));
}
export function insertRun({ slot, payloadSha256, committedAt, runNote, diff }) {
  // Plain INSERT on purpose: a second commit for the same slot fails on the
  // primary key, and because this is the batch's FIRST statement the whole
  // batch rolls back. That is the idempotency guard for concurrent runs.
  return { sql: 'INSERT INTO runs (slot, payload_sha256, committed_at, run_note, diff) VALUES (?, ?, ?, ?, ?)',
    params: [slot, payloadSha256, committedAt, JSON.stringify(runNote), JSON.stringify(diff)] };
}

/** Everything one run writes, as one ordered list for one atomic batch. */
export function commitStatements({ slot, payloadSha256, committedAt, runNote, previousIds, result, consumedEmailIds = [] }) {
  const changed = new Set(result.diff.added);
  const prevById = previousIds; // Map id -> JSON string of the previous job
  const upserts = result.jobs.filter(j => changed.has(j.id) || prevById.get(j.id) !== JSON.stringify(j));
  return [
    insertRun({ slot, payloadSha256, committedAt, runNote, diff: result.diff }),
    ...deleteIds('jobs', result.diff.removed),
    ...upsertJobs(upserts),
    ...deleteIds('verdicts', result.verdictReleases),
    ...upsertVerdicts(result.verdictAdds),
    ...replaceStreaks(result.streaks),
    ...consumeEmailCandidates(consumedEmailIds, slot),
  ];
}

/** The published jobs.json document. */
export function renderSnapshot(jobs, generatedAt) {
  return { schemaVersion: 1, generatedAt, source: SNAPSHOT_SOURCE, jobs };
}
export const serialize = (doc) => JSON.stringify(doc, null, 2) + '\n';

// Reads go through ONE batch per database: a batch is one transaction, so the
// tables come from the same instant even while the Worker replaces the tracker
// (PUT) or receives an alert e-mail. No paging: a page boundary is exactly where
// a concurrent write would interleave.
const readBatch = (d1, db, sqls) => d1.batch(db, sqls.map(sql => ({ sql, params: [] })));
const LAST_RUN_SQL = 'SELECT slot, payload_sha256, committed_at, run_note FROM runs ORDER BY slot DESC LIMIT 1';
export const TRACKER_MARKER = 'tracker_imported';

/**
 * Full state as merge() wants it. Jobs keep insertion (rowid) order = v1 file
 * order. `trackerImported` is the meta marker the import writes last; until it
 * exists the tracker table is not the owner's tracker.
 */
export async function loadState(d1) {
  const [[jobRows, verdictRows, streakRows, emailRows, runRows], [trackerRows, metaRows]] = await Promise.all([
    readBatch(d1, 'jobs', ['SELECT * FROM jobs ORDER BY rowid', 'SELECT * FROM verdicts ORDER BY id',
      'SELECT * FROM streaks ORDER BY id',
      'SELECT id, received_at FROM email_candidates WHERE consumed_slot IS NULL ORDER BY id', LAST_RUN_SQL]),
    readBatch(d1, 'tracker', ['SELECT id, st, at FROM tracker ORDER BY id',
      `SELECT value FROM meta WHERE key = '${TRACKER_MARKER}'`]),
  ]);
  return {
    jobs: jobRows.map(fromRow),
    verdicts: Object.fromEntries(verdictRows.map(v => [v.id, { reason: v.reason, judgeVersion: v.judge_version ?? null, at: v.at }])),
    streaks: Object.fromEntries(streakRows.map(s => [s.id, Number(s.count)])),
    emailCandidates: emailRows.map(e => ({ id: e.id, receivedAt: e.received_at })),
    tracker: Object.fromEntries(trackerRows.map(t => [t.id, { st: t.st, at: t.at }])),
    lastRun: runRows[0] ?? null,
    trackerImported: metaRows.length > 0,
  };
}

/** The published pair for given rows and the latest run row (null before the first v2 run). */
export function snapshotOf(jobs, run, now = new Date().toISOString()) {
  return { jobs: renderSnapshot(jobs, run?.committed_at ?? now), runNote: run ? JSON.parse(run.run_note) : null };
}

/**
 * The published pair as D1 holds it now: jobs.json in insertion order with the
 * latest run's committed_at as generatedAt, and that run's note (null before
 * the first v2 run). Used to heal a lost KV write and for rollback exports.
 */
export async function readSnapshot(d1, now = new Date().toISOString()) {
  const [rows, runs] = await readBatch(d1, 'jobs', ['SELECT * FROM jobs ORDER BY rowid', LAST_RUN_SQL]);
  return snapshotOf(rows.map(fromRow), runs[0] ?? null, now);
}

/** Every row of every table, for backups — one consistent read per database. */
export async function dumpDatabase(d1, db) {
  const tables = db === 'tracker' ? ['tracker', 'meta'] : ['jobs', 'verdicts', 'streaks', 'runs', 'email_candidates'];
  const results = await readBatch(d1, db, tables.map(t => `SELECT * FROM ${t} ORDER BY rowid`));
  return Object.fromEntries(tables.map((t, i) => [t, results[i]]));
}
