// Ad-text prefetch for NEW candidates (docs/architecture-v2.md step 6).
//
// The judge never browses: it gets the ad as plain text, fetched here by code.
// One request per ad, sessionless, the same endpoints check-liveness.mjs probes:
//   LinkedIn    GET /jobs-guest/jobs/api/jobPosting/<id>  (guest fragment)
//   Profession  GET the ad page, <section aria-labelledby="job-description">
//               plus the JSON-LD JobPosting facts (language/experience levels)
//   NoFluff     GET /api/posting/<slug>  (JSON; the HTML page is an SPA shell)
//   Indeed      the description JobSpy already returned (candidate.adText);
//               only when absent, the ad page on an indeed.com host
// Text is capped at 12 KiB. The judge treats it as untrusted data.
//
// fetchAdText never throws: a failure is { adText: null, error } and the judge
// still sees the candidate (judged on title/company, or left unjudged).

import { httpGet } from '../http.mjs';

export const AD_TEXT_MAX_BYTES = 12 * 1024;
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const MIN_TEXT = 40; // below this a "successful" page carried no ad

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', euro: '€', copy: '©', reg: '®' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML → readable plain text: scripts/styles dropped, block tags become line breaks. */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|head|iframe|object|button)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?(p|div|section|article|ul|ol|li|h[1-6]|tr|table|dl|dt|dd|header|footer|blockquote)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/?[a-z!][^>]*>/gi, ' ');
  s = decodeEntities(s);
  return s.split('\n').map(line => line.replace(/[ \t \r\f\v]+/g, ' ').trim())
    .join('\n').replace(/^-\n+(?=\S)/gm, '- ').replace(/\n(?:- )?\n(?=- )/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Truncate to maxBytes of UTF-8 without splitting a character. */
export function capText(text, maxBytes = AD_TEXT_MAX_BYTES) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const cut = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes - 3));
  return cut.replace(/�+$/, '') + '…';
}

const between = (html, startRe, endMarker) => {
  const start = html.search(startRe);
  if (start < 0) return null;
  const end = html.indexOf(endMarker, start);
  return html.slice(start, end > start ? end : undefined);
};

export function linkedInText(html) {
  const description = between(html, /<div[^>]*class="[^"]*show-more-less-html__markup/, '</section>');
  const criteria = between(html, /<ul[^>]*class="[^"]*description__job-criteria-list/, '</ul>');
  const text = description === null ? htmlToText(html) : htmlToText(description + (criteria ?? ''));
  return text.replace(/^\s*Show (?:more|less)\s*$/gim, '').trim();
}

function jsonLdJobPosting(html) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const doc = JSON.parse(m[1]);
      const nodes = Array.isArray(doc) ? doc : Array.isArray(doc?.['@graph']) ? doc['@graph'] : [doc];
      const posting = nodes.find(n => n?.['@type'] === 'JobPosting');
      if (posting) return posting;
    } catch { /* malformed block: ignore */ }
  }
  return null;
}

export function professionText(html) {
  const posting = jsonLdJobPosting(html);
  const facts = [];
  if (posting) {
    for (const [label, key] of [['Employment', 'employmentType'], ['Experience', 'experienceRequirements'],
      ['Education and language', 'educationRequirements'], ['Posted', 'datePosted']]) {
      if (typeof posting[key] === 'string' && posting[key].trim()) facts.push(`${label}: ${posting[key].trim()}`);
    }
  }
  const section = between(html, /<section[^>]*aria-labelledby="job-description"/, '</section>');
  const body = section !== null ? htmlToText(section)
    : posting && typeof posting.description === 'string' ? htmlToText(posting.description) : '';
  return [facts.join('\n'), body].filter(Boolean).join('\n\n');
}

export function nfjText(doc) {
  const out = [];
  const list = (label, items) => {
    const values = (Array.isArray(items) ? items : []).map(i => typeof i === 'string' ? i : i?.value)
      .filter(v => typeof v === 'string' && v.trim());
    if (values.length) out.push(`${label}: ${values.join(', ')}`);
  };
  if (doc.title) out.push(`Title: ${doc.title}`);
  const seniority = Array.isArray(doc.basics?.seniority) ? doc.basics.seniority.join(', ') : '';
  if (doc.basics?.category || seniority) out.push(`Category: ${doc.basics?.category ?? ''}${seniority ? `; seniority: ${seniority}` : ''}`);
  const salary = doc.essentials?.originalSalary;
  if (salary?.disclosedAt === 'VISIBLE' && salary.types && typeof salary.types === 'object') {
    for (const [type, band] of Object.entries(salary.types)) {
      if (Array.isArray(band?.range)) out.push(`Salary (${type}): ${band.range.join('–')} ${salary.currency ?? ''} per ${band.period ?? '?'}`);
    }
  }
  const cities = (doc.location?.places ?? []).map(p => p?.city).filter(Boolean);
  if (cities.length) out.push(`Location: ${[...new Set(cities)].join(', ')}`);
  list('Must have', doc.requirements?.musts);
  list('Nice to have', doc.requirements?.nices);
  const languages = (doc.requirements?.languages ?? [])
    .map(l => l?.code ? `${l.code}${l.type ? ` (${l.type}${l.level ? ` ${l.level}` : ''})` : ''}` : null).filter(Boolean);
  if (languages.length) out.push(`Languages: ${languages.join(', ')}`);
  if (doc.requirements?.description) out.push(`Requirements:\n${htmlToText(doc.requirements.description)}`);
  if (Array.isArray(doc.specs?.dailyTasks) && doc.specs.dailyTasks.length) {
    out.push(`Daily tasks:\n${doc.specs.dailyTasks.filter(t => typeof t === 'string').map(t => `- ${t}`).join('\n')}`);
  }
  if (doc.details?.description) out.push(`Description:\n${htmlToText(doc.details.description)}`);
  list('Benefits', doc.benefits?.benefits);
  return out.join('\n');
}

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));
const transportError = e => e?.name === 'TimeoutError' ? 'timeout' : 'network';
const looksLikeHtml = s => /<\/?[a-z][^>]*>/i.test(s);

async function fetchLinkedIn(candidate, get, sleep) {
  const num = /^li-(\d+)$/.exec(candidate.id)?.[1] ?? /\/jobs\/view\/(\d+)/.exec(candidate.url ?? '')?.[1];
  if (!num) return { error: 'bad-id' };
  let last = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${num}`, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' }, timeoutMs: 20000,
    });
    last = res.status;
    if (res.status === 200) return { text: linkedInText(res.text) };
    if (res.status === 404 || res.status === 410) break;
    await sleep(3000 * (attempt + 1)); // 429/999 under load, same backoff as check-liveness
  }
  return { error: `http-${last}` };
}

async function fetchProfession(candidate, get) {
  const url = candidate.url ?? '';
  if (!/^https:\/\/www\.profession\.hu\/allas\/[^\s?#]+$/.test(url.split(/[?#]/)[0])) return { error: 'bad-url' };
  const res = await get(url, {
    followRedirects: false, // a redirect is how Profession retires an ad
    headers: { 'User-Agent': 'jobs-dashboard-prefetch/1.0', 'Accept-Language': 'hu-HU' }, timeoutMs: 15000,
  });
  if (res.status !== 200) return { error: `http-${res.status}` };
  return { text: professionText(res.text) };
}

async function fetchNfj(candidate, get) {
  const slug = (candidate.url ?? '').split('/job/')[1]?.split(/[?#]/)[0] || /^nfj-(.+)$/.exec(candidate.id)?.[1];
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { error: 'bad-id' };
  const res = await get(`https://nofluffjobs.com/api/posting/${encodeURIComponent(slug)}`, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, timeoutMs: 20000,
  });
  if (res.status !== 200) return { error: `http-${res.status}` };
  let doc;
  try { doc = JSON.parse(res.text); } catch { return { error: 'parse' }; }
  if (!doc || typeof doc !== 'object') return { error: 'parse' };
  return { text: nfjText(doc) };
}

async function fetchIndeed(candidate, get) {
  let url;
  try { url = new URL(candidate.url ?? ''); } catch { return { error: 'bad-url' }; }
  if (url.protocol !== 'https:' || !/(^|\.)indeed\.com$/.test(url.hostname)) return { error: 'bad-url' };
  const res = await get(url.href, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'hu-HU,en;q=0.8' }, timeoutMs: 20000,
  });
  if (res.status !== 200) return { error: `http-${res.status}` };
  const description = between(res.text, /<div[^>]*id="jobDescriptionText"/, '</div>\n</div>');
  return { text: htmlToText(description ?? res.text) };
}

const FETCHERS = { LinkedIn: fetchLinkedIn, Profession: fetchProfession, NoFluff: fetchNfj, Indeed: fetchIndeed };

/**
 * → { adText: string, error: null } | { adText: null, error: string }. Never throws.
 * A non-empty candidate.adText (JobSpy's Indeed description) is used as-is, no request.
 */
export async function fetchAdText(candidate, { get = httpGet, sleep = sleepFor } = {}) {
  try {
    if (typeof candidate?.adText === 'string' && candidate.adText.trim()) {
      const text = looksLikeHtml(candidate.adText) ? htmlToText(candidate.adText) : htmlToText(
        candidate.adText.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
      return { adText: capText(text), error: null };
    }
    const fetcher = FETCHERS[candidate?.source];
    if (!fetcher) return { adText: null, error: 'unsupported-source' };
    const { text, error } = await fetcher(candidate, get, sleep);
    if (error) return { adText: null, error };
    if (!text || text.length < MIN_TEXT) return { adText: null, error: 'empty' };
    return { adText: capText(text), error: null };
  } catch (e) {
    return { adText: null, error: transportError(e) };
  }
}

/**
 * Prefetch a list politely: a few workers, a pause after every request.
 * → the candidates in input order, each with adText set (null on failure)
 *   and adTextError when it failed.
 */
export async function prefetchAll(candidates, {
  get = httpGet, sleep = sleepFor, concurrency = 4, pauseMs = 250,
} = {}) {
  const out = new Array(candidates.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (next < candidates.length) {
      const i = next++;
      const presupplied = typeof candidates[i]?.adText === 'string' && candidates[i].adText.trim();
      const { adText, error } = await fetchAdText(candidates[i], { get, sleep });
      out[i] = { ...candidates[i], adText, ...(error ? { adTextError: error } : {}) };
      if (!presupplied) await sleep(pauseMs);
    }
  }));
  return out;
}
