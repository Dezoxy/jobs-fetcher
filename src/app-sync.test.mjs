// public/app.js tracker sync under a failing server: a non-200 GET (503 "not
// initialised", offline) must never delete local entries, and no PUT may go
// out before this page has merged with the server copy. Runs the real
// app.js in a vm with a minimal DOM stub; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function stubElement() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "classList") return { toggle() {}, add() {}, remove() {}, contains: () => false };
      if (prop === "style") return { setProperty() {} };
      if (prop === "dataset") return {};
      return () => undefined; // any method: addEventListener, add, setAttribute, …
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

function loadApp({ local, lastSync, responses }) {
  const store = new Map([["jobs:tracker", JSON.stringify(local)], ["jobs:lastSync", lastSync]]);
  const requests = [];
  const timers = [];
  const context = {
    console: { error() {}, log() {} },
    document: {
      getElementById: () => stubElement(),
      querySelector: () => null,
      addEventListener() {},
      documentElement: stubElement(),
      title: "",
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    location: { pathname: "/", search: "", hash: "" },
    history: { replaceState() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    fetch: async (url, init = {}) => {
      const method = init.method ?? "GET";
      requests.push({ url, method, body: init.body });
      if (url === "/api/tracker") {
        const next = responses[method].length > 1 ? responses[method].shift() : responses[method][0];
        return new Response(next.body ?? "", { status: next.status });
      }
      return new Response("", { status: 500 }); // jobs.json etc.: boot fails fast
    },
    Response, Date, JSON, Object, Array, Set, Map, Math, Number, String, Promise, Error, Intl,
  };
  vm.createContext(context);
  vm.runInContext(APP, context);
  vm.runInContext("render = () => {};", context); // no table in this harness
  const flushTimers = async () => {
    while (timers.some(Boolean)) {
      const fns = timers.splice(0).filter(Boolean);
      for (const fn of fns) await fn();
    }
  };
  return {
    requests,
    flushTimers,
    run: (code) => vm.runInContext(code, context),
    tracker: () => JSON.parse(store.get("jobs:tracker")),
  };
}

const LOCAL = { "li-1": { st: "ignored", at: "2026-11-01T00:00:00.000Z" }, "li-2": { st: "applied", at: "2026-11-02T00:00:00.000Z" } };

test("503 on GET: local entries survive and nothing is pushed, even after a local change", async () => {
  const app = loadApp({ local: LOCAL, lastSync: "2026-11-20T00:00:00.000Z", responses: { GET: [{ status: 503 }], PUT: [{ status: 200, body: "{}" }] } });
  app.run("loadTracker()");
  assert.equal(await app.run("pullTracker()"), false);
  assert.deepEqual(app.tracker(), LOCAL);

  app.run('setTracker("li-3", "saved")');
  await app.flushTimers();
  assert.equal(app.requests.filter((r) => r.method === "PUT").length, 0, "no PUT before a successful merge");
  assert.ok(app.requests.filter((r) => r.method === "GET" && r.url === "/api/tracker").length >= 2, "the change retried the pull");
  assert.deepEqual(Object.keys(app.tracker()).sort(), ["li-1", "li-2", "li-3"]);
});

test("once the GET succeeds, the PUT carries the merged map (server + local), never a shrunken one", async () => {
  const remote = { "li-1": { st: "ignored", at: "2026-11-01T00:00:00.000Z" }, "pr-9": { st: "offer", at: "2026-11-21T00:00:00.000Z" } };
  const app = loadApp({
    local: LOCAL,
    lastSync: "2026-10-01T00:00:00.000Z",
    responses: { GET: [{ status: 503 }, { status: 200, body: JSON.stringify(remote) }], PUT: [{ status: 200, body: "{}" }] },
  });
  app.run("loadTracker()");
  assert.equal(await app.run("pullTracker()"), false);
  app.run('setTracker("li-3", "saved")');
  await app.flushTimers();

  const puts = app.requests.filter((r) => r.method === "PUT");
  assert.equal(puts.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(puts[0].body)).sort(), ["li-1", "li-2", "li-3", "pr-9"]);
});
