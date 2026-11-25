// Keep-alive-free HTTPS GET, shared by every script that talks to a job board.
//
// WHY THIS EXISTS, AND WHY IT IS NOT fetch()
// ------------------------------------------
// Probed 2026-09-06, after the 19:00 refresh collected nothing and exited 3.
//
// Profession's frontend is broken on HTTP keep-alive reuse. On a single
// connection: request 1 answers 200, request 2 answers a bogus 500 in ~25 ms,
// and every request after that fails in ~30 ms with undici's
// `UND_ERR_SOCKET: other side closed`. The server is gone but the socket stays
// in undici's pool, so once an origin's pool is poisoned it never recovers
// inside a run.
//
// Concurrency hid this for two days. N parallel requests each open their own
// fresh socket and all succeed; it is every worker's *second* request onward
// that dies. So the run still collected the first ~10 responses and looked
// merely thin rather than broken: scripts/fetch-sources.mjs reported 46 of 48
// keyword+category groups failed but still exited 0, and the liveness sweep
// left 75 Profession rows undecided. public/data/last-run.json carried both
// as warnings from the 2026-09-04 19:19 run onward — eight consecutive runs —
// while jobs.json sat frozen at 955 rows. The 2026-09-06 19:00 run was simply
// the first where Profession AND NFJ came back empty together, which is the
// one combination `npm run fetch` treats as fatal.
//
// Retrying does not help: the retry draws the same dead socket (measured at
// 0.5 s, 1 s and 2 s gaps — 14 of 15 still failed). Idling past undici's 4 s
// keepAliveTimeout does work, because the socket is then discarded rather than
// reused, but at ~5 s per request a refresh would take minutes for nothing.
// Never reusing a connection is the actual fix: 20/20 green in 2.0 s against
// the exact pool pattern that had been failing 46/48.
//
// undici's global dispatcher is what pools the connection, and Node exposes no
// supported way to reconfigure it without taking `undici` on as a real
// dependency — a trade this container has already refused. See "2. install
// dependencies" in scripts/refresh-run.sh: it runs `npm ci --omit=dev`
// precisely so that no run has the npm registry on its critical path. Handling
// gzip and redirects by hand below is the price of keeping that property.

import https from "node:https";
import zlib from "node:zlib";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

// keepAlive:false is the whole point of this module — one socket per request,
// never pooled, never reused.
const agent = new https.Agent({ keepAlive: false });

// Resolves to { status, headers, text } for any response, including 4xx/5xx —
// HTTP status is data here, not an error. Rejects only on transport failure
// (DNS, TLS, reset, timeout), where the Error carries a real .code such as
// ECONNRESET, unlike fetch()'s opaque "fetch failed".
export function httpGet(url, {
  headers = {},
  timeoutMs = 20000,
  followRedirects = true,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  _redirects = 0,
} = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent,
      headers: {
        // fetch() sent this for us. Without it Profession returns ~460 KB of
        // uncompressed HTML per listing page instead of ~80 KB, and one
        // refresh fetches up to 480 of them.
        "Accept-Encoding": "gzip",
        ...headers,
      },
    }, (res) => {
      const status = res.statusCode;
      if (followRedirects && REDIRECT_CODES.has(status)
          && res.headers.location && _redirects < maxRedirects) {
        res.resume(); // drain, or the socket is never freed
        resolve(httpGet(new URL(res.headers.location, url).href, {
          headers, timeoutMs, followRedirects, maxRedirects, _redirects: _redirects + 1,
        }));
        return;
      }
      const body = res.headers["content-encoding"] === "gzip"
        ? res.pipe(zlib.createGunzip())
        : res;
      const chunks = [];
      body.on("data", (c) => chunks.push(c));
      body.on("end", () => resolve({
        status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8"),
      }));
      body.on("error", reject);
    });
    // https.get's own `timeout` option only fires on socket inactivity, so it
    // cannot bound a slow trickle. This bounds the whole request, which is what
    // AbortSignal.timeout(ms) used to do.
    // Named TimeoutError because scripts/check-liveness.mjs distinguishes a
    // timeout from a connection failure by e.name when it records why a row
    // could not be decided — AbortSignal.timeout() used to supply that name.
    const timer = setTimeout(() => {
      const e = new Error(`timeout after ${timeoutMs}ms for ${url}`);
      e.name = "TimeoutError";
      req.destroy(e);
    }, timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
  });
}
