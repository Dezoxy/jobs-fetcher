// Cloudflare REST client for the v2 runner: D1 `/query` (single and atomic
// batch) and one KV write. Contract: docs/architecture-v2.md.
//
// Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, JOBS_D1_ID, TRACKER_D1_ID,
// SNAPSHOT_KV_ID. The token only ever goes into the Authorization header: no
// error message, log line or exception built here contains it or the request.
//
// Retries: only on 429 and 5xx, with exponential backoff (Retry-After wins when
// present). A network error is NOT retried — for a write it is ambiguous, and
// the caller (run.mjs) resolves ambiguity by re-reading `runs`, not by guessing.
// A batch that is retried after a 5xx that actually committed fails on the
// `runs` primary key and rolls back, so a retry can never apply a run twice.

export const D1_MAX_PARAMS = 100;          // per statement, D1 limit
export const D1_MAX_SQL_BYTES = 100_000;   // per statement, D1 limit
const API = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(message, { status = null, codes = [] } = {}) {
    super(message);
    this.name = 'CloudflareError';
    this.status = status;
    this.codes = codes;
  }
}

// Validates one statement against the D1 limits before anything is sent.
export function checkStatement({ sql, params = [] }) {
  if (typeof sql !== 'string' || !sql.trim()) throw new CloudflareError('Empty SQL statement');
  if (!Array.isArray(params)) throw new CloudflareError('params must be an array');
  if (params.length > D1_MAX_PARAMS) {
    throw new CloudflareError(`Statement binds ${params.length} parameters (D1 limit ${D1_MAX_PARAMS}); pass id lists as one JSON param and expand with json_each(?)`);
  }
  if (Buffer.byteLength(sql) > D1_MAX_SQL_BYTES) throw new CloudflareError('SQL statement exceeds 100 KB');
  for (const p of params) {
    if (!(p === null || ['string', 'number', 'boolean'].includes(typeof p))) {
      throw new CloudflareError('Only null, string, number and boolean parameters are supported');
    }
  }
  return { sql, params };
}

// Error text from the API body: codes and messages only, bounded, never the request.
function apiErrors(body) {
  const list = Array.isArray(body?.errors) ? body.errors : [];
  return {
    codes: list.map(e => e?.code).filter(c => c !== undefined),
    text: list.map(e => `${e?.code ?? '?'}: ${String(e?.message ?? '').slice(0, 300)}`).join('; ').slice(0, 1000),
  };
}

export function configFromEnv(env = process.env) {
  const need = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'JOBS_D1_ID', 'TRACKER_D1_ID'];
  const missing = need.filter(k => !env[k]);
  if (missing.length) throw new CloudflareError(`Missing Cloudflare configuration: ${missing.join(', ')}`);
  for (const k of ['CLOUDFLARE_ACCOUNT_ID', 'JOBS_D1_ID', 'TRACKER_D1_ID', 'SNAPSHOT_KV_ID']) {
    if (env[k] && !/^[A-Za-z0-9-]{8,64}$/.test(env[k])) throw new CloudflareError(`Malformed ${k}`);
  }
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN,
    databases: { jobs: env.JOBS_D1_ID, tracker: env.TRACKER_D1_ID },
    kvNamespace: env.SNAPSHOT_KV_ID ?? null,
  };
}

export function createCloudflare(config, {
  fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  attempts = 5,
  baseDelayMs = 1000,
  timeoutMs = 60_000,
} = {}) {
  const { accountId, token, databases, kvNamespace } = config;

  async function request(method, url, body, contentType) {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // The URL carries ids, not secrets, but the cause text is not ours to
        // vouch for; report the class only.
        const kind = String(error?.cause?.code ?? error?.name ?? 'error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
        throw new CloudflareError(`Cloudflare request failed before a response (${kind})`);
      }
      let parsed = null;
      try { parsed = await response.json(); } catch { /* non-JSON body */ }
      const retryable = response.status === 429 || response.status >= 500;
      if (response.ok && parsed?.success !== false) return parsed;
      if (!retryable || attempt >= attempts) {
        const { codes, text } = apiErrors(parsed);
        throw new CloudflareError(`Cloudflare API ${response.status}${text ? ` — ${text}` : ''}`,
          { status: response.status, codes });
      }
      const after = Number(response.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : baseDelayMs * 2 ** (attempt - 1));
    }
  }

  function dbUrl(db) {
    const id = databases[db];
    if (!id) throw new CloudflareError(`Unknown database "${db}"`);
    return `${API}/accounts/${accountId}/d1/database/${id}/query`;
  }

  return {
    /** One statement -> its result rows. */
    async query(db, sql, params = []) {
      checkStatement({ sql, params });
      const body = await request('POST', dbUrl(db), JSON.stringify({ sql, params }), 'application/json');
      const first = Array.isArray(body?.result) ? body.result[0] : null;
      if (!first || first.success === false) throw new CloudflareError('D1 query returned no result');
      return first.results ?? [];
    },
    /** Several statements in one atomic request -> one result-row array per statement. */
    async batch(db, statements) {
      if (!Array.isArray(statements) || statements.length === 0) throw new CloudflareError('Empty batch');
      const batch = statements.map(s => checkStatement({ sql: s.sql, params: s.params ?? [] }));
      const body = await request('POST', dbUrl(db), JSON.stringify({ batch }), 'application/json');
      const results = Array.isArray(body?.result) ? body.result : [];
      if (results.length !== batch.length || results.some(r => r?.success === false)) {
        throw new CloudflareError('D1 batch returned an incomplete result');
      }
      return results.map(r => r.results ?? []);
    },
    async kvPut(key, value) {
      if (!kvNamespace) throw new CloudflareError('SNAPSHOT_KV_ID is not configured');
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) throw new CloudflareError('Invalid KV key');
      const url = `${API}/accounts/${accountId}/storage/kv/namespaces/${kvNamespace}/values/${encodeURIComponent(key)}`;
      await request('PUT', url, value, 'text/plain;charset=UTF-8');
    },
  };
}
