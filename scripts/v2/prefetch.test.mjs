import test from 'node:test';
import assert from 'node:assert/strict';
import { AD_TEXT_MAX_BYTES, capText, fetchAdText, htmlToText, prefetchAll } from './prefetch.mjs';

// Fake HTTP: route by exact URL, record every request. No network in tests.
function fakeGet(routes) {
  const calls = [];
  const get = async (url, options = {}) => {
    calls.push({ url, options });
    const route = routes[url];
    if (!route) return { status: 404, headers: {}, text: '' };
    const next = Array.isArray(route) ? route.shift() : route;
    if (next instanceof Error) throw next;
    return { headers: {}, ...next };
  };
  return { get, calls };
}
const noSleep = async () => {};

const LI_HTML = `<section class="top-card-layout"><h2>Senior Cloud Engineer</h2></section>
<section class="core-section-container my-3 description"><div class="description__text description__text--rich">
<section class="show-more-less-html" data-max-lines="5">
<div class="show-more-less-html__markup relative overflow-hidden"><strong>About the role</strong><br>
Run our Azure landing zone &amp; Terraform modules.<ul><li>5+ years cloud</li><li>English B2</li></ul>
<script>alert('x')</script></div>
<button class="show-more-less-html__button">Show more</button>
</section></div>
<ul class="description__job-criteria-list"><li><h3>Seniority level</h3><span>Mid-Senior level</span></li></ul></section>`;

test('LinkedIn: guest jobPosting endpoint, description extracted, scripts and buttons dropped', async () => {
  const { get, calls } = fakeGet({
    'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4465248012': { status: 200, text: LI_HTML },
  });
  const r = await fetchAdText({ id: 'li-4465248012', source: 'LinkedIn', url: 'https://www.linkedin.com/jobs/view/4465248012/' }, { get, sleep: noSleep });
  assert.equal(r.error, null);
  assert.match(r.adText, /About the role\n+Run our Azure landing zone & Terraform modules\./);
  assert.match(r.adText, /- 5\+ years cloud\n- English B2/);
  assert.match(r.adText, /Seniority level/);
  assert.doesNotMatch(r.adText, /alert|Show more|<|top-card/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['User-Agent'].startsWith('Mozilla/5.0'), true);
});

test('LinkedIn: backs off on 429 and reports 404 without guessing', async () => {
  const url = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/1';
  const sleeps = [];
  const throttled = fakeGet({ [url]: [{ status: 429, text: '' }, { status: 999, text: '' }, { status: 200, text: LI_HTML }] });
  const ok = await fetchAdText({ id: 'li-1', source: 'LinkedIn' }, { get: throttled.get, sleep: ms => sleeps.push(ms) });
  assert.equal(ok.error, null); assert.deepEqual(sleeps, [3000, 6000]);
  const gone = fakeGet({ [url]: { status: 404, text: '' } });
  assert.deepEqual(await fetchAdText({ id: 'li-1', source: 'LinkedIn' }, { get: gone.get, sleep: noSleep }),
    { adText: null, error: 'http-404' });
  assert.equal(gone.calls.length, 1);
  const bad = fakeGet({});
  assert.deepEqual(await fetchAdText({ id: 'li-abc', source: 'LinkedIn', url: 'https://evil.test/' }, { get: bad.get }),
    { adText: null, error: 'bad-id' });
  assert.equal(bad.calls.length, 0);
});

const PR_URL = 'https://www.profession.hu/allas/it-engineer-tulip-interfaces-kft-3039936';
const PR_HTML = `<html><head><title>x</title></head><body><nav>Menu Bejelentkezés</nav>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},
{"@type":"JobPosting","educationRequirements":"Angol középfok, Főiskola","experienceRequirements":"3-5 év tapasztalat",
"employmentType":"Alkalmazotti jogviszony","datePosted":"2026-10-31","description":"<p>fallback</p>"}]}</script>
<section aria-labelledby="job-description"><h2>Állás leírása</h2><h3>Responsibilities</h3>
<ul><li>Administering identity and access management</li><li>Managing office network</li></ul></section>
<footer>Cookie banner</footer></body></html>`;

test('Profession: no redirect following, ad section plus JSON-LD language/experience facts', async () => {
  const { get, calls } = fakeGet({ [PR_URL]: { status: 200, text: PR_HTML } });
  const r = await fetchAdText({ id: 'pr-3039936', source: 'Profession', url: PR_URL }, { get });
  assert.equal(r.error, null);
  assert.equal(calls[0].options.followRedirects, false);
  assert.match(r.adText, /^Employment: Alkalmazotti jogviszony\nExperience: 3-5 év tapasztalat\nEducation and language: Angol középfok, Főiskola/);
  assert.match(r.adText, /- Administering identity and access management\n- Managing office network/);
  assert.doesNotMatch(r.adText, /Menu|Cookie|fallback/);
});

test('Profession: an expired ad (301) and a foreign URL are failures, not throws', async () => {
  const { get, calls } = fakeGet({ [PR_URL]: { status: 301, text: '' } });
  assert.deepEqual(await fetchAdText({ id: 'pr-3039936', source: 'Profession', url: PR_URL }, { get }),
    { adText: null, error: 'http-301' });
  assert.deepEqual(await fetchAdText({ id: 'pr-1', source: 'Profession', url: 'https://169.254.169.254/allas/x' }, { get }),
    { adText: null, error: 'bad-url' });
  assert.equal(calls.length, 1);
});

test('NoFluff: posting API JSON becomes structured text; malformed JSON is a parse failure', async () => {
  const api = 'https://nofluffjobs.com/api/posting/senior-devops-engineer-formlabs-budapest';
  const doc = {
    title: 'Senior DevOps Engineer', status: 'PUBLISHED', basics: { category: 'devops', seniority: ['Senior'] },
    essentials: { originalSalary: { currency: 'HUF', disclosedAt: 'VISIBLE', types: { permanent: { period: 'Month', range: [1600000, 2600000] } } } },
    location: { places: [{ city: 'Budapest' }, { city: 'Budapest' }] },
    requirements: { musts: [{ value: 'GCP' }, { value: 'Kubernetes' }], nices: [], languages: [{ type: 'MUST', code: 'en' }],
      description: '<ul><li>5+ years DevOps</li></ul>' },
    specs: { dailyTasks: ['Operate infrastructure'] }, details: { description: '<p>Formlabs builds 3D printers.</p>' },
  };
  const { get, calls } = fakeGet({ [api]: [{ status: 200, text: JSON.stringify(doc) }, { status: 200, text: '<html>' }] });
  const c = { id: 'nfj-senior-devops-engineer-formlabs-budapest', source: 'NoFluff',
    url: 'https://nofluffjobs.com/hu/job/senior-devops-engineer-formlabs-budapest' };
  const r = await fetchAdText(c, { get });
  assert.equal(calls[0].url, api);
  assert.match(r.adText, /Salary \(permanent\): 1600000–2600000 HUF per Month/);
  assert.match(r.adText, /Location: Budapest\n/);
  assert.match(r.adText, /Must have: GCP, Kubernetes\nLanguages: en \(MUST\)/);
  assert.match(r.adText, /- 5\+ years DevOps/);
  assert.match(r.adText, /Daily tasks:\n- Operate infrastructure/);
  assert.deepEqual(await fetchAdText(c, { get }), { adText: null, error: 'parse' });
});

test('Indeed: the JobSpy description is used without a request; HTML in it is stripped', async () => {
  const { get, calls } = fakeGet({});
  const plain = await fetchAdText({ id: 'in-abc', source: 'Indeed', url: 'https://hu.indeed.com/viewjob?jk=abc',
    adText: '**Cloud Engineer**\n\n* Azure  &  AWS\n* salary < 1M?' }, { get });
  assert.equal(plain.adText, '**Cloud Engineer**\n\n* Azure & AWS\n* salary < 1M?');
  const html = await fetchAdText({ id: 'in-def', source: 'Indeed', adText: '<p>Run <b>Azure</b></p><script>x()</script>' }, { get });
  assert.equal(html.adText, 'Run Azure');
  assert.equal(calls.length, 0);
  assert.deepEqual(await fetchAdText({ id: 'in-x', source: 'Indeed', url: 'https://attacker.test/viewjob' }, { get }),
    { adText: null, error: 'bad-url' });
});

test('transport errors, empty pages and unknown sources never throw', async () => {
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  const url = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/7';
  assert.deepEqual(await fetchAdText({ id: 'li-7', source: 'LinkedIn' }, { get: fakeGet({ [url]: timeout }).get }),
    { adText: null, error: 'timeout' });
  assert.deepEqual(await fetchAdText({ id: 'li-7', source: 'LinkedIn' }, { get: fakeGet({ [url]: new Error('ECONNRESET') }).get }),
    { adText: null, error: 'network' });
  assert.deepEqual(await fetchAdText({ id: 'li-7', source: 'LinkedIn' }, { get: fakeGet({ [url]: { status: 200, text: '<div></div>' } }).get }),
    { adText: null, error: 'empty' });
  assert.deepEqual(await fetchAdText({ id: 'x-1', source: 'Monster' }), { adText: null, error: 'unsupported-source' });
  assert.deepEqual(await fetchAdText(null), { adText: null, error: 'unsupported-source' });
});

test('ad text is capped at 12 KiB on a UTF-8 boundary', async () => {
  const long = 'árvíztűrő '.repeat(3000);
  const capped = capText(long);
  assert.ok(Buffer.byteLength(capped) <= AD_TEXT_MAX_BYTES);
  assert.ok(capped.endsWith('…')); assert.doesNotMatch(capped, /�/);
  const r = await fetchAdText({ id: 'in-1', source: 'Indeed', adText: long });
  assert.ok(Buffer.byteLength(r.adText) <= AD_TEXT_MAX_BYTES);
  assert.equal(capText('short'), 'short');
});

test('htmlToText decodes entities and drops non-content elements', () => {
  assert.equal(htmlToText('<style>p{}</style><p>A&nbsp;&amp;&#233;&#x151;</p><!-- c --><p>B</p>'), 'A &éő\n\nB');
});

test('prefetchAll keeps order, paces requests and records failures', async () => {
  const sleeps = [];
  const { get } = fakeGet({ 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/2': { status: 200, text: LI_HTML } });
  const out = await prefetchAll([
    { id: 'li-2', source: 'LinkedIn' },
    { id: 'in-1', source: 'Indeed', adText: 'Plain Indeed description text, long enough to count.' },
    { id: 'li-3', source: 'LinkedIn' },
  ], { get, sleep: ms => sleeps.push(ms), concurrency: 2 });
  assert.deepEqual(out.map(c => c.id), ['li-2', 'in-1', 'li-3']);
  assert.match(out[0].adText, /Azure landing zone/); assert.equal(out[0].adTextError, undefined);
  assert.equal(out[1].adText, 'Plain Indeed description text, long enough to count.');
  assert.equal(out[2].adText, null); assert.equal(out[2].adTextError, 'http-404');
  assert.deepEqual(sleeps, [250, 250]); // no pause after a pre-supplied description
});
