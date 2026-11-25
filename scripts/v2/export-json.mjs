#!/usr/bin/env node
// Rollback export (docs/architecture-v2.md "Cutover"): D1 -> the v1 files.
//
//   node scripts/v2/export-json.mjs <out-dir>
//
// Writes, from ONE consistent read of jobs-data:
//   jobs.json, last-run.json     byte-for-byte the snapshot run.mjs publishes
//                                (v1: public/data/)
//   rejected-ids.json            the ledger as ledger.mjs writes it, { ids: {id: reason} }
//   unseen-streaks.json          { id: count }  (v1: both under .cache/, i.e. the
//                                Blob state bundle's files of the same names)
// last-run.json is written before jobs.json (the v1 write order); it is absent
// before the first v2 run. Existing files in <out-dir> are replaced.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromRow, snapshotOf, serialize } from './store.mjs';
import { configFromEnv, createCloudflare } from './d1.mjs';

export async function exportJson(cf, dir) {
  const [jobRows, runRows, verdictRows, streakRows] = await cf.batch('jobs', [
    'SELECT * FROM jobs ORDER BY rowid',
    'SELECT slot, payload_sha256, committed_at, run_note FROM runs ORDER BY slot DESC LIMIT 1',
    'SELECT id, reason FROM verdicts ORDER BY id',
    'SELECT id, count FROM streaks ORDER BY id',
  ].map(sql => ({ sql, params: [] })));
  if (!jobRows.length) throw new Error('D1 jobs table is empty — nothing to export');
  const { jobs, runNote } = snapshotOf(jobRows.map(fromRow), runRows[0] ?? null);
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, doc) => fs.writeFileSync(path.join(dir, name), serialize(doc));
  write('rejected-ids.json', { ids: Object.fromEntries(verdictRows.map(v => [v.id, v.reason])) });
  write('unseen-streaks.json', Object.fromEntries(streakRows.map(s => [s.id, Number(s.count)])));
  if (runNote) write('last-run.json', runNote);
  write('jobs.json', jobs);
  return { jobs: jobs.jobs.length, runNote: !!runNote, verdicts: verdictRows.length, streaks: streakRows.length };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    console.error('usage: export-json.mjs <out-dir>');
    return 2;
  }
  const r = await exportJson(createCloudflare(configFromEnv(env)), argv[0]);
  console.log(`export-json: jobs=${r.jobs} verdicts=${r.verdicts} streaks=${r.streaks} ` +
    `last_run=${r.runNote ? 'written' : 'none (no v2 run yet)'} dir=${argv[0]}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`export-json: ${String(error?.message ?? error).slice(0, 500)}`); process.exitCode = 1;
  });
}
