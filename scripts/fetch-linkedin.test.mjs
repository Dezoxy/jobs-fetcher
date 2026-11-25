import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backoffMs, collectLinkedIn, fetchWithRetry, parseCards } from './fetch-linkedin.mjs';

const card = id => ({ jobId: String(id), title: 'Cloud Engineer', company: 'Example',
  location: 'Budapest, Hungary', posted: '2026-10-11' });
const page = start => Array.from({ length: 10 }, (_, i) => card(start + i + 1));
const options = { pause: async () => {}, now: () => new Date('2026-10-11T13:00:00Z') };

test('daily discovery covers 26 hours, deduplicates overlapping queries and preserves card fields', async () => {
  const { document, exitCode } = await collectLinkedIn({ ...options, queries: ['cloud', 'devops'],
    async fetchPage(q, window, start) {
      assert.equal(window, 'r93600'); assert.equal(start, 0);
      return [card(1), card(q === 'cloud' ? 2 : 3)];
    } });
  assert.equal(exitCode, 0); assert.equal(document.lookbackHours, 26);
  assert.equal(document.collectedAt, '2026-10-11T13:00:00.000Z');
  assert.deepEqual(document.linkedinAlerts.map(row => row.id), ['li-1', 'li-2', 'li-3']);
  assert.equal(document.linkedinAlerts[0].title, 'Cloud Engineer');
  assert.equal(document.linkedinAlerts[0].location, 'Budapest, Hungary');
  assert.deepEqual(document.queries.map(query => query.fresh), [2, 1]);
});

test('real result cap and repeated first-page regression are distinguished', async () => {
  for (const paging of [false, true]) {
    const { document, exitCode } = await collectLinkedIn({ ...options, queries: ['architect'],
      async fetchPage(q, window, start) { return page(paging ? 0 : start); } });
    assert.equal(exitCode, 5);
    assert.equal(document.linkedinAlerts.length, paging ? 10 : 100);
    assert.deepEqual(document.truncatedQueries, [{ q: 'architect', window: 'r93600', paging }]);
  }
});

test('overlap with earlier queries never looks like broken paging', async () => {
  const { document, exitCode } = await collectLinkedIn({ ...options, queries: ['first', 'second'],
    async fetchPage(q, window, start) { return page(start); } });
  assert.equal(exitCode, 5);
  assert.equal(document.queries[1].fresh, 0);
  assert.ok(document.truncatedQueries.every(query => query.paging === false));
});

test('partial HTTP failure retains usable rows and raises degraded coverage above the row threshold', async () => {
  const { document, exitCode } = await collectLinkedIn({ ...options, queries: ['cloud', 'devops'],
    async fetchPage(q, window, start) {
      if (q === 'devops') throw new Error('HTTP 429');
      return start < 20 ? page(start) : [];
    } });
  assert.equal(document.linkedinAlerts.length, 20); assert.equal(exitCode, 5);
  assert.equal(document.auth.linkedin.state, 'ok');
  assert.deepEqual(document.queryFailures, ['devops [r93600]: HTTP 429']);
});

test('failure midway through a query retains its first page and remains degraded', async () => {
  const { document, exitCode } = await collectLinkedIn({ ...options, queries: ['cloud', 'devops'],
    async fetchPage(q, window, start) {
      if (q === 'devops') return [card(101)];
      if (start === 0) return page(0);
      throw new Error('HTTP 503');
    } });
  assert.equal(exitCode, 5); assert.equal(document.linkedinAlerts.length, 11);
  assert.equal(document.queryFailures.length, 1);
});

test('total failure blocks collection; empty successful searches remain explicitly undetermined', async () => {
  const failed = await collectLinkedIn({ ...options, queries: ['cloud', 'devops'],
    async fetchPage() { throw new Error('HTTP 429'); } });
  assert.equal(failed.exitCode, 4); assert.equal(failed.document.auth.linkedin.state, 'undetermined');
  assert.equal(failed.document.queryFailures.length, 2);
  const empty = await collectLinkedIn({ ...options, queries: ['cloud'], async fetchPage() { return []; } });
  assert.equal(empty.exitCode, 0); assert.equal(empty.document.auth.linkedin.state, 'undetermined');
});

test('backoff doubles from 5 s with jitter, caps at 60 s and honours Retry-After', () => {
  const noJitter = () => 0;
  assert.deepEqual([1, 2, 3, 6].map(n => backoffMs(n, null, noJitter)), [5000, 10000, 20000, 60000]);
  assert.equal(backoffMs(1, null, () => 0.999), 5999);
  assert.equal(backoffMs(1, '12', noJitter), 12000);
  assert.equal(backoffMs(1, '900', noJitter), 60000);
  assert.equal(backoffMs(2, 'Wed, 25 Nov 2026 13:00:00 GMT', noJitter), 10000);
});

const response = (status, headers = {}) => ({ status, headers: new Map(Object.entries(headers)),
  text: async () => `<li>${status}</li>` });

test('page fetch retries 429 and 5xx with backoff, then returns the body', async () => {
  const statuses = [429, 503, 200]; const waits = [];
  const body = await fetchWithRetry('u', { fetchImpl: async () => response(statuses.shift(), { 'retry-after': '7' }),
    pause: async ms => waits.push(ms), random: () => 0, onRetry() {} });
  assert.equal(body, '<li>200</li>'); assert.deepEqual(waits, [7000, 7000]);
});

test('page fetch gives up after four attempts and fails fast on other statuses', async () => {
  let calls = 0;
  await assert.rejects(fetchWithRetry('u', { fetchImpl: async () => { calls++; return response(429); },
    pause: async () => {}, onRetry() {} }), /HTTP 429/);
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(fetchWithRetry('u', { fetchImpl: async () => { calls++; return response(404); },
    pause: async () => {}, onRetry() {} }), /HTTP 404/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchWithRetry('u', { fetchImpl: async () => { calls++; throw new Error('timeout'); },
    pause: async () => {}, onRetry() {} }), /timeout/);
  assert.equal(calls, 4);
});

test('a query that still fails is resumed once from the page it stopped at, after a cooldown', async () => {
  const seen = []; const waits = []; let failOnce = true;
  const { document, exitCode } = await collectLinkedIn({ ...options, queries: ['cloud', 'devops'],
    pause: async ms => waits.push(ms),
    async fetchPage(q, window, start) {
      seen.push(`${q}@${start}`);
      if (q === 'devops' && start === 10 && failOnce) { failOnce = false; throw new Error('HTTP 429'); }
      return start < 20 ? page(q === 'cloud' ? start : 100 + start) : [];
    } });
  assert.deepEqual(seen, ['cloud@0', 'cloud@10', 'cloud@20', 'devops@0', 'devops@10', 'devops@10', 'devops@20']);
  assert.ok(waits.includes(90_000));
  assert.equal(exitCode, 0); assert.deepEqual(document.queryFailures, []);
  assert.equal(document.linkedinAlerts.length, 40);
  assert.equal(document.queries[1].resumed, true); assert.equal(document.queries[1].got, 20);
  assert.equal(document.queries[0].resumed, undefined);
});

test('no cooldown when every query succeeds; a query failing twice stays a failure', async () => {
  const waits = [];
  await collectLinkedIn({ ...options, queries: ['cloud'], pause: async ms => waits.push(ms),
    async fetchPage() { return [card(1)]; } });
  assert.ok(!waits.includes(90_000));
  const { document, exitCode } = await collectLinkedIn({ ...options, queries: ['cloud', 'devops'],
    async fetchPage(q, window, start) { if (q === 'devops') throw new Error('HTTP 429'); return start ? [] : page(0); } });
  assert.equal(exitCode, 5); assert.deepEqual(document.queryFailures, ['devops [r93600]: HTTP 429']);
});

test('the collection stops at its time budget and skips the resume pass', async () => {
  let clock = Date.parse('2026-10-11T13:00:00Z'); const waits = [];
  const { document, exitCode } = await collectLinkedIn({ queries: ['cloud', 'devops', 'sre'],
    now: () => new Date(clock), pause: async ms => waits.push(ms),
    async fetchPage(q) {
      clock += 7 * 60_000;
      if (q === 'cloud') throw new Error('HTTP 429');
      return [card(q.length)];
    } });
  assert.equal(exitCode, 5); assert.ok(!waits.includes(90_000));
  assert.deepEqual(document.queryFailures, ['cloud [r93600]: HTTP 429', 'sre [r93600]: time budget of 12 min exhausted']);
});

test('guest markup parser retains title and location and drops untitled cards', () => {
  const html = id => `<li><div data-entity-urn="urn:li:jobPosting:${id}">
    <h3 class="base-search-card__title">Cloud &amp; Platform Engineer</h3>
    <h4 class="base-search-card__subtitle">Example</h4>
    <span class="job-search-card__location">Budapest, Hungary</span>
    <time datetime="2026-10-11"></time></div></li>`;
  const rows = parseCards(html(123) + html(124).replace('Cloud &amp; Platform Engineer', ''));
  assert.equal(rows.length, 1); assert.equal(rows[0].title, 'Cloud & Platform Engineer');
  assert.equal(rows[0].location, 'Budapest, Hungary'); assert.equal(rows[0].jobId, '123');
});

test('collector help never performs discovery or needs credentials', () => {
  const output = execFileSync(process.execPath, ['scripts/fetch-linkedin.mjs', '--help'], { encoding: 'utf8' });
  assert.match(output, /26-hour lookback/);
});

test('filter carries discovery coverage diagnostics into the actual merge input', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-coverage-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input.json'); const output = path.join(root, 'output.json');
  const diagnostics = { lookbackHours: 26, queryFailures: ['cloud [r93600]: HTTP 429'],
    truncatedQueries: [{ q: 'architect', window: 'r93600', paging: false }] };
  await fs.writeFile(input, JSON.stringify({ ...diagnostics, auth: { linkedin: { state: 'ok' } }, linkedinAlerts: [] }));
  execFileSync(process.execPath, ['scripts/filter-browser.mjs', input, '-o', output]);
  const filtered = JSON.parse(await fs.readFile(output));
  for (const [name, value] of Object.entries(diagnostics)) assert.deepEqual(filtered[name], value);
});
