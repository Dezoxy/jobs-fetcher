// Cloudflare Access identity check (docs/architecture-v2.md "Access identity").
//
// Access in front of the hostname is still the primary control. This is the
// second one: the Worker verifies the signed Cf-Access-Jwt-Assertion itself,
// then allowlists who may use which route. A request that somehow reached the
// Worker without passing Access (a re-enabled workers.dev, a mis-scoped
// policy) carries no valid token and is refused in `enforce` mode.
//
// No dependencies: RS256 via crypto.subtle, which Workers and Node 20 share.

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const MAX_TOKEN_CHARS = 16 * 1024;
const CLOCK_SKEW_S = 60;

function b64urlToBytes(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const b64urlJson = (s) => JSON.parse(DEC.decode(b64urlToBytes(s)));

// Returns { ok: true, claims } or { ok: false, reason }. Reasons are short
// fixed strings meant for logs; they never contain token or claim content.
//
// getKey(kid) resolves to a CryptoKey or null and may throw when the key set
// cannot be fetched. `now` is in seconds.
export async function verifyAccessJwt(token, { issuer, audience, getKey, now = Date.now() / 1000 }) {
  if (!token) return { ok: false, reason: "missing" };
  if (token.length > MAX_TOKEN_CHARS) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  let header, signature;
  try {
    header = b64urlJson(parts[0]);
    signature = b64urlToBytes(parts[2]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header?.alg !== "RS256") return { ok: false, reason: "alg" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "kid" };

  let key;
  try {
    key = await getKey(header.kid);
  } catch {
    return { ok: false, reason: "jwks_unavailable" };
  }
  if (!key) return { ok: false, reason: "kid" };

  const signed = ENC.encode(parts[0] + "." + parts[1]);
  let valid = false;
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature" };

  let claims;
  try {
    claims = b64urlJson(parts[1]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.iss !== issuer) return { ok: false, reason: "iss" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience || !aud.includes(audience)) return { ok: false, reason: "aud" };
  if (typeof claims.exp !== "number" || now > claims.exp + CLOCK_SKEW_S) return { ok: false, reason: "exp" };
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || now + CLOCK_SKEW_S < claims.nbf)) {
    return { ok: false, reason: "nbf" };
  }
  return { ok: true, claims };
}

// JWKS cache for https://<team>/cdn-cgi/access/certs. Lives in module scope
// (one per isolate).
//  - An unknown kid triggers a refetch (that is how Access key rotation is
//    picked up), at most once per `minRefreshMs` once a key set has loaded,
//    so a stream of bogus kids cannot turn into a fetch per request.
//  - The set expires after `ttlMs` (1 h), so a key Access has withdrawn stops
//    being trusted even if no unknown kid ever shows up.
//  - Until the first successful load every miss refetches, so concurrent
//    requests on a cold isolate are never refused for lack of keys.
//  - Stale-on-error: if a refresh of an expired set fails, the previous set
//    stays in use and the refresh is retried at most every `minRefreshMs`;
//    a blip on the certs endpoint must not 403 the owner.
export function makeKeyStore(certsUrl, {
  fetchFn = (...a) => fetch(...a),
  minRefreshMs = 30_000,
  ttlMs = 60 * 60 * 1000,
  clock = () => Date.now(),
} = {}) {
  let keys = new Map();
  let loaded = false;
  let loadedAt = -Infinity;
  let lastFetch = -Infinity;

  async function refresh() {
    lastFetch = clock();
    const r = await fetchFn(certsUrl);
    if (!r.ok) throw new Error("certs HTTP " + r.status);
    const doc = await r.json();
    const next = new Map();
    for (const jwk of Array.isArray(doc?.keys) ? doc.keys : []) {
      if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
      next.set(jwk.kid, await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ));
    }
    keys = next;
    loaded = true;
    loadedAt = clock();
  }

  return async function getKey(kid) {
    const now = clock();
    const fresh = loaded && now - loadedAt < ttlMs;
    if (fresh && keys.has(kid)) return keys.get(kid);
    if (!loaded || now - lastFetch >= minRefreshMs) {
      try {
        await refresh();
      } catch (e) {
        if (!loaded) throw e; // nothing to fall back to
      }
    }
    return keys.get(kid) ?? null;
  };
}

// E-mail comparison is ASCII-only on purpose: no Unicode case folding (which
// can map distinct addresses onto each other), and anything outside printable
// ASCII is not an allowlistable address at all.
export function asciiEmail(value) {
  if (typeof value !== "string" || !/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(value)) return null;
  return value.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function parseList(value) {
  const out = new Set();
  for (const part of String(value ?? "").split(",")) {
    const e = asciiEmail(part.replace(/^[ \t]+|[ \t]+$/g, ""));
    if (e) out.add(e);
  }
  return out;
}

// The runner (Access service token) may only read: the snapshot files and
// the tracker. Everything else — including PUT /api/tracker — is owner-only.
export function runnerMayAccess(method, pathname) {
  return method === "GET" && (pathname.startsWith("/data/") || pathname === "/api/tracker");
}

// claims → { ok, principal, reason? }. principal is a category for logs
// ("owner" | "runner" | "user" | "service" | "unknown"), never an identity.
export function authorize(claims, { method, pathname, ownerEmails, runnerClientId }) {
  const email = asciiEmail(claims.email);
  if (email && ownerEmails.has(email)) return { ok: true, principal: "owner" };

  const cn = typeof claims.common_name === "string" ? claims.common_name : "";
  if (cn && runnerClientId && cn === runnerClientId) {
    return runnerMayAccess(method, pathname)
      ? { ok: true, principal: "runner" }
      : { ok: false, principal: "runner", reason: "runner_route" };
  }
  return { ok: false, principal: claims.email ? "user" : cn ? "service" : "unknown", reason: "not_allowlisted" };
}

// Full gate for one request: verify, authorise, log a failure as ONE
// structured line (no token, no e-mail, no claim values), and decide.
// ACCESS_ENFORCE must be exactly "log" to let a failure through; any other
// value, including unset, enforces (fail closed on a typo).
export async function checkAccess(request, env, getKey, now) {
  const { pathname } = new URL(request.url);
  const enforce = env.ACCESS_ENFORCE !== "log";
  let reason;
  let principal = "unknown";

  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) {
    reason = "config";
  } else {
    const v = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), {
      issuer: `https://${env.ACCESS_TEAM}`,
      audience: env.ACCESS_AUD,
      getKey,
      now,
    });
    if (v.ok) {
      const a = authorize(v.claims, {
        method: request.method,
        pathname,
        ownerEmails: parseList(env.OWNER_EMAILS),
        runnerClientId: env.RUNNER_CLIENT_ID ? String(env.RUNNER_CLIENT_ID).trim() : "",
      });
      if (a.ok) return { allowed: true, principal: a.principal };
      reason = a.reason;
      principal = a.principal;
    } else {
      reason = v.reason;
    }
  }

  console.log(JSON.stringify({
    event: "access_denied",
    mode: enforce ? "enforce" : "log",
    reason,
    principal,
    method: request.method,
    path: pathname,
  }));
  return { allowed: !enforce, principal: null };
}
