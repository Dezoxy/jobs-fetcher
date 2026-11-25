#!/usr/bin/env node
// One-shot import of v1 state into the two D1 databases (cutover step 1,
// docs/architecture-v2.md).
//
//   node scripts/v2/import.mjs (--state v1-state.json | --jobs jobs.json)
//        (--ledger rejected-ids.json | --no-ledger)
//        (--streaks unseen-streaks.json | --no-streaks)
//        (--tracker tracker.json | --no-tracker) [--dry-run]
//
// --state is the private file `cloud-run.mjs export` writes (the v1 Blob
// bundle: its `files` carry the ledger, the streaks, jobs.json and
// last-run.json); it satisfies --jobs, --ledger and --streaks for the files it
// holds. Explicit --jobs/--ledger/--streaks override its entries. The ledger and
// the streaks are required (or explicitly waived with --no-…): importing jobs
// without the ledger would resurrect every rejected ad on the first run.
// --tracker is the v1 KV tracker value ({ "<id>": { st, at } }, GET /api/tracker).
//
// Safety and re-runs:
//   - jobs-data (jobs + verdicts + streaks) is ONE atomic batch, written only
//     into empty tables; any existing row refuses the whole import before
//     anything is written.
//   - jobs-tracker: when meta 'tracker_imported' exists the tracker part is
//     SKIPPED (the Worker may already hold newer clicks); otherwise the tracker
//     rows and then the marker are ONE atomic batch into an empty table.
//   - The tracker part runs first, so a failed jobs batch is simply re-run: the
//     tracker is skipped by its marker and jobs-data is still empty.
// --dry-run needs no credentials and prints counts and the largest statement.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rowProblem } from './merge.mjs';
import { upsertJobs, upsertVerdicts, replaceStreaks, chunkJson, TRACKER_MARKER } from './store.mjs';
import { configFromEnv, createCloudflare, checkStatement } from './d1.mjs';
import { LEGACY } from '../ledger.mjs';

const TRACKER_STATES = new Set(['saved', 'applied', 'interview', 'offer', 'rejected', 'ignored']);

/** Same shapes ledger.mjs readLedger accepts: { ids: {id: reason} } or a legacy flat array. */
export function parseLedger(raw) {
  if (Array.isArray(raw)) return Object.fromEntries(raw.filter(id => typeof id === 'string').map(id => [id, LEGACY]));
  const ids = raw?.ids;
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) return {};
  return Object.fromEntries(Object.entries(ids).map(([id, why]) => [id, typeof why === 'string' && why ? why : LEGACY]));
}

/**
 * Pure: inputs -> the statements for each database plus counts. `tracker: null`
 * means "no tracker part" (nothing written to jobs-tracker, no marker).
 * Throws on any row validate.mjs would reject — an import never launders bad data.
 */
export function planImport({ jobsDoc, ledger = {}, streaks = {}, tracker = null, importedAt }) {
  const jobs = jobsDoc?.jobs;
  if (!Array.isArray(jobs) || !jobs.length) throw new Error('jobs.json has no jobs');
  const ids = new Set(), urls = new Set();
  for (const j of jobs) {
    const problem = rowProblem(j);
    if (problem) throw new Error(`row ${j?.id}: ${problem}`);
    if (ids.has(j.id) || urls.has(j.url)) throw new Error(`duplicate id or url: ${j.id}`);
    ids.add(j.id); urls.add(j.url);
  }
  const verdicts = Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b))
    .map(([id, reason]) => ({ id, reason, judgeVersion: null, at: importedAt }));
  const cleanStreaks = Object.fromEntries(Object.entries(streaks)
    .filter(([id, n]) => typeof id === 'string' && Number.isInteger(n) && n >= 0));
  const jobsStatements = [...upsertJobs(jobs), ...upsertVerdicts(verdicts), ...replaceStreaks(cleanStreaks)];
  let trackerStatements = [];
  let trackerRows = [];
  if (tracker) {
    trackerRows = Object.entries(tracker)
      .filter(([id, v]) => id.length <= 200 && TRACKER_STATES.has(v?.st) && typeof v?.at === 'string' && v.at.length <= 40)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, v]) => ({ id, st: v.st, at: v.at }));
    trackerStatements = [...chunkJson(trackerRows).map(chunk => ({
      sql: `INSERT INTO tracker (id, st, at)
SELECT json_extract(value, '$.id'), json_extract(value, '$.st'), json_extract(value, '$.at') FROM json_each(?)`,
      params: [JSON.stringify(chunk)],
    })),
    // Last, in the same batch: the Worker serves the tracker only once this exists.
    { sql: 'INSERT INTO meta (key, value) VALUES (?, ?)', params: [TRACKER_MARKER, importedAt] }];
  }
  for (const s of [...jobsStatements, ...trackerStatements]) checkStatement(s);
  return {
    jobsStatements, trackerStatements,
    counts: { jobs: jobs.length, verdicts: verdicts.length, streaks: Object.keys(cleanStreaks).length,
      tracker: trackerRows.length, trackerSkipped: tracker ? Object.keys(tracker).length - trackerRows.length : 0 },
  };
}

const count = async (cf, db, table) => Number((await cf.query(db, `SELECT count(*) AS n FROM ${table}`))[0].n);

export async function assertJobsEmpty(cf) {
  for (const table of ['jobs', 'verdicts', 'streaks', 'runs']) {
    const n = await count(cf, 'jobs', table);
    if (n !== 0) throw new Error(`jobs-data.${table} already holds ${n} rows — refusing to import over existing data`);
  }
}

/** -> { tracker: 'imported' | 'skipped' | 'not-requested', jobs: 'imported' } */
export async function runImport(cf, plan, log = console.log) {
  await assertJobsEmpty(cf); // fail before writing anything
  let tracker = 'not-requested';
  const marker = await cf.query('tracker', 'SELECT value FROM meta WHERE key = ?', [TRACKER_MARKER]);
  if (marker.length) {
    tracker = 'skipped';
    log(`import: jobs-tracker already imported at ${marker[0].value} (meta ${TRACKER_MARKER}) — tracker part skipped`);
  } else if (plan.trackerStatements.length) {
    const n = await count(cf, 'tracker', 'tracker');
    if (n !== 0) throw new Error(`jobs-tracker.tracker holds ${n} rows but has no ${TRACKER_MARKER} marker — refusing; inspect it by hand`);
    await cf.batch('tracker', plan.trackerStatements);
    tracker = 'imported';
  }
  await cf.batch('jobs', plan.jobsStatements);
  return { tracker, jobs: 'imported' };
}

function args(argv) {
  const out = { dryRun: argv.includes('--dry-run') };
  for (const key of ['state', 'jobs', 'ledger', 'streaks', 'tracker']) {
    const i = argv.indexOf(`--${key}`);
    if (i !== -1) { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`--${key} needs a file`); out[key] = argv[i + 1]; }
    out[`no_${key}`] = argv.includes(`--no-${key}`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), env = process.env, now = new Date(), log = console.log) {
  const a = args(argv);
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const state = a.state ? read(a.state) : null;
  const fromState = name => state?.files?.[name] !== undefined ? JSON.parse(state.files[name]) : undefined;
  const pick = (key, stateFile) => {
    if (a[key] && a[`no_${key}`]) throw new Error(`--${key} and --no-${key} are exclusive`);
    if (a[key]) return read(a[key]);
    if (a[`no_${key}`]) return null;
    const value = fromState(stateFile);
    if (value === undefined) throw new Error(`--${key} FILE (or --state holding ${stateFile}, or --no-${key}) is required`);
    return value;
  };
  const jobsDoc = a.jobs ? read(a.jobs) : fromState('public/data/jobs.json');
  if (!jobsDoc) throw new Error('--jobs FILE or --state FILE is required');
  const ledger = parseLedger(pick('ledger', '.cache/rejected-ids.json') ?? {});
  const streaks = pick('streaks', '.cache/unseen-streaks.json') ?? {};
  if (!a.tracker && !a.no_tracker) throw new Error('--tracker FILE or --no-tracker is required (an imported tracker is skipped either way)');
  const tracker = a.tracker ? read(a.tracker) : null;
  const plan = planImport({ jobsDoc, ledger, streaks, tracker, importedAt: now.toISOString() });
  const largest = Math.max(...[...plan.jobsStatements, ...plan.trackerStatements]
    .map(s => Buffer.byteLength(s.sql) + s.params.reduce((n, p) => n + Buffer.byteLength(String(p)), 0)));
  log(`import: jobs=${plan.counts.jobs} verdicts=${plan.counts.verdicts} streaks=${plan.counts.streaks} ` +
    `tracker=${tracker ? plan.counts.tracker : 'none'} tracker_skipped=${plan.counts.trackerSkipped} ` +
    `statements=jobs:${plan.jobsStatements.length},tracker:${plan.trackerStatements.length} largest_statement_bytes=${largest}`);
  if (a.dryRun) { log('import: --dry-run, nothing written'); return 0; }
  const done = await runImport(createCloudflare(configFromEnv(env)), plan, log);
  log(`import: done jobs=${done.jobs} tracker=${done.tracker}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`import: ${String(error?.message ?? error).slice(0, 500)}`); process.exitCode = 1;
  });
}
