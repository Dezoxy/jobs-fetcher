import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectLinkedIn, parseCards } from './fetch-linkedin.mjs';

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
