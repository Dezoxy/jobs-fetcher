// Test-only stand-in for d1.mjs: the same query/batch/kvPut surface, executed
// by the sqlite3 CLI against a temp file, so the generated SQL (json_each
// upserts, ON CONFLICT, CHECK constraints, the runs-row guard) is exercised by
// real SQLite rather than by a mock. Batches run inside BEGIN/COMMIT with
// `.bail on`, which is D1's batch semantics: all or nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkStatement } from './d1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Every migration of a database, in file-name order — the same files D1 applies.
const migrations = (db) => {
  const dir = path.join(ROOT, 'migrations', db);
  return fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
};

export const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

const literal = (v) => v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v)
  : typeof v === 'boolean' ? (v ? '1' : '0')
  : `'${String(v).replace(/'/g, "''")}'`;
export function inline(sql, params = []) {
  let i = 0;
  const out = sql.replace(/\?/g, () => {
    if (i >= params.length) throw new Error('too few params');
    return literal(params[i++]);
  });
  if (i !== params.length) throw new Error('too many params');
  return out;
}

function runSql(file, script, json = false) {
  const args = json ? ['-json', file] : [file];
  const r = spawnSync('sqlite3', args, { input: script, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`sqlite3: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout;
}

export function createSqliteD1() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-v2-sqlite-'));
  const files = { jobs: path.join(dir, 'jobs.db'), tracker: path.join(dir, 'tracker.db') };
  runSql(files.jobs, migrations('jobs'));
  runSql(files.tracker, migrations('tracker'));
  const kv = new Map();
  const calls = { batch: 0, query: 0, kvPut: 0 };
  return {
    kv, calls, files,
    failNextBatch: false,
    async query(db, sql, params = []) {
      calls.query++;
      checkStatement({ sql, params });
      const out = runSql(files[db], `${inline(sql, params)};\n`, true).trim();
      return out ? JSON.parse(out) : [];
    },
    async batch(db, statements) {
      if (this.failNextBatch) { this.failNextBatch = false; throw new Error('injected batch failure'); }
      // A read-only batch returns each statement's rows, as D1 does. (One
      // process, no concurrent writer: running them one by one is equivalent.)
      if (statements.every(s => /^\s*SELECT\b/i.test(s.sql))) {
        const out = [];
        for (const s of statements) out.push(await this.query(db, s.sql, s.params ?? []));
        return out;
      }
      calls.batch++; // write batches only
      const body = statements.map(s => { checkStatement(s); return `${inline(s.sql, s.params ?? [])};`; }).join('\n');
      runSql(files[db], `.bail on\nBEGIN;\n${body}\nCOMMIT;\n`);
      return statements.map(() => []);
    },
    async kvPut(key, value) { calls.kvPut++; kv.set(key, value); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
