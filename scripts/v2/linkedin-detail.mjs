// LinkedIn guest detail for e-mail alert candidates (architecture-v2.md step 3:
// "email candidate ids -> LinkedIn guest detail"). An alert e-mail only carries
// the job id; the guest fragment check-liveness.mjs already probes carries the
// title, company, location and ad text with no session.
//
//   GET https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<n>
//
// -> { state: 'ok', role, company, location, adText }
//  | { state: 'gone', why }        404/410 or "No longer accepting applications"
//  | { state: 'unknown', why }     throttle, network, unparseable: retry next run

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const CLOSED = /No longer accepting applications|Nem fogad(unk)? több jelentkez/i;

const clean = (s) => String(s ?? '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const pick = (html, re) => { const m = html.match(re); return m ? clean(m[1]).replace(/\s+/g, ' ') : ''; };

export function parseDetail(html) {
  const role = pick(html, /class="[^"]*top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\/h[12]>/);
  const company = pick(html, /class="[^"]*topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/) ||
    pick(html, /class="[^"]*topcard__flavor[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  const location = pick(html, /class="[^"]*topcard__flavor--bullet[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  const body = html.match(/class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  return { role, company, location, adText: body ? clean(body[1]).slice(0, 20000) : '' };
}

export async function fetchLinkedInDetail(id, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const num = String(id).replace(/^li-/, '');
  if (!/^\d+$/.test(num)) return { state: 'gone', why: 'malformed-id' };
  let res;
  try {
    res = await fetchImpl(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${num}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { state: 'unknown', why: e?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
  if (res.status === 404 || res.status === 410) return { state: 'gone', why: `http-${res.status}` };
  if (res.status !== 200) return { state: 'unknown', why: `http-${res.status}` };
  const html = await res.text();
  if (CLOSED.test(html)) return { state: 'gone', why: 'no-longer-accepting' };
  const detail = parseDetail(html);
  if (!detail.role) return { state: 'unknown', why: 'unparseable' };
  return { state: 'ok', ...detail };
}
