import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudflare, checkStatement, configFromEnv, CloudflareError } from './d1.mjs';

const TOKEN = 'cf-secret-token-value';
const config = { accountId: 'acc12345', token: TOKEN, databases: { jobs: 'jobs-db-id', tracker: 'tracker-db-id' }, kvNamespace: 'kv-namespace-id' };
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status,
      headers: { get: k => next.headers?.[k.toLowerCase()] ?? null },
      json: async () => { if (next.body === undefined) throw new Error('no json'); return next.body; } };
  };
  fn.calls = calls;
  return fn;
}
const ok = (result) => ({ status: 200, body: { success: true, errors: [], result } });
const noSleep = async () => {};

test('query posts {sql, params} to the D1 /query endpoint with a bearer token and returns rows', async () => {
  const f = fakeFetch([ok([{ success: true, results: [{ n: 1 }] }])]);
  const cf = createCloudflare(config, { fetchImpl: f, sleep: noSleep });
  assert.deepEqual(await cf.query('jobs', 'SELECT ? AS n', [1]), [{ n: 1 }]);
  assert.equal(f.calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acc12345/d1/database/jobs-db-id/query');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { sql: 'SELECT ? AS n', params: [1] });
  assert.equal(f.calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
});

test('batch uses the {batch:[...]} form against the named database and returns per-statement rows', async () => {
  const f = fakeFetch([ok([{ success: true, results: [] }, { success: true, results: [{ a: 1 }] }])]);
  const cf = createCloudflare(config, { fetchImpl: f, sleep: noSleep });
  const r = await cf.batch('tracker', [{ sql: 'DELETE FROM tracker' }, { sql: 'SELECT 1 AS a', params: [] }]);
  assert.deepEqual(r, [[], [{ a: 1 }]]);
  assert.match(f.calls[0].url, /tracker-db-id/);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { batch: [{ sql: 'DELETE FROM tracker', params: [] }, { sql: 'SELECT 1 AS a', params: [] }] });
});

test('more than 100 bound parameters is refused before any request', async () => {
  const f = fakeFetch([]);
  const cf = createCloudflare(config, { fetchImpl: f, sleep: noSleep });
  const params = Array.from({ length: 101 }, (_, i) => i);
  await assert.rejects(cf.query('jobs', 'SELECT 1', params), /101 parameters/);
  await assert.rejects(cf.batch('jobs', [{ sql: 'SELECT 1', params }]), /json_each/);
  assert.equal(f.calls.length, 0);
  assert.doesNotThrow(() => checkStatement({ sql: 'x', params: params.slice(0, 100) }));
  assert.throws(() => checkStatement({ sql: 'x'.repeat(100_001) }), /100 KB/);
  assert.throws(() => checkStatement({ sql: 'x', params: [{}] }), /supported/);
});

test('retries 429 and 5xx with backoff (Retry-After honoured), then succeeds', async () => {
  const f = fakeFetch([{ status: 429, headers: { 'retry-after': '2' }, body: {} }, { status: 503, body: undefined }, ok([{ success: true, results: [] }])]);
  const waits = [];
  const cf = createCloudflare(config, { fetchImpl: f, sleep: async ms => waits.push(ms), baseDelayMs: 100 });
  await cf.query('jobs', 'SELECT 1');
  assert.equal(f.calls.length, 3);
  assert.deepEqual(waits, [2000, 200]);
});

test('4xx is not retried; network errors are not retried; nothing carries the token', async () => {
  const f = fakeFetch([{ status: 400, body: { success: false, errors: [{ code: 7500, message: 'SQLITE_ERROR: no such table' }] } }]);
  const cf = createCloudflare(config, { fetchImpl: f, sleep: noSleep });
  const err = await cf.query('jobs', 'SELECT 1').catch(e => e);
  assert.ok(err instanceof CloudflareError);
  assert.equal(f.calls.length, 1);
  assert.match(err.message, /400 — 7500: SQLITE_ERROR/);
  assert.deepEqual(err.codes, [7500]);
  const netErr = Object.assign(new TypeError(`fetch failed ${TOKEN}`), { cause: { code: 'ECONNRESET' } });
  const f2 = fakeFetch([netErr]);
  const e2 = await createCloudflare(config, { fetchImpl: f2, sleep: noSleep }).query('jobs', 'SELECT 1').catch(e => e);
  assert.equal(f2.calls.length, 1);
  for (const e of [err, e2]) assert.ok(!JSON.stringify({ m: e.message, s: e.stack }).includes(TOKEN));
});

test('gives up after the attempt budget on persistent 5xx', async () => {
  const f = fakeFetch(Array.from({ length: 3 }, () => ({ status: 500, body: { success: false, errors: [] } })));
  const cf = createCloudflare(config, { fetchImpl: f, sleep: noSleep, attempts: 3 });
  await assert.rejects(cf.query('jobs', 'SELECT 1'), /Cloudflare API 500/);
  assert.equal(f.calls.length, 3);
});

test('a batch result with a failed statement is an error', async () => {
  const f = fakeFetch([ok([{ success: true, results: [] }, { success: false }])]);
  await assert.rejects(createCloudflare(config, { fetchImpl: f, sleep: noSleep }).batch('jobs', [{ sql: 'a' }, { sql: 'b' }]), /incomplete/);
});

test('kvPut PUTs the raw value to the snapshot namespace', async () => {
  const f = fakeFetch([ok(null)]);
  await createCloudflare(config, { fetchImpl: f, sleep: noSleep }).kvPut('jobs.json', '{"a":1}');
  assert.equal(f.calls[0].init.method, 'PUT');
  assert.equal(f.calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acc12345/storage/kv/namespaces/kv-namespace-id/values/jobs.json');
  assert.equal(f.calls[0].init.body, '{"a":1}');
  await assert.rejects(createCloudflare({ ...config, kvNamespace: null }).kvPut('x', 'y'), /SNAPSHOT_KV_ID/);
  await assert.rejects(createCloudflare(config).kvPut('../x', 'y'), /Invalid KV key/);
});

test('configFromEnv requires the ids and token, and rejects malformed ids', () => {
  assert.throws(() => configFromEnv({}), /CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, JOBS_D1_ID, TRACKER_D1_ID/);
  const env = { CLOUDFLARE_ACCOUNT_ID: 'acc12345', CLOUDFLARE_API_TOKEN: TOKEN, JOBS_D1_ID: '5f419f86-7d5d-4985-b5aa-b238c97325b2',
    TRACKER_D1_ID: 'f0e46999-c933-4b19-abf1-6df633f77b50', SNAPSHOT_KV_ID: '584f970c1e8f47bdbb036612d2024183' };
  assert.equal(configFromEnv(env).databases.tracker, env.TRACKER_D1_ID);
  assert.throws(() => configFromEnv({ ...env, JOBS_D1_ID: '../x' }), /Malformed JOBS_D1_ID/);
});
