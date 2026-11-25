// Offline tests for the v2 Worker: JWT checks with a locally generated RSA
// key, route authorisation, tracker sanitize/SQL wiring, e-mail parsing, and
// the fetch/email handlers against in-memory fakes. No network: the JWKS
// fetch is stubbed on globalThis.fetch.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { asciiEmail, authorize, checkAccess, makeKeyStore, parseList, verifyAccessJwt } from "./access.js";
import { readCapped } from "./body.js";
import { INSERT_FROM_JSON_SQL, DELETE_ALL_SQL, READY_SQL, SELECT_DOC_SQL, sanitize } from "./tracker.js";
import {
  INSERT_CANDIDATES_SQL, MAX_IDS_PER_EMAIL, decodeForLinks, extractLinkedInJobIds, fromDomain,
  hasLinkedInDmarcPass, parseCloudflareAuthResults,
} from "./email.js";
import worker from "./worker.js";

const TEAM = "team.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const AUD = "aud-tag-123";
const OWNER = "Owner@Example.com";
const RUNNER = "runner-id.access";
const NOW = 1_800_000_000;

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const b64urlJson = (obj) => b64url(Buffer.from(JSON.stringify(obj)));

async function newKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, publicKey: pair.publicKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

async function sign(key, claims, header = {}) {
  const h = b64urlJson({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const p = b64urlJson(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, Buffer.from(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

const claimsFor = (extra = {}) => ({ iss: ISS, aud: [AUD], iat: NOW - 10, exp: NOW + 600, nbf: NOW - 10, type: "app", ...extra });

let K1, K2;
before(async () => {
  K1 = await newKey("kid-1");
  K2 = await newKey("kid-2");
});

describe("verifyAccessJwt", () => {
  const opts = (getKey, now = NOW) => ({ issuer: ISS, audience: AUD, getKey, now });
  const keyOf = (k) => async (kid) => (kid === k.kid ? k.publicKey : null);

  test("accepts a valid token and returns its claims", async () => {
    const t = await sign(K1, claimsFor({ email: "x@y.z" }));
    const r = await verifyAccessJwt(t, opts(keyOf(K1)));
    assert.equal(r.ok, true);
    assert.equal(r.claims.email, "x@y.z");
  });

  test("accepts aud as a plain string", async () => {
    const t = await sign(K1, claimsFor({ aud: AUD }));
    assert.equal((await verifyAccessJwt(t, opts(keyOf(K1)))).ok, true);
  });

  const cases = [
    ["iss", { iss: "https://evil.cloudflareaccess.com" }],
    ["aud", { aud: ["other-app"] }],
    ["exp", { exp: NOW - 61 }],
    ["exp", { exp: undefined }],
    ["nbf", { nbf: NOW + 61 }],
  ];
  for (const [reason, extra] of cases) {
    test(`rejects ${reason}: ${JSON.stringify(extra)}`, async () => {
      const t = await sign(K1, claimsFor(extra));
      assert.deepEqual(await verifyAccessJwt(t, opts(keyOf(K1))), { ok: false, reason });
    });
  }

  test("tolerates up to 60 s of clock skew on exp and nbf", async () => {
    const t = await sign(K1, claimsFor({ exp: NOW - 59, nbf: NOW + 59 }));
    assert.equal((await verifyAccessJwt(t, opts(keyOf(K1)))).ok, true);
  });

  test("rejects a signature made by another key under the same kid", async () => {
    const forged = await sign({ ...K2, kid: K1.kid }, claimsFor());
    assert.deepEqual(await verifyAccessJwt(forged, opts(keyOf(K1))), { ok: false, reason: "signature" });
  });

  test("rejects a tampered payload", async () => {
    const t = await sign(K1, claimsFor({ email: "a@b.c" }));
    const [h, , s] = t.split(".");
    const tampered = `${h}.${b64urlJson(claimsFor({ email: OWNER }))}.${s}`;
    assert.equal((await verifyAccessJwt(tampered, opts(keyOf(K1)))).reason, "signature");
  });

  test("rejects alg none / HS256 before looking up a key", async () => {
    let looked = false;
    const getKey = async () => { looked = true; return K1.publicKey; };
    for (const alg of ["none", "HS256"]) {
      const t = await sign(K1, claimsFor(), { alg });
      assert.equal((await verifyAccessJwt(t, opts(getKey))).reason, "alg");
    }
    assert.equal(looked, false);
  });

  test("unknown kid, missing, malformed and JWKS failure", async () => {
    const t = await sign(K2, claimsFor());
    assert.equal((await verifyAccessJwt(t, opts(keyOf(K1)))).reason, "kid");
    assert.equal((await verifyAccessJwt(null, opts(keyOf(K1)))).reason, "missing");
    assert.equal((await verifyAccessJwt("a.b", opts(keyOf(K1)))).reason, "malformed");
    assert.equal((await verifyAccessJwt("!!.??.**", opts(keyOf(K1)))).reason, "malformed");
    const boom = async () => { throw new Error("down"); };
    assert.equal((await verifyAccessJwt(t, opts(boom))).reason, "jwks_unavailable");
  });
});

describe("makeKeyStore", () => {
  const certsResponse = (...keys) => new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), { status: 200 });

  test("fetches on a miss, caches, and refetches for a rotated kid after the rate limit", async () => {
    let calls = 0;
    let served = [K1];
    let clock = 0;
    const getKey = makeKeyStore("https://x/certs", {
      fetchFn: async () => { calls++; return certsResponse(...served); },
      minRefreshMs: 30_000,
      clock: () => clock,
    });
    assert.ok(await getKey("kid-1"));
    assert.ok(await getKey("kid-1"));
    assert.equal(calls, 1);

    served = [K1, K2];
    clock = 10_000; // inside the rate-limit window: no refetch for an unknown kid
    assert.equal(await getKey("kid-2"), null);
    assert.equal(calls, 1);

    clock = 40_000;
    assert.ok(await getKey("kid-2"));
    assert.equal(calls, 2);
  });

  test("keeps retrying until the first successful load (cold isolate)", async () => {
    let calls = 0;
    const getKey = makeKeyStore("https://x/certs", {
      fetchFn: async () => { calls++; return calls === 1 ? new Response("", { status: 502 }) : certsResponse(K1); },
      clock: () => 0,
    });
    await assert.rejects(getKey("kid-1"));
    assert.ok(await getKey("kid-1"));
    assert.equal(calls, 2);
  });

  test("expires the set after the TTL (1 h) and drops withdrawn keys", async () => {
    let calls = 0;
    let served = [K1, K2];
    let clock = 0;
    const getKey = makeKeyStore("https://x/certs", {
      fetchFn: async () => { calls++; return certsResponse(...served); },
      clock: () => clock,
    });
    assert.ok(await getKey("kid-2"));
    served = [K1]; // Access withdrew kid-2
    clock = 59 * 60 * 1000;
    assert.ok(await getKey("kid-2"), "still cached inside the TTL");
    assert.equal(calls, 1);
    clock = 61 * 60 * 1000;
    assert.equal(await getKey("kid-2"), null, "gone after the TTL refresh");
    assert.ok(await getKey("kid-1"));
    assert.equal(calls, 2);
  });

  test("stale-on-error: a failed TTL refresh keeps the previous set, retried every 30 s", async () => {
    let calls = 0;
    let up = true;
    let clock = 0;
    const getKey = makeKeyStore("https://x/certs", {
      fetchFn: async () => { calls++; return up ? certsResponse(K1) : new Response("", { status: 503 }); },
      clock: () => clock,
    });
    assert.ok(await getKey("kid-1"));
    up = false;
    clock = 2 * 60 * 60 * 1000;
    assert.ok(await getKey("kid-1"));
    assert.equal(calls, 2);
    clock += 1000;
    assert.ok(await getKey("kid-1"));
    assert.equal(calls, 2, "rate-limited retry");
    up = true;
    clock += 30_000;
    assert.ok(await getKey("kid-1"));
    assert.equal(calls, 3);
  });
});

describe("authorize", () => {
  const ctx = (method, pathname) => ({ method, pathname, ownerEmails: parseList(` ${OWNER} , second@example.com`), runnerClientId: RUNNER });

  test("owner e-mail (case-insensitive) may use every route", () => {
    assert.equal(authorize({ email: "owner@example.COM" }, ctx("PUT", "/api/tracker")).ok, true);
    assert.equal(authorize({ email: "second@example.com" }, ctx("GET", "/data/jobs.json")).ok, true);
  });

  test("runner may only GET /data/* and /api/tracker", () => {
    const runner = { common_name: RUNNER, sub: "" };
    assert.equal(authorize(runner, ctx("GET", "/data/jobs.json")).ok, true);
    assert.equal(authorize(runner, ctx("GET", "/data/last-run.json")).ok, true);
    assert.equal(authorize(runner, ctx("GET", "/api/tracker")).ok, true);
    assert.deepEqual(authorize(runner, ctx("PUT", "/api/tracker")), { ok: false, principal: "runner", reason: "runner_route" });
    assert.equal(authorize(runner, ctx("GET", "/api/other")).ok, false);
  });

  test("anyone else is refused", () => {
    assert.equal(authorize({ email: "stranger@example.com" }, ctx("GET", "/data/jobs.json")).ok, false);
    assert.equal(authorize({ common_name: "other.access" }, ctx("GET", "/data/jobs.json")).ok, false);
    assert.equal(authorize({}, ctx("GET", "/data/jobs.json")).ok, false);
  });

  test("owner e-mails compare ASCII-only: no Unicode folding, non-ASCII never matches", () => {
    assert.equal(asciiEmail("Kate@Example.COM"), "kate@example.com");
    assert.equal(asciiEmail("ownér@example.com"), null);
    assert.equal(asciiEmail("a b@example.com"), null);
    const kelvin = "Kate@example.com"; // KELVIN SIGN: toLowerCase() gives "kate@..."
    assert.equal(kelvin.toLowerCase(), "kate@example.com");
    const c = { method: "GET", pathname: "/data/jobs.json", ownerEmails: parseList("kate@example.com"), runnerClientId: "" };
    assert.equal(authorize({ email: kelvin }, c).ok, false);
    assert.equal(authorize({ email: "KATE@example.com" }, c).ok, true);
    assert.deepEqual([...parseList("kate@example.com, ünï@example.com,,")], ["kate@example.com"]);
  });

  test("an unset RUNNER_CLIENT_ID never matches an empty common_name", () => {
    const c = { ...ctx("GET", "/data/jobs.json"), runnerClientId: "" };
    assert.equal(authorize({ common_name: "" }, c).ok, false);
  });
});

// Capture console.log lines for the duration of fn.
async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try { return { result: await fn(), lines }; } finally { console.log = orig; }
}

describe("checkAccess", () => {
  const env = (mode) => ({ ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ACCESS_ENFORCE: mode, OWNER_EMAILS: OWNER, RUNNER_CLIENT_ID: RUNNER });
  const getKey = async (kid) => (kid === K1.kid ? K1.publicKey : null);
  const req = (token, method = "GET", path = "/api/tracker") =>
    new Request(`https://jobs.toomhorvath.com${path}`, { method, headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });

  test("log mode lets a failure through with ONE structured line, no token or e-mail", async () => {
    const token = await sign(K1, claimsFor({ email: "stranger@example.com" }));
    const { result, lines } = await captureLogs(() => checkAccess(req(token), env("log"), getKey, NOW));
    assert.equal(result.allowed, true);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.deepEqual(entry, { event: "access_denied", mode: "log", reason: "not_allowlisted", principal: "user", method: "GET", path: "/api/tracker" });
    assert.ok(!lines[0].includes("stranger") && !lines[0].includes(token.slice(0, 20)));
  });

  test("enforce mode refuses; unknown mode values enforce too", async () => {
    for (const mode of ["enforce", undefined, "LOG", "off"]) {
      const { result } = await captureLogs(() => checkAccess(req(null), env(mode), getKey, NOW));
      assert.equal(result.allowed, false, `mode ${mode}`);
    }
  });

  test("a valid owner passes silently", async () => {
    const token = await sign(K1, claimsFor({ email: OWNER.toLowerCase() }));
    const { result, lines } = await captureLogs(() => checkAccess(req(token, "PUT"), env("enforce"), getKey, NOW));
    assert.deepEqual(result, { allowed: true, principal: "owner" });
    assert.equal(lines.length, 0);
  });

  test("missing ACCESS_AUD is a config failure, not a pass", async () => {
    const token = await sign(K1, claimsFor({ email: OWNER }));
    const { result, lines } = await captureLogs(() => checkAccess(req(token), { ...env("enforce"), ACCESS_AUD: "" }, getKey, NOW));
    assert.equal(result.allowed, false);
    assert.equal(JSON.parse(lines[0]).reason, "config");
  });
});

describe("tracker sanitize (v1 contract)", () => {
  test("accepts the v1 shape and drops extra fields", () => {
    assert.deepEqual(
      { ...sanitize({ "li-1": { st: "saved", at: "2026-08-07", extra: 1 } }) },
      { "li-1": { st: "saved", at: "2026-08-07" } },
    );
    assert.deepEqual({ ...sanitize({}) }, {});
  });
  test("keeps a __proto__ id as a plain key (null-prototype result)", () => {
    const clean = sanitize(JSON.parse('{"__proto__":{"st":"saved","at":"x"},"li-1":{"st":"applied","at":"y"}}'));
    assert.deepEqual(Object.keys(clean).sort(), ["__proto__", "li-1"]);
    assert.equal(Object.getPrototypeOf(clean), null);
    assert.equal(JSON.parse(JSON.stringify(clean)).__proto__.st, "saved");
  });
  test("refuses anything malformed as a whole", () => {
    for (const bad of [null, [], "x", 1, { a: null }, { a: [] }, { a: { st: "nope", at: "x" } },
      { a: { st: "saved", at: 1 } }, { a: { st: "saved", at: "x".repeat(41) } }, { ["x".repeat(201)]: { st: "saved", at: "x" } }]) {
      assert.equal(sanitize(bad), null, JSON.stringify(bad)?.slice(0, 60));
    }
  });
});

describe("e-mail parsing", () => {
  test("fromDomain takes the bracketed address only", () => {
    assert.equal(fromDomain("LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>"), "linkedin.com");
    assert.equal(fromDomain("jobalerts-noreply@LinkedIn.com"), "linkedin.com");
    assert.equal(fromDomain('"jobs@linkedin.com" <evil@evil.example>'), "evil.example");
    assert.equal(fromDomain("<a@linkedin.com>, <b@evil.example>"), null);
    assert.equal(fromDomain("a@linkedin.com, b@evil.example"), null);
    assert.equal(fromDomain("jobs@e.linkedin.com"), "e.linkedin.com");
    assert.equal(fromDomain("jobs@linKedin.com"), null, "no Unicode folding (Kelvin sign)");
    assert.equal(fromDomain(null), null);
  });

  const CF = "mx.cloudflare.net; dkim=pass header.d=linkedin.com header.s=d2048-202211-73 header.b=abc; dmarc=pass header.from=linkedin.com policy.dmarc=reject; spf=pass (mx.cloudflare.net: domain of s-x@bounce.linkedin.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=s-x@bounce.linkedin.com";
  const verified = (s) => {
    const r = parseCloudflareAuthResults(s);
    return r.ok && hasLinkedInDmarcPass(r.results);
  };

  test("reads Cloudflare's prepended Authentication-Results", () => {
    const r = parseCloudflareAuthResults(CF);
    assert.equal(r.ok, true);
    assert.deepEqual(r.results.map((x) => `${x.method}=${x.result}`), ["dkim=pass", "dmarc=pass", "spf=pass"]);
    assert.equal(r.results[1].props["header.from"], "linkedin.com");
    assert.equal(verified(CF), true);
  });

  test("trusts only a FIRST header whose authserv-id is exactly mx.cloudflare.net", () => {
    assert.deepEqual(parseCloudflareAuthResults("spoof.example; dmarc=pass"), { ok: false, reason: "not_cloudflare" });
    assert.deepEqual(parseCloudflareAuthResults("mx.cloudflare.net.evil.example; dmarc=pass"), { ok: false, reason: "not_cloudflare" });
    assert.deepEqual(parseCloudflareAuthResults("mx.cloudflare.net 1; dmarc=pass"), { ok: false, reason: "not_cloudflare" });
    assert.deepEqual(parseCloudflareAuthResults(""), { ok: false, reason: "missing" });
    assert.deepEqual(parseCloudflareAuthResults(null), { ok: false, reason: "missing" });
    // A forged pass joined after Cloudflare's header (", ") is never read.
    assert.equal(verified("mx.cloudflare.net; dmarc=fail header.from=linkedin.com, mx.cloudflare.net; dmarc=pass header.from=linkedin.com"), false);
    // Nor is a Cloudflare-looking header that is not first.
    assert.equal(verified("spoof.example; dmarc=fail, mx.cloudflare.net; dmarc=pass header.from=linkedin.com"), false);
  });

  test("refuses the header outright on quotes, backslashes or unbalanced parentheses", () => {
    for (const bad of [
      'mx.cloudflare.net; spf=fail smtp.mailfrom="x;dmarc=pass"@evil.example; dmarc=fail',
      "mx.cloudflare.net; spf=fail smtp.mailfrom=x\\;dmarc=pass@evil.example; dmarc=pass",
      "mx.cloudflare.net; spf=none (comment; dmarc=pass; dmarc=pass",
      "mx.cloudflare.net; spf=none comment) dmarc=pass; dmarc=pass",
      "mx.cloudflare.net; spf=none (a, b) dmarc=pass; dmarc=pass", // comma inside a comment cuts it unbalanced
    ]) {
      assert.deepEqual(parseCloudflareAuthResults(bad), { ok: false, reason: "unsafe" }, bad);
    }
  });

  test("a ';' or '=' inside a comment refuses the header (comment-injection mutant stays unverified)", () => {
    // The resinfo split runs before comment removal, so without this rule the
    // comment below would yield a forged "dmarc=pass header.from=linkedin.com".
    const mutant = "mx.cloudflare.net; spf=fail (x; dmarc=pass header.from=linkedin.com) smtp.mailfrom=a@evil.example; dmarc=fail header.from=evil.example";
    assert.deepEqual(parseCloudflareAuthResults(mutant), { ok: false, reason: "unsafe" });
    assert.equal(verified(mutant), false);
    assert.equal(verified("mx.cloudflare.net; spf=none (x; dmarc=pass header.from=linkedin.com)"), false);
    assert.deepEqual(parseCloudflareAuthResults("mx.cloudflare.net; spf=pass (a=b) smtp.mailfrom=x@linkedin.com; dmarc=pass header.from=linkedin.com"),
      { ok: false, reason: "unsafe" });
    assert.deepEqual(parseCloudflareAuthResults("mx.cloudflare.net; spf=pass (nested (x;y)) ; dmarc=pass header.from=linkedin.com"),
      { ok: false, reason: "unsafe" });
    // A plain-text comment, as Cloudflare writes it, is still fine.
    assert.equal(verified(CF), true);
  });

  test("the deciding check is DMARC pass for linkedin.com, not a bare DKIM pass", () => {
    assert.equal(verified("mx.cloudflare.net; dkim=pass header.d=linkedin.com; dmarc=fail header.from=linkedin.com"), false);
    assert.equal(verified("mx.cloudflare.net; dkim=pass header.d=linkedin.com; spf=pass"), false, "no dmarc result at all");
    assert.equal(verified("mx.cloudflare.net; dkim=fail; dmarc=pass header.from=linkedin.com"), true);
    assert.equal(verified("mx.cloudflare.net; dmarc=pass"), false, "header.from must be present");
    assert.equal(verified("mx.cloudflare.net; dmarc=pass policy.dmarc=reject"), false, "header.from must be present");
    assert.equal(verified("mx.cloudflare.net; dmarc=pass header.from=e.linkedin.com"), true);
    assert.equal(verified("mx.cloudflare.net; dmarc=pass header.from=evil.example"), false);
    assert.equal(verified("mx.cloudflare.net; dmarc=pass header.from=notlinkedin.com"), false);
    assert.equal(verified("mx.cloudflare.net; dmarc=pass header.from=linkedin.com; dmarc=fail"), false, "every dmarc must pass");
  });

  test("extracts job ids from plain, quoted-printable and base64 bodies", () => {
    const html = '<a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc&amp;refId=x">x</a>';
    const raw = [
      "From: LinkedIn <jobalerts-noreply@linkedin.com>",
      "Content-Type: multipart/alternative; boundary=B",
      "",
      "--B",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "View job: https://www.linkedin.com/comm/jobs/view/40=",
      "99999999/?trk=3Dx",
      "Also https://hu.linkedin.com/jobs/view/4011111111.",
      "--B",
      "Content-Transfer-Encoding: base64",
      "Content-Type: text/html; charset=UTF-8",
      "",
      ...Buffer.from(html).toString("base64").match(/.{1,76}/g),
      "--B--",
      "",
    ].join("\r\n");
    assert.deepEqual(extractLinkedInJobIds(raw).sort(), ["4011111111", "4012345678", "4099999999"]);
  });

  test("ignores look-alike hosts, slugs and other LinkedIn links", () => {
    const raw = [
      "https://evillinkedin.com/jobs/view/1111111111/",
      "https://linkedin.com.evil.example/jobs/view/2222222222/",
      "https://www.linkedin.com/jobs/view/devops-engineer-at-x-3333333333",
      "https://www.linkedin.com/jobs/view/4444444444-foo",
      "https://www.linkedin.com/comm/in/someone/",
      "https://www.linkedin.com/jobs/search/?currentJobId=5555555555",
      "https://www.linkedin.com/jobs/view/0123",
      "http://www.linkedin.com/jobs/view/7777777777",
      "https://www.linkedin.com/jobs/view/6666666666",
      "https://www.linkedin.com/jobs/view/6666666666/",
    ].join("\n");
    assert.deepEqual(extractLinkedInJobIds(raw), ["6666666666"]);
  });

  // Regression: the earlier single-regex base64 scan re-scanned to the end of
  // the input from every CTE line (quadratic). 512 KB of CTE lines with no
  // blank line is the worst case for that shape.
  test("base64 scan is linear: 512 KB of repeated CTE lines in well under 50 ms", () => {
    const line = "Content-Transfer-Encoding: base64\r\n";
    const raw = line.repeat(Math.ceil((512 * 1024) / line.length));
    decodeForLinks(raw.slice(0, 1000)); // warm up
    const t0 = performance.now();
    decodeForLinks(raw);
    extractLinkedInJobIds(raw);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
  });

  test("link regex stays linear on adversarial host-like input", () => {
    const raw = ("https://" + "a.".repeat(2000) + "b ").repeat(64); // ~256 KB
    const t0 = performance.now();
    assert.deepEqual(extractLinkedInJobIds(raw), []);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
  });

  test("a base64 part is still decoded when its CTE line is followed by more headers", () => {
    const html = 'href="https://www.linkedin.com/comm/jobs/view/4055555555/"';
    const raw = ["Content-Transfer-Encoding: base64", "Content-Type: text/html", "", Buffer.from(html).toString("base64"), "--B--"].join("\r\n");
    assert.deepEqual(extractLinkedInJobIds(raw), ["4055555555"]);
  });

  test(`caps ids per message at ${MAX_IDS_PER_EMAIL}`, () => {
    const raw = Array.from({ length: MAX_IDS_PER_EMAIL + 50 }, (_, i) => `https://www.linkedin.com/jobs/view/${4000000000 + i}/`).join("\n");
    assert.equal(extractLinkedInJobIds(raw).length, MAX_IDS_PER_EMAIL);
  });

  test("readCapped stops at the cap and cancels the stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(c) { c.enqueue(new Uint8Array(1000).fill(65)); },
      cancel() { cancelled = true; },
    });
    const { text, truncated } = await readCapped(stream, 2500);
    assert.equal(text.length, 2500);
    assert.equal(truncated, true);
    assert.equal(cancelled, true);
  });
});

// ---- handler tests against in-memory fakes ----

// state: { ready: bool, doc: string, fail: bool } — fail makes every call throw
// (e.g. a missing table).
function fakeD1(state = {}) {
  const calls = [];
  const boom = () => { throw new Error("D1_ERROR: no such table"); };
  const stmt = (sql, params = []) => ({
    sql,
    params,
    bind: (...p) => stmt(sql, p),
    first: async () => {
      calls.push({ op: "first", sql, params });
      if (state.fail) boom();
      if (sql === SELECT_DOC_SQL) return { ready: state.ready ? 1 : null, doc: state.doc ?? "{}" };
      if (sql === READY_SQL) return state.ready ? { ready: 1 } : null;
      return null;
    },
    run: async () => {
      calls.push({ op: "run", sql, params });
      if (state.fail) boom();
      return { meta: { changes: params.length } };
    },
  });
  return {
    calls,
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      calls.push({ op: "batch", stmts: stmts.map((s) => ({ sql: s.sql, params: s.params })) });
      if (state.fail) boom();
      return [];
    },
  };
}
const batches = (db) => db.calls.filter((c) => c.op === "batch");

describe("worker.fetch", () => {
  const origFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
      return new Response(JSON.stringify({ keys: [K1.jwk] }), { status: 200 });
    };
  });
  after(() => { globalThis.fetch = origFetch; });

  const baseEnv = (extra = {}) => ({
    ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ACCESS_ENFORCE: "enforce", OWNER_EMAILS: OWNER, RUNNER_CLIENT_ID: RUNNER,
    ASSETS: { fetch: async (r) => new Response(`asset:${new URL(r.url).pathname}`) },
    SNAPSHOT: { get: async (key, type) => (key === "jobs.json" && type === "stream" ? new Response('{"jobs":[]}').body : null) },
    TRACKER_DB: fakeD1({ ready: true, doc: '{"li-1":{"st":"saved","at":"2026-11-24"}}' }),
    ...extra,
  });
  const now = () => Math.floor(Date.now() / 1000);
  const ownerToken = () => sign(K1, { iss: ISS, aud: [AUD], exp: now() + 600, email: OWNER });
  const runnerToken = () => sign(K1, { iss: ISS, aud: [AUD], exp: now() + 600, common_name: RUNNER, sub: "" });
  const call = async (env, path, { method = "GET", token, headers = {}, body } = {}) => {
    const h = { ...headers };
    if (token) h["Cf-Access-Jwt-Assertion"] = token;
    const { result } = await captureLogs(() => worker.fetch(new Request(`https://jobs.toomhorvath.com${path}`, { method, headers: h, body }), env));
    return result;
  };

  test("enforce: no token → 403; owner → tracker from D1 untouched", async () => {
    const env = baseEnv();
    assert.equal((await call(env, "/api/tracker")).status, 403);
    const r = await call(env, "/api/tracker", { token: await ownerToken() });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '{"li-1":{"st":"saved","at":"2026-11-24"}}');
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  test("empty but initialised tracker table → {}", async () => {
    const env = baseEnv({ TRACKER_DB: fakeD1({ ready: true, doc: "{}" }) });
    assert.equal(await (await call(env, "/api/tracker", { token: await ownerToken() })).text(), "{}");
  });

  test("no 'tracker_imported' marker (or a D1 error) → 503 no-store on GET and PUT, table untouched", async () => {
    const token = await ownerToken();
    for (const db of [fakeD1({ ready: false, doc: "{}" }), fakeD1({ fail: true })]) {
      const env = baseEnv({ TRACKER_DB: db });
      const g = await call(env, "/api/tracker", { token });
      assert.equal(g.status, 503);
      assert.equal(g.headers.get("cache-control"), "no-store");
      const p = await call(env, "/api/tracker", { method: "PUT", token, headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(p.status, 503);
      assert.equal(batches(db).length, 0);
    }
  });

  test("PUT: origin and content-type checks, then one batch with ONE bound parameter", async () => {
    const env = baseEnv();
    const token = await ownerToken();
    const body = JSON.stringify({ "li-1": { st: "applied", at: "2026-11-24T10:00:00.000Z" } });
    const put = (headers) => call(env, "/api/tracker", { method: "PUT", token, headers, body });

    assert.equal((await put({ "Content-Type": "application/json", Origin: "https://evil.example" })).status, 403);
    assert.equal((await put({ "Content-Type": "text/plain" })).status, 415);
    assert.equal((await put({})).status, 415);
    assert.equal(env.TRACKER_DB.calls.length, 0);

    const ok = await put({ "Content-Type": "application/json; charset=utf-8", Origin: "https://jobs.toomhorvath.com" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, entries: 1 });
    const [b] = batches(env.TRACKER_DB);
    assert.deepEqual(b.stmts.map((s) => s.sql), [DELETE_ALL_SQL, INSERT_FROM_JSON_SQL]);
    assert.deepEqual(b.stmts[1].params, [body]);

    assert.equal((await put({ "Content-Type": "application/json" })).status, 200, "no Origin header (non-browser) is fine");
  });

  test("PUT keeps the v1 error contract", async () => {
    const env = baseEnv();
    const token = await ownerToken();
    const put = (body) => call(env, "/api/tracker", { method: "PUT", token, headers: { "Content-Type": "application/json" }, body });
    assert.equal((await put("{nope")).status, 400);
    assert.equal((await put('{"a":{"st":"bad","at":"x"}}')).status, 400);
    assert.equal((await put("x".repeat(512 * 1024 + 1))).status, 413);
    assert.equal((await call(env, "/api/tracker", { method: "POST", token })).status, 405);
  });

  test("PUT size cap: Content-Length refused before reading; the cap counts bytes, not chars", async () => {
    const env = baseEnv();
    const token = await ownerToken();
    const req = new Request("https://jobs.toomhorvath.com/api/tracker", {
      method: "PUT", body: "{}",
      headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", "Content-Length": String(512 * 1024 + 1) },
    });
    assert.equal(req.headers.get("content-length"), String(512 * 1024 + 1));
    const declared = await worker.fetch(req, env);
    assert.equal(declared.status, 413);
    assert.equal(req.bodyUsed, false, "body was not read");

    // 300 K "é" = 300 K chars but 600 KB of UTF-8: over the cap.
    const wide = JSON.stringify({ a: { st: "saved", at: "x" }, pad: "é".repeat(300 * 1024) });
    assert.ok(wide.length < 512 * 1024);
    const r = await call(env, "/api/tracker", { method: "PUT", token, headers: { "Content-Type": "application/json" }, body: wide });
    assert.equal(r.status, 413);

    // A chunked body with no Content-Length is capped while streaming.
    let chunks = 0;
    const endless = new ReadableStream({ pull(c) { chunks++; c.enqueue(new Uint8Array(64 * 1024).fill(32)); } });
    const s = await captureLogs(() => worker.fetch(new Request("https://jobs.toomhorvath.com/api/tracker", {
      method: "PUT", body: endless, duplex: "half",
      headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" },
    }), env));
    assert.equal(s.result.status, 413);
    assert.ok(chunks <= 10, `read ${chunks} chunks`);
    assert.equal(batches(env.TRACKER_DB).length, 0);
  });

  test("runner may read but not write", async () => {
    const env = baseEnv();
    const token = await runnerToken();
    assert.equal((await call(env, "/api/tracker", { token })).status, 200);
    assert.equal((await call(env, "/data/jobs.json", { token })).status, 200);
    const w = await call(env, "/api/tracker", { method: "PUT", token, headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(w.status, 403);
  });

  test("/data/* streams the KV snapshot; a missing key is a logged 503, never an asset; unknown path → 404", async () => {
    const token = await ownerToken();
    const d1 = baseEnv();
    const r = await call(d1, "/data/jobs.json", { token });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(r.headers.get("cache-control"), "no-cache");
    assert.equal(await r.text(), '{"jobs":[]}');
    const { result: fb, lines } = await captureLogs(() => worker.fetch(new Request("https://jobs.toomhorvath.com/data/last-run.json",
      { headers: { "Cf-Access-Jwt-Assertion": token } }), d1));
    assert.equal(fb.status, 503);
    assert.deepEqual(await fb.json(), { error: "snapshot unavailable" });
    assert.ok(lines.some(l => l.includes('"snapshot_missing"') && l.includes('"last-run.json"')));
    assert.equal((await call(d1, "/data/other.json", { token })).status, 404);
  });

  test("log mode serves the request even without a token", async () => {
    const r = await call(baseEnv({ ACCESS_ENFORCE: "log" }), "/api/tracker");
    assert.equal(r.status, 200);
  });
});

describe("worker.email", () => {
  const CF_OK = "mx.cloudflare.net; dkim=pass header.d=linkedin.com header.s=s1; dmarc=pass header.from=linkedin.com; spf=pass";
  const message = ({ from = "LinkedIn <jobalerts-noreply@linkedin.com>", auth = CF_OK, body = "" } = {}) => {
    const bytes = new TextEncoder().encode(body);
    const m = {
      from: "s-1@bounce.linkedin.com",
      to: "alerts@sub.example",
      headers: new Headers({ from, ...(auth ? { "authentication-results": auth } : {}) }),
      raw: new Response(bytes).body,
      rawSize: bytes.length,
      rejected: null,
      forwarded: [],
      setReject(reason) { this.rejected = reason; },
      async forward(to) { this.forwarded.push(to); },
      reply() { throw new Error("must never reply"); },
    };
    return m;
  };

  test("ingests ids with one INSERT OR IGNORE … json_each statement", async () => {
    const JOBS_DB = fakeD1();
    const m = message({ body: "https://www.linkedin.com/comm/jobs/view/4012345678/ https://www.linkedin.com/jobs/view/4087654321" });
    const { lines } = await captureLogs(() => worker.email(m, { JOBS_DB }));
    assert.equal(m.rejected, null);
    assert.equal(JOBS_DB.calls.length, 1);
    const [c] = JOBS_DB.calls;
    assert.equal(c.sql, INSERT_CANDIDATES_SQL);
    assert.match(c.params[0], /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(JSON.parse(c.params[1]), ["4012345678", "4087654321"]);
    assert.equal(JSON.parse(lines[0]).event, "email_ingested");
    assert.ok(!lines.join("").includes("jobalerts-noreply"));
  });

  test("accepts a LinkedIn subdomain sender", async () => {
    const JOBS_DB = fakeD1();
    const m = message({ from: "LinkedIn <jobs-listings@e.linkedin.com>", body: "https://www.linkedin.com/jobs/view/4012345678" });
    await captureLogs(() => worker.email(m, { JOBS_DB }));
    assert.equal(m.rejected, null);
    assert.equal(JOBS_DB.calls.length, 1);
  });

  test("rejects non-LinkedIn senders", async () => {
    for (const from of ["Someone <a@evil.example>", '"jobs@linkedin.com" <a@evil.example>', "a@notlinkedin.com"]) {
      const JOBS_DB = fakeD1();
      const m = message({ from, body: "https://www.linkedin.com/jobs/view/4012345678" });
      const { lines } = await captureLogs(() => worker.email(m, { JOBS_DB }));
      assert.ok(m.rejected, from);
      assert.equal(JSON.parse(lines[0]).event, "email_rejected");
      assert.equal(JOBS_DB.calls.length, 0);
    }
  });

  test("LinkedIn From but unverified: dropped without a bounce, one email_unverified line, no addresses", async () => {
    for (const [auth, reason] of [
      ["mx.cloudflare.net; dkim=pass header.d=linkedin.com; dmarc=fail header.from=linkedin.com", "dmarc"],
      ["mx.cloudflare.net; dkim=pass header.d=linkedin.com; spf=pass", "dmarc"],
      ['mx.cloudflare.net; spf=pass smtp.mailfrom="a;dmarc=pass"@evil.example', "unsafe"],
      ["spoof.example; dmarc=pass header.from=linkedin.com", "not_cloudflare"],
      [null, "missing"],
    ]) {
      const JOBS_DB = fakeD1();
      const m = message({ auth, body: "https://www.linkedin.com/jobs/view/4012345678" });
      const { lines } = await captureLogs(() => worker.email(m, { JOBS_DB }));
      assert.equal(m.rejected, null, String(auth));
      assert.equal(JOBS_DB.calls.length, 0);
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.event, "email_unverified");
      assert.equal(entry.reason, reason);
      assert.ok(!/@|linkedin\.com|evil/.test(lines[0]), lines[0]);
    }
  });

  test("a failed INSERT (e.g. missing table) is logged and dropped, never thrown", async () => {
    const JOBS_DB = fakeD1({ fail: true });
    const m = message({ body: "https://www.linkedin.com/jobs/view/4012345678" });
    const { lines } = await captureLogs(() => worker.email(m, { JOBS_DB }));
    assert.equal(m.rejected, null);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, "email_store_failed");
    assert.equal(entry.ids, 1);
  });

  test("a genuine LinkedIn mail without job links is dropped quietly", async () => {
    const JOBS_DB = fakeD1();
    const m = message({ body: "Your weekly summary" });
    await captureLogs(() => worker.email(m, { JOBS_DB }));
    assert.equal(m.rejected, null);
    assert.equal(JOBS_DB.calls.length, 0);
  });

  test("without FORWARD_TO nothing is forwarded", async () => {
    const m = message({ body: "https://www.linkedin.com/jobs/view/4012345678" });
    await captureLogs(() => worker.email(m, { JOBS_DB: fakeD1() }));
    assert.deepEqual(m.forwarded, []);
  });

  test("with FORWARD_TO verified LinkedIn mail is forwarded after ingestion; unverified and rejected mail is not", async () => {
    const FORWARD_TO = "owner@inbox.example";
    const cases = [
      ["alert", {}, "https://www.linkedin.com/jobs/view/4012345678", 1],
      ["no links", {}, "You have a new message from a recruiter", 0],
    ];
    for (const [name, opts, body, inserts] of cases) {
      const JOBS_DB = fakeD1();
      const m = message({ ...opts, body });
      const { lines } = await captureLogs(() => worker.email(m, { JOBS_DB, FORWARD_TO }));
      assert.deepEqual(m.forwarded, [FORWARD_TO], name);
      assert.equal(JOBS_DB.calls.length, inserts, name);
      assert.equal(JSON.parse(lines.at(-1)).event, "email_forwarded", name);
      assert.ok(!lines.join("").includes("@"), name);
    }
    for (const auth of ["mx.cloudflare.net; dmarc=fail header.from=linkedin.com", null]) {
      const spoof = message({ auth, body: "https://www.linkedin.com/jobs/view/4012345678" });
      const { lines } = await captureLogs(() => worker.email(spoof, { JOBS_DB: fakeD1(), FORWARD_TO }));
      assert.deepEqual(spoof.forwarded, [], String(auth));
      assert.equal(spoof.rejected, null);
      assert.deepEqual(lines.map(l => JSON.parse(l).event), ["email_unverified"]);
    }
    const spam = message({ from: "a@evil.example", body: "x" });
    await captureLogs(() => worker.email(spam, { JOBS_DB: fakeD1(), FORWARD_TO }));
    assert.ok(spam.rejected); assert.deepEqual(spam.forwarded, []);
  });

  test("a failed store or a failed read still forwards", async () => {
    const FORWARD_TO = "owner@inbox.example";
    const m = message({ body: "https://www.linkedin.com/jobs/view/4012345678" });
    await captureLogs(() => worker.email(m, { JOBS_DB: fakeD1({ fail: true }), FORWARD_TO }));
    assert.deepEqual(m.forwarded, [FORWARD_TO]);
    const broken = message({ body: "x" });
    broken.raw = new ReadableStream({ pull(c) { c.error(new Error("stream reset by a@b.example")); } });
    const { lines } = await captureLogs(() => worker.email(broken, { JOBS_DB: fakeD1(), FORWARD_TO }));
    assert.deepEqual(broken.forwarded, [FORWARD_TO]);
    const failed = lines.map(l => JSON.parse(l)).find(l => l.event === "email_ingest_failed");
    assert.equal(failed.error, "stream reset by <address>");
  });

  test("a forward failure is logged without addresses and never thrown; unforwardable mail is skipped", async () => {
    const m = message({ body: "Your weekly summary" });
    m.forward = async () => { throw new Error("destination owner@inbox.example is not verified"); };
    const { lines } = await captureLogs(() => worker.email(m, { JOBS_DB: fakeD1(), FORWARD_TO: "owner@inbox.example" }));
    assert.equal(m.rejected, null);
    const entry = JSON.parse(lines.at(-1));
    assert.equal(entry.event, "email_forward_failed");
    assert.equal(entry.error, "destination <address> is not verified");
    const n = message({ body: "x" }); n.canBeForwarded = false;
    const r = await captureLogs(() => worker.email(n, { JOBS_DB: fakeD1(), FORWARD_TO: "owner@inbox.example" }));
    assert.deepEqual(n.forwarded, []);
    assert.equal(JSON.parse(r.lines.at(-1)).event, "email_forward_skipped");
  });
});
