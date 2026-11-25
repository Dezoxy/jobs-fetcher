"use strict";

const ARCHIVE_DAYS = 14;
const FRESH_DAYS = 7;
const REFRESH_STALE_HOURS = 26; // Daily refresh plus execution/ingestion grace.

const el = (id) => document.getElementById(id);
const tb = el("tb"), qEl = el("q"), catEl = el("cat"), sortEl = el("sort"),
      metaEl = el("meta"), emptyEl = el("empty");

const state = {
  st: "all", src: "all", posted: false, fresh: false, hideArch: true,
  priorityOnly: false, appliedOnly: false, savedOnly: false, hideIgnored: true, inbox: true,
};
let jobs = [];
let tracker = {}; // localStorage["jobs:tracker"]: { [jobId]: { st, at } }

// Desktop keyboard-cursor state (feature I below). Not hash-persisted: it is
// a transient navigation aid, not a filter.
let renderedJobs = []; // the rows actually on screen after this render(), in order
let cursorId = null;

// Demoted-block collapse (feature I, part c). Not hash-persisted — a display
// convenience, not a filter. Default: expanded on desktop, collapsed on
// mobile (where every extra scroll costs more).
let demotedCollapsed = matchMedia("(max-width:820px)").matches;

const SRCTAG = {
  LinkedIn: ["t-li", "LinkedIn"],
  Profession: ["t-pr", "Profession"],
  NoFluff: ["t-nfj", "No Fluff"],
  Indeed: ["t-in", "Indeed"],
};
const STTAG = { "Mentett": "s-sav", "Értesítő": "s-alert", "NFJ keresés": "s-search", "Indeed": "s-indeed" };
// "saved" (added 2026-08-07) is the only neutral-positive entry here: every
// other status is application progress or a rejection. It exists because the
// three portal saved-jobs lists were retired and their 187 rows had nowhere
// to land — bookmarking a job for later is now tracked here rather than on
// three separate websites. Keep it first in the select: it is the entry point
// to the funnel, the others follow it.
const TRACKER_LABELS = {
  "": "—",
  saved: "Elmentve",
  applied: "Megpályáztam",
  interview: "Interjú",
  offer: "Ajánlat",
  rejected: "Elutasítva",
  ignored: "Nem érdekel",
};
const TRACKER_STATUSES = new Set(["saved", "applied", "interview", "offer", "rejected", "ignored"]);

const days = (iso) => {
  if (!iso) return Infinity;
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return Infinity;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
};
const fmtM = (n) => (n / 1e6).toFixed(2).replace(/0$/, "").replace(/\.$/, "") + "M";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Description hierarchy (phase 3c): first sentence stays full-contrast, the
// rest is dimmed. Split on the first ". " so mid-sentence abbreviations
// ("Kb. 30%...") don't trigger early; falls back to the whole string when
// there is no second sentence.
const splitDesc = (desc) => {
  const s = String(desc);
  const i = s.indexOf(". ");
  return i === -1 ? [s, ""] : [s.slice(0, i + 1), s.slice(i + 2)];
};
const relAge = (n) => (n <= 0 ? "ma" : n === 1 ? "tegnap" : n + " napja");
const todayISO = () => new Date().toISOString().slice(0, 10);

// --- feature D: priority predicate ---
// NOTE: this logic is intentionally duplicated from scripts/notify-diff.mjs (isPriority /
// PRIORITY there). Keep both in sync if the rule ever changes.
const PRIORITY_CATEGORIES = new Set(["DevOps", "Architecture", "Security", "Artificial Intelligence"]);
function isPriority(j) {
  return PRIORITY_CATEGORIES.has(j.category) || j.salaryHi >= 2_000_000;
}

// Demoted categories (added 2026-08-07, same sync rule as PRIORITY above:
// duplicated in scripts/notify-diff.mjs, change both or neither). Measured on
// the 2026-08-07 tracker export: 76 of 92 Business Analyst rows (83%) were
// marked "Nem érdekel" — but the kept 17% were real (SimplePay, NISZ, MBH),
// so the family is demoted, not dropped: rows stay in jobs.json, sort last
// regardless of the chosen sort, and are not enumerated in the Telegram digest.
const DEMOTED_CATEGORIES = new Set(["Business Analyst"]);

function decorate(j) {
  j.mid = (j.salaryLo + j.salaryHi) / 2;
  j.ageSeen = days(j.lastSeen);
  j.ageFirst = days(j.firstSeen);
  // closed: the liveness probe confirmed the ad no longer exists on the
  // portal — archive it immediately instead of waiting out the 14 days.
  j.archived = !!j.closed || j.ageSeen > ARCHIVE_DAYS;
  j.isNew = j.ageFirst <= FRESH_DAYS;
  j.priority = isPriority(j);
  j.demoted = DEMOTED_CATEGORIES.has(j.category);
  return j;
}

// --- feature B: URL-hash filter persistence ---
const HASH_DEFAULTS = {
  q: "", cat: "", sort: "mid-desc", st: "all", src: "all",
  posted: false, fresh: false, hideArch: true,
  priorityOnly: false, appliedOnly: false, savedOnly: false, hideIgnored: true, inbox: true,
};
const VALID_ST = new Set(["all", "Mentett", "Értesítő", "NFJ keresés", "Indeed"]);
const VALID_SRC = new Set(["all", "LinkedIn", "Profession", "NoFluff", "Indeed"]);
const VALID_SORT = new Set(["mid-desc", "mid-asc", "new", "role", "company", "priority"]);

function buildHashParams(s) {
  const parts = [];
  const put = (k, v) => parts.push(k + "=" + encodeURIComponent(v));
  if (s.q) put("q", s.q);
  if (s.cat) put("cat", s.cat);
  if (s.sort !== HASH_DEFAULTS.sort) put("sort", s.sort);
  if (s.st !== HASH_DEFAULTS.st) put("st", s.st);
  if (s.src !== HASH_DEFAULTS.src) put("src", s.src);
  if (s.posted) put("posted", "1");
  if (s.fresh) put("fresh", "1");
  if (!s.hideArch) put("arch", "0");
  if (s.priorityOnly) put("pri", "1");
  if (s.appliedOnly) put("applied", "1");
  if (s.savedOnly) put("saved", "1");
  if (!s.hideIgnored) put("hideIgn", "0");
  if (!s.inbox) put("inbox", "0"); // default ON (2026-08-08) — only the off state is serialized
  return parts.join("&");
}

function parseHashString(raw) {
  const str = raw.startsWith("#") ? raw.slice(1) : raw;
  const out = {};
  if (!str) return out;
  for (const pair of str.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const k = pair.slice(0, eq);
    try {
      out[k] = decodeURIComponent(pair.slice(eq + 1));
    } catch (e) { /* ignore malformed escape */ }
  }
  return out;
}

function stateFromHashParams(params) {
  return exclusiveTrackerFilters({
    q: params.q ?? HASH_DEFAULTS.q,
    cat: params.cat ?? HASH_DEFAULTS.cat,
    sort: VALID_SORT.has(params.sort) ? params.sort : HASH_DEFAULTS.sort,
    st: VALID_ST.has(params.st) ? params.st : HASH_DEFAULTS.st,
    src: VALID_SRC.has(params.src) ? params.src : HASH_DEFAULTS.src,
    posted: params.posted === "1",
    fresh: params.fresh === "1",
    hideArch: params.arch === "0" ? false : HASH_DEFAULTS.hideArch,
    priorityOnly: params.pri === "1",
    appliedOnly: params.applied === "1",
    savedOnly: params.saved === "1",
    hideIgnored: params.hideIgn === "0" ? false : HASH_DEFAULTS.hideIgnored,
    inbox: params.inbox === "0" ? false : HASH_DEFAULTS.inbox,
  });
}

// Inbox mode keeps only rows with NO tracker verdict; savedOnly/appliedOnly
// keep only rows that HAVE one. Every filter in render() is ANDed, so the two
// together match nothing, always — a chip that silently empties the list reads
// as a broken chip. They are therefore mutually exclusive: turning a verdict
// filter on drops inbox mode, and returning to inbox mode clears the verdict
// filters. Applied to hash-loaded state too, so a shared #saved=1 link works
// on its own. (The appliedOnly half of this was shipped broken on 2026-08-08
// and went unnoticed because the tracker held no applied rows to reveal it.)
function exclusiveTrackerFilters(s) {
  if (s.savedOnly || s.appliedOnly) s.inbox = false;
  return s;
}

function collectState() {
  return {
    q: qEl.value, cat: catEl.value, sort: sortEl.value,
    st: state.st, src: state.src,
    posted: state.posted, fresh: state.fresh, hideArch: state.hideArch,
    priorityOnly: state.priorityOnly, appliedOnly: state.appliedOnly, savedOnly: state.savedOnly,
    hideIgnored: state.hideIgnored,
    inbox: state.inbox,
  };
}

function updateHash() {
  const hash = buildHashParams(collectState());
  const url = location.pathname + location.search + (hash ? "#" + hash : "");
  history.replaceState(null, "", url);
}

function syncChipClasses() {
  el("stGrp").querySelectorAll(".chip").forEach((b) => b.classList.toggle("on", b.dataset.st === state.st));
  el("srcGrp").querySelectorAll(".chip").forEach((b) => b.classList.toggle("on", b.dataset.src === state.src));
  el("postedBtn").classList.toggle("on", state.posted);
  el("freshBtn").classList.toggle("on", state.fresh);
  el("archBtn").classList.toggle("on", state.hideArch);
  el("priorityBtn").classList.toggle("on", state.priorityOnly);
  el("appliedBtn").classList.toggle("on", state.appliedOnly);
  el("savedBtn").classList.toggle("on", state.savedOnly);
  el("hideIgnoredBtn").classList.toggle("on", state.hideIgnored);
  el("inboxGrp").querySelectorAll(".chip").forEach((b) => b.classList.toggle("on", (b.dataset.inbox === "1") === state.inbox));
}

function applyHashToUI() {
  const s = stateFromHashParams(parseHashString(location.hash));
  qEl.value = s.q;
  if (s.cat && [...catEl.options].some((o) => o.value === s.cat)) catEl.value = s.cat;
  sortEl.value = s.sort;
  state.st = s.st;
  state.src = s.src;
  state.posted = s.posted;
  state.fresh = s.fresh;
  state.hideArch = s.hideArch;
  state.priorityOnly = s.priorityOnly;
  state.appliedOnly = s.appliedOnly;
  state.savedOnly = s.savedOnly;
  state.hideIgnored = s.hideIgnored;
  state.inbox = s.inbox;
  syncChipClasses();
}

// --- feature C: new-since-last-visit ---
function computeFreshSinceVisit() {
  let last = null;
  try {
    const stored = localStorage.getItem("jobs:lastVisit");
    if (stored) {
      const d = new Date(stored);
      if (!isNaN(d)) last = d;
    }
  } catch (e) { /* localStorage unavailable */ }

  // firstSeen is day-granular while lastVisit is a timestamp. Comparing the raw
  // timestamp would miss jobs that appear later on the SAME day as the visit
  // (refreshes can arrive after a visit on the same calendar day). Compare by day instead,
  // inclusive: a job first seen on the day of the last visit stays highlighted.
  // Trade-off accepted: same-day items you already saw are re-highlighted once.
  const lastDay = last ? last.toISOString().slice(0, 10) : null;
  jobs.forEach((j) => {
    j.freshSinceVisit = lastDay ? j.firstSeen >= lastDay : false;
  });

  try { localStorage.setItem("jobs:lastVisit", new Date().toISOString()); } catch (e) { /* ignore */ }
}

// --- feature E: application tracker (localStorage) ---
function loadTracker() {
  try {
    const raw = localStorage.getItem("jobs:tracker");
    const parsed = raw ? JSON.parse(raw) : {};
    tracker = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    tracker = {};
  }
}
function saveTracker() {
  try { localStorage.setItem("jobs:tracker", JSON.stringify(tracker)); } catch (e) { /* ignore */ }
}
function trackerStatus(id) { return tracker[id]?.st ?? ""; }

// Shared write path for every tracker mutation (row select, ✕ hide, keyboard
// shortcuts): stamps a full ISO `at` (cross-device sync needs sub-day
// ordering, see feature G below) and always persists + syncs.
function setTracker(id, st) {
  if (st) tracker[id] = { st, at: new Date().toISOString() };
  else delete tracker[id];
  saveTracker();
  pushTracker();
}

// Should a row you have marked in the tracker still be hidden by the "archív
// rejtve" toggle once the feed stops confirming it?
//
// This matters most right now: the 187 legacy `Mentett` rows are migrating
// into the tracker as "saved", and their portals are retired, so every one of
// them WILL cross the 14-day staleness line and become archived. If archiving
// still hides them, the migration preserves the marker but not the visibility
// — you would have to un-hide the whole archive (hundreds of dead feed rows)
// to see the handful of jobs you actually picked.
//
// The trade-off: exempting tracked rows keeps your curation permanently in
// view, but "archived" then no longer means "hidden", and a job whose ad is
// genuinely gone can linger in the active list looking live. Rows with
// `closed` set are proven dead by the liveness probe, which is a stronger
// signal than mere staleness — you may want to treat those differently.
//
// Decision (2026-08-07): anything you deliberately marked stays visible, with
// one override.
//
// `closed` wins over any marker. Staleness is weak evidence — the feed simply
// stopped mentioning the row, which happens for all sorts of uninteresting
// reasons. `closed` is the liveness probe having *proven* the ad no longer
// exists (Profession 301/"lejárt", NFJ 404). Keeping a bookmark to an ad that
// is definitely gone in the active list is just a lie with extra steps.
//
// `ignored` and `rejected` are excluded because they are negative markers:
// they mean "stop showing me this," so honouring them costs nothing when the
// row ages out — archiving is doing what you already asked for. Every other
// status is something you are still holding onto, and `interview`/`offer` in
// particular would be actively harmful to hide on a 14-day timer while you
// are mid-process.
//
// Consequence to keep in mind: an archived row that survives this still
// carries its "archív" tag in the row markup, so it is visible but visibly
// stale rather than silently passing as live.
//
// The legacy `Mentett` status counts as a marker in its own right, so the
// 164 rows inherited from the retired portal lists stay visible with no
// action from you. That status lives in jobs.json, which is in git and
// permanent; keying visibility off the tracker alone would have made a
// git-backed fact depend on localStorage, which Safari's ITP clears after
// 7 days of non-use. Importing scripts/mentett-to-tracker.mjs's output is
// therefore optional — it only changes what the "Saját státusz" dropdown
// shows for those rows.
//
// Order matters: an explicit negative in the tracker beats the legacy
// status, so marking an old saved job "Nem érdekel" still hides it.
function survivesArchiveHide(j) {
  if (j.closed) return false;
  const st = trackerStatus(j.id);
  if (st === "ignored" || st === "rejected") return false;
  return st !== "" || j.status === "Mentett";
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function sanitizeTrackerImport(raw) {
  if (!isPlainObject(raw)) return null;
  const clean = {};
  for (const [id, v] of Object.entries(raw)) {
    if (isPlainObject(v) && TRACKER_STATUSES.has(v.st) && typeof v.at === "string") {
      clean[id] = { st: v.st, at: v.at };
    }
  }
  return clean;
}
function mergeTracker(base, incoming) {
  return { ...base, ...incoming }; // imported wins on conflict
}

// --- feature G: cross-device tracker sync (added 2026-08-07) ---
// GET/PUT /api/tracker — a single KV blob behind the same Cloudflare Access
// policy as the site (src/worker.js). localStorage is demoted to an offline
// cache: the server copy is the truth, so Safari's 7-day ITP eviction and
// switching devices both stop losing the "Nem érdekel" verdicts.
//
// Merge on load, per id: the newer `at` wins. New writes stamp a full ISO
// timestamp (legacy entries carry day-only dates — they compare correctly
// because "2026-08-07" < "2026-08-07T10:21:00.000Z" lexicographically).
//
// Deletion inference: an id present locally but absent remotely is either a
// local edit not yet pushed, or a deletion made on another device. The
// jobs:lastSync marker ("when did this browser last merge with the server")
// tells them apart: an entry older than that was already on the server once,
// so its absence now means another device deleted it. Day-only legacy `at`
// values compare on their own length, which errs toward resurrecting a
// same-day deletion — the safe direction (a resurrected row is one click to
// re-hide; a lost verdict is invisible).
//
// Known limit, accepted for one user: PUT writes the whole blob, so two
// devices editing in the same debounce window can lose one edit. Sequential
// solo use never hits it, and the next load re-merges.
//
// A PUT replaces the server's whole map, so this browser only PUTs after it
// has merged with the server copy in this page load (trackerMerged). Before
// that, a change re-attempts the pull instead (which pushes the merged map
// itself). A failed GET (offline, 503 "not initialised", expired Access
// session) therefore never deletes local entries and never pushes a map
// that was not merged with the server's.
let syncTimer = null;
let trackerMerged = false;

function setSyncState(state) {
  const n = el("syncState");
  if (!n) return;
  n.textContent = state === "ok" ? "☁ szinkronizálva"
    : state === "saving" ? "☁ mentés…"
    : "☁ offline — csak helyi mentés";
  n.classList.toggle("syncOff", state === "offline");
}

function pushTracker() {
  clearTimeout(syncTimer);
  setSyncState("saving");
  syncTimer = setTimeout(async () => {
    if (!trackerMerged) {
      if (await pullTracker()) render();
      return;
    }
    try {
      const r = await fetch("/api/tracker", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tracker),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      setSyncState("ok");
    } catch (e) {
      setSyncState("offline");
    }
  }, 800);
}

async function pullTracker() {
  try {
    const r = await fetch("/api/tracker", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    // An expired Access session serves the login page with a 200 — .json()
    // then throws and we land in the offline state instead of wiping state.
    const remote = sanitizeTrackerImport(await r.json());
    if (remote === null) throw new Error("bad payload");
    const lastSync = localStorage.getItem("jobs:lastSync") || "";
    const merged = { ...remote };
    for (const [id, v] of Object.entries(tracker)) {
      const rv = remote[id];
      if (!rv) {
        if (!lastSync || v.at >= lastSync.slice(0, v.at.length)) merged[id] = v;
      } else if (v.at > rv.at) {
        merged[id] = v;
      }
    }
    tracker = merged;
    trackerMerged = true;
    saveTracker();
    try { localStorage.setItem("jobs:lastSync", new Date().toISOString()); } catch (e) { /* ignore */ }
    setSyncState("ok");
    if (JSON.stringify(tracker) !== JSON.stringify(remote)) pushTracker();
    return true;
  } catch (e) {
    setSyncState("offline");
    return false;
  }
}

// --- feature H: one-tap hide + undo snackbar (2026-08-08) ---
// A single snackbar instance: showSnackbar() replaces whatever is currently
// showing (clears the previous timer/undo), matching "hide another row while
// one snackbar is up" instead of stacking messages.
let snackbarTimer = null;
let snackbarUndo = null;

function showSnackbar(msg, undoFn) {
  const bar = el("snackbar");
  if (!bar) return;
  clearTimeout(snackbarTimer);
  el("snackbarMsg").textContent = msg;
  snackbarUndo = undoFn;
  bar.hidden = false;
  snackbarTimer = setTimeout(hideSnackbar, 5000);
}
function hideSnackbar() {
  const bar = el("snackbar");
  if (!bar) return;
  clearTimeout(snackbarTimer);
  bar.hidden = true;
  snackbarUndo = null;
}

// One-tap ✕: mark ignored immediately, offer 5s undo. Captures the prior
// tracker entry (or its absence) so undo restores exactly what was there.
function hideJob(id) {
  const prev = tracker[id] ? { ...tracker[id] } : null;
  setTracker(id, "ignored");
  render();
  showSnackbar("Elrejtve", () => {
    if (prev) tracker[id] = prev;
    else delete tracker[id];
    saveTracker();
    pushTracker();
    render();
  });
}

// --- feature I: desktop keyboard cursor (2026-08-08) ---
// j/k move a visual cursor over the currently rendered rows, x/s act on it,
// Enter opens its ad. renderedJobs/cursorId are kept up to date by render().
function moveCursor(delta) {
  if (!renderedJobs.length) return;
  const idx = renderedJobs.findIndex((j) => j.id === cursorId);
  const next = idx === -1 ? 0 : Math.min(Math.max(idx + delta, 0), renderedJobs.length - 1);
  cursorId = renderedJobs[next].id;
  render();
  const row = tb.querySelector(`tr[data-id="${CSS.escape(cursorId)}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

// --- feature F: salary distribution mini-viz ---
function renderSalaryDist() {
  const active = jobs.filter((j) => !j.archived);
  const byCat = {};
  active.forEach((j) => { (byCat[j.category] ??= []).push(j); });
  const cats = Object.entries(byCat).filter(([, list]) => list.length >= 3);
  if (!cats.length) { el("distBody").innerHTML = '<p class="dim">Nincs elég adat egyik kategóriában sem.</p>'; return; }

  const allMids = cats.flatMap(([, list]) => list.map((j) => j.mid));
  const lo = Math.min(...allMids), hi = Math.max(...allMids);
  const span = hi - lo || 1;
  const pct = (v) => ((v - lo) / span) * 100;

  // CSP note: style-src 'self' has no 'unsafe-inline', so style="" attributes in
  // markup are BLOCKED. Positions go in data-* attributes and are applied below
  // via the CSSOM (.style.left = …), which CSP permits.
  const rows = cats
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat, list]) => {
      const mids = list.map((j) => j.mid);
      const min = Math.min(...mids), max = Math.max(...mids);
      const dots = list.filter((j) => j.salaryPosted).map((j) =>
        `<span class="distDot" data-left="${pct(j.mid).toFixed(1)}" title="${esc(j.role)} · ${fmtM(j.mid)}"></span>`
      ).join("");
      return `<div class="distRow" data-cat="${esc(cat)}" title="Szűrés erre a kategóriára">
        <div class="distLabel">${esc(cat)} <span class="dim">(${list.length})</span></div>
        <div class="distTrack">
          <div class="distBar" data-left="${pct(min).toFixed(1)}" data-width="${Math.max(pct(max) - pct(min), 0.5).toFixed(1)}"></div>
          ${dots}
        </div>
        <div class="distRange">${fmtM(min)}–${fmtM(max)}</div>
      </div>`;
    }).join("");

  const body = el("distBody");
  body.innerHTML = `<div class="distAxis"><span>${fmtM(lo)}</span><span>${fmtM(hi)}</span></div>${rows}`;
  body.querySelectorAll("[data-left]").forEach((n) => {
    n.style.left = n.dataset.left + "%";
    if (n.dataset.width) n.style.width = n.dataset.width + "%";
  });
}

// --- feature A: run-note banner ---
async function loadRunNote() {
  try {
    const r = await fetch("/data/last-run.json", { cache: "no-cache" });
    if (!r.ok) return null; // includes 404 — absent file is a silent no-op
    const data = await r.json();
    renderRunNote(data);
    return data;
  } catch (e) {
    return null; // silent: banner is optional
  }
}

// --- footer: website (Worker) and engine (image that made the list) versions ---
const REPO = "https://github.com/Dezoxy/jobs-fetcher";
async function loadWebVersion() {
  try {
    const r = await fetch("/data/version.json", { cache: "no-store" });
    return r.ok ? (await r.json()).web : null;
  } catch (e) {
    return null;
  }
}
function renderVersions(web, runNote) {
  const parts = [];
  const commit = web && /^[0-9a-f]{7,40}$/.test(web.commit || "") ? web.commit : null;
  const deployed = web && web.deployedAt ? new Date(web.deployedAt) : null;
  const when = deployed && !isNaN(deployed) ? deployed.toLocaleString("hu-HU") : "";
  if (commit) {
    parts.push(`Weboldal: <a href="${REPO}/commit/${commit}" target="_blank" rel="noopener">${esc(commit.slice(0, 7))}</a>` +
      (when ? ` (${esc(when)})` : ""));
  } else if (when) {
    parts.push(`Weboldal: ${esc(when)}`);
  }
  const engine = runNote && typeof runNote.engineVersion === "string" ? runNote.engineVersion : "";
  if (/^\d{4}\.\d{1,2}\.\d{1,4}$/.test(engine)) {
    parts.push(`Motor: <a href="${REPO}/releases/tag/v${engine}" target="_blank" rel="noopener">v${esc(engine)}</a>`);
  } else if (engine === "dev") {
    parts.push("Motor: dev");
  }
  if (!parts.length) return;
  el("versions").innerHTML = parts.join(" · ");
  el("versions").hidden = false;
}
function renderRunNote(data) {
  const ranAt = data && data.ranAt ? new Date(data.ranAt) : null;
  const summary = data && typeof data.summary === "string" ? data.summary : "";
  const warnings = data && Array.isArray(data.warnings) ? data.warnings : [];
  if (!ranAt && !summary) return;

  const stale = ranAt && !isNaN(ranAt) ? (Date.now() - ranAt.getTime()) / 3600000 > REFRESH_STALE_HOURS : false;
  const shortSummary = summary.length > 80 ? summary.slice(0, 80) + "…" : summary;
  const when = ranAt && !isNaN(ranAt) ? ranAt.toLocaleString("hu-HU") : "ismeretlen időpont";

  el("runNoteSummary").innerHTML =
    `<span class="${stale ? "runWarn" : ""}">Utolsó frissítés: ${esc(when)}${summary ? " · " + esc(shortSummary) : ""}</span>`;

  let body = summary ? `<p>${esc(summary)}</p>` : "";
  if (warnings.length) {
    body += `<ul class="runWarnings">${warnings.map((w) => `<li>⚠ ${esc(String(w))}</li>`).join("")}</ul>`;
  }
  el("runNoteBody").innerHTML = body;
  el("runNote").hidden = false;
}

function render() {
  const q = qEl.value.toLowerCase().trim();
  const cat = catEl.value;

  let out = jobs.filter((j) =>
    (state.st === "all" || j.status === state.st) &&
    (state.src === "all" || j.source === state.src) &&
    (!cat || j.category === cat) &&
    (!state.posted || j.salaryPosted) &&
    (!state.fresh || j.isNew) &&
    (!state.hideArch || !j.archived || survivesArchiveHide(j)) &&
    (!state.priorityOnly || j.priority) &&
    (!state.appliedOnly || ["applied", "interview", "offer"].includes(trackerStatus(j.id))) &&
    // "Elmentve" is the tracker verdict, NOT j.status === "Mentett" (that is
    // provenance: the row came off the portal's own saved list). Saving a row
    // clears it from inbox mode, and appliedOnly deliberately excludes "saved",
    // so before this chip existed (2026-08-29) a saved row matched no preset at
    // all — reachable only via "Összes" plus a manual search.
    (!state.savedOnly || trackerStatus(j.id) === "saved") &&
    (!state.hideIgnored || trackerStatus(j.id) !== "ignored") &&
    // Triage mode ("Feldolgozandó"): rows you have not yet made a call on.
    // Additive with every other filter, not a replacement for them.
    (!state.inbox || (trackerStatus(j.id) === "" && !j.archived)) &&
    (!q || (j.role + " " + j.company + " " + j.description + " " + j.category).toLowerCase().includes(q))
  );

  const base = {
    "mid-desc": (a, b) => b.mid - a.mid,
    "mid-asc": (a, b) => a.mid - b.mid,
    "new": (a, b) => a.ageFirst - b.ageFirst || b.mid - a.mid,
    "role": (a, b) => a.role.localeCompare(b.role, "hu"),
    "company": (a, b) => a.company.localeCompare(b.company, "hu") || b.mid - a.mid,
    "priority": (a, b) => (b.priority - a.priority) || (b.mid - a.mid),
  }[sortEl.value] ?? ((a, b) => b.mid - a.mid);
  // Demoted categories sink to the bottom under every sort; within each half
  // the chosen order still applies. See DEMOTED_CATEGORIES for the rationale.
  const cmp = (a, b) => (a.demoted - b.demoted) || base(a, b);
  out.sort(cmp);

  // Keyboard-cursor bookkeeping happens BEFORE the rows are built so the
  // (possibly re-targeted) cursor row renders with its highlight in this same
  // pass. renderedJobs only holds rows actually on screen (a collapsed
  // demoted block is excluded). When the cursor row leaves the list (x/✕ hid
  // it, or a filter change), the cursor moves to the row that now occupies
  // the same position instead of resetting — so an x-x-x triage run stays
  // where you were rather than teleporting back to the top on the next j.
  const firstDemotedIdx = out.findIndex((j) => j.demoted);
  const prevIdx = renderedJobs.findIndex((j) => j.id === cursorId);
  renderedJobs = (firstDemotedIdx !== -1 && demotedCollapsed) ? out.filter((j) => !j.demoted) : out;
  if (!renderedJobs.some((j) => j.id === cursorId)) {
    cursorId = (prevIdx !== -1 && renderedJobs.length)
      ? renderedJobs[Math.min(prevIdx, renderedJobs.length - 1)].id
      : null;
  }

  const rowHtml = (j) => {
    const [cls, lbl] = SRCTAG[j.source] ?? ["t-emp", j.source];
    const pay = j.salaryLo === j.salaryHi ? fmtM(j.salaryLo) : fmtM(j.salaryLo) + "–" + fmtM(j.salaryHi);
    const unit = j.type === "Contract" ? "nettó" : "bruttó";
    const trkSt = trackerStatus(j.id);
    const trk = tracker[j.id];
    const rowCls = [
      j.archived ? "arch" : "",
      j.demoted ? "demoted" : "",
      j.freshSinceVisit ? "new-visit" : "",
      j.id === cursorId ? "cursor" : "",
      trkSt === "offer" ? "st-offer" : trkSt === "rejected" ? "st-rejected" : trkSt === "ignored" ? "st-ignored" : "",
    ].filter(Boolean).join(" ");
    const options = Object.entries(TRACKER_LABELS).map(([val, label]) =>
      `<option value="${esc(val)}"${trkSt === val ? " selected" : ""}>${esc(label)}</option>`).join("");
    // Description hierarchy (3c): first sentence full-contrast, rest dimmed —
    // escaped separately so the split point never lands inside an entity.
    const [descFirst, descRest] = splitDesc(j.description);

    return `<tr class="${rowCls}" data-id="${esc(j.id)}">
      <td data-l="Pozíció"><div class="role">${j.priority ? '<span class="star" title="Prioritás">⭐</span> ' : ""}<a href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">${esc(j.role)}</a>${
        j.isNew ? ' <span class="tag t-new">ÚJ</span>' : ""}${
        j.freshSinceVisit ? ' <span class="tag t-freshvisit">friss</span>' : ""}${
        j.archived ? (j.closed ? ' <span class="tag t-arch">lejárt</span>' : ' <span class="tag t-arch">archív</span>') : ""}${
        // repostOf: the owner hid a twin of this ad; v2 shows reposts flagged, not hidden.
        j.repostOf ? ` <span class="tag t-repost" title="${esc("Egy korábban elrejtett hirdetés újrafeladása: " + j.repostOf)}">újrafeladás</span>` : ""}
        <span class="ageTag">${esc(relAge(j.ageFirst))}</span></div>
        <div class="co">${esc(j.company)}</div>
        <div class="tagsRow"><span class="tag t-cat">${esc(j.category)}</span><span class="tag ${cls}">${esc(lbl)}</span><span class="tag ${STTAG[j.status] ?? "s-sav"}">${esc(j.status)}</span>${
          j.type === "Contract" ? '<span class="tag t-con">B2B</span>' : ""}</div></td>
      <td data-l="Mi ez" class="desc">${esc(descFirst)}${descRest ? ` <span class="descRest">${esc(descRest)}</span>` : ""}</td>
      <td data-l="Bér / hó" class="pay" title="${esc(j.benchmark)}">${pay}<br><span class="${j.salaryPosted ? "b-posted" : "b-est"}">${
        j.salaryPosted ? "HIRDETETT · " + unit : "becslés · " + unit}</span></td>
      <td data-l="Saját státusz"><select class="trkSel" data-id="${esc(j.id)}">${options}</select>${
        trk?.at ? `<div class="trkDate">${esc(trk.at.slice(0, 10))}</div>` : ""}</td>
      <td class="colX"><button class="xBtn" data-id="${esc(j.id)}" type="button" title="Elrejtés (Nem érdekel)" aria-label="Elrejtés">✕</button></td>
    </tr>`;
  };

  // Demoted rows always sort last (see cmp above). When any are present in
  // the current result set, a clickable separator splits them from the main
  // list, collapsible so the (usually low-signal) block can be skipped
  // entirely without losing the count.
  let bodyHtml = "";
  if (firstDemotedIdx !== -1) {
    const counts = {};
    out.forEach((j) => { if (j.demoted) counts[j.category] = (counts[j.category] ?? 0) + 1; });
    const label = Object.entries(counts).map(([c, n]) => `${c} (${n})`).join(", ");
    out.forEach((j, i) => {
      if (i === firstDemotedIdx) {
        bodyHtml += `<tr class="demotedSep"><td colspan="20">— Hátrasorolva: ${esc(label)} — ` +
          `<span class="demotedHint">${demotedCollapsed ? "megjelenítés ▾" : "elrejtés ▴"}</span></td></tr>`;
      }
      if (j.demoted && demotedCollapsed) return;
      bodyHtml += rowHtml(j);
    });
  } else {
    bodyHtml = out.map(rowHtml).join("");
  }
  tb.innerHTML = bodyHtml;

  emptyEl.hidden = out.length > 0;
  const postedCount = out.filter((j) => j.salaryPosted).length;
  const freshCount = out.filter((j) => j.freshSinceVisit).length;
  const appliedCount = out.filter((j) => ["applied", "interview", "offer"].includes(trackerStatus(j.id))).length;
  // Counts what is actually hidden, not what is archived — since 2026-08-07 a
  // tracked row can be archived and still on screen (survivesArchiveHide).
  const archHiddenCount = jobs.filter((j) => j.archived && !survivesArchiveHide(j)).length;

  // Stat chips (4a): the three stats that map to an existing filter become
  // clickable toggles, mirroring their header chip's on/off state.
  metaEl.innerHTML =
    (state.inbox ? "Feldolgozandó · " : "") +
    `${out.length} / ${jobs.length} · ` +
    `<button class="chip metaChip${state.posted ? " on" : ""}" data-toggle="posted" type="button">${postedCount} hirdetett bérrel</button>` +
    ` · ${out.filter((j) => j.status !== "Mentett").length} nem mentett` +
    ` · <button class="chip metaChip${state.hideArch ? " on" : ""}" data-toggle="hideArch" type="button">${
      state.hideArch ? `${archHiddenCount} archív rejtve` : "archív is látszik"}</button>` +
    (freshCount > 0 || state.fresh
      ? ` · <button class="chip metaChip${state.fresh ? " on" : ""}" data-toggle="fresh" type="button">${freshCount} új a legutóbbi látogatás óta</button>`
      : "") +
    (appliedCount > 0 ? ` · ${appliedCount} megpályázva` : "");

  updateHash();
}

function wire() {
  qEl.addEventListener("input", render);
  catEl.addEventListener("change", render);
  sortEl.addEventListener("change", render);

  const group = (id, key, attr) => el(id).addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    state[key] = b.dataset[attr];
    el(id).querySelectorAll(".chip").forEach((o) => o.classList.toggle("on", o === b));
    render();
  });
  group("stGrp", "st", "st");
  el("inboxGrp").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    state.inbox = b.dataset.inbox === "1";
    if (state.inbox) { state.savedOnly = false; state.appliedOnly = false; }
    syncChipClasses();
    render();
  });
  group("srcGrp", "src", "src");

  const toggle = (id, key) => el(id).addEventListener("click", () => {
    state[key] = !state[key];
    el(id).classList.toggle("on", state[key]);
    render();
  });
  // Verdict filters need the full chip re-sync: they also move the inbox group.
  const verdictToggle = (id, key) => el(id).addEventListener("click", () => {
    state[key] = !state[key];
    exclusiveTrackerFilters(state);
    syncChipClasses();
    render();
  });
  toggle("postedBtn", "posted");
  toggle("freshBtn", "fresh");
  toggle("archBtn", "hideArch");
  toggle("priorityBtn", "priorityOnly");
  verdictToggle("appliedBtn", "appliedOnly");
  verdictToggle("savedBtn", "savedOnly");
  toggle("hideIgnoredBtn", "hideIgnored");

  // Header stat chips (4a): same posted/hideArch/fresh keys as the toggle()
  // buttons above, so re-sync those buttons' "on" class too (render() only
  // rebuilds metaEl's own chips from state, not the header ones).
  metaEl.addEventListener("click", (e) => {
    const b = e.target.closest(".metaChip");
    if (!b) return;
    state[b.dataset.toggle] = !state[b.dataset.toggle];
    syncChipClasses();
    render();
  });

  // Salary-distribution rows (4d): click a category's bar to filter to it.
  el("distBody").addEventListener("click", (e) => {
    const row = e.target.closest(".distRow");
    if (!row) return;
    catEl.value = row.dataset.cat;
    render();
  });

  // per-row tracker status select (event delegation, rows are re-rendered often)
  tb.addEventListener("change", (e) => {
    const sel = e.target.closest(".trkSel");
    if (!sel) return;
    setTracker(sel.dataset.id, sel.value);
    render();
  });

  // per-row click delegation (event delegation, rows are re-rendered often):
  // ✕ hide button, and tap-to-expand on the clamped mobile description.
  tb.addEventListener("click", (e) => {
    const x = e.target.closest(".xBtn");
    if (x) { hideJob(x.dataset.id); return; }
    const desc = e.target.closest("td.desc");
    if (desc) { desc.classList.toggle("expanded"); return; }
    const sep = e.target.closest(".demotedSep");
    if (sep) { demotedCollapsed = !demotedCollapsed; render(); return; }
  });

  el("snackbarUndo").addEventListener("click", () => {
    if (snackbarUndo) snackbarUndo();
    hideSnackbar();
  });

  // Desktop keyboard shortcuts. Ignored while typing in a form field so they
  // don't fight with search/select input.
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "j") { e.preventDefault(); moveCursor(1); }
    else if (e.key === "k") { e.preventDefault(); moveCursor(-1); }
    else if (e.key === "x") { if (cursorId) hideJob(cursorId); }
    else if (e.key === "s") { if (cursorId) { setTracker(cursorId, "saved"); render(); } }
    else if (e.key === "Enter") {
      const job = renderedJobs.find((j) => j.id === cursorId);
      if (job) window.open(job.url, "_blank", "noopener");
    }
  });

  el("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(tracker, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jobs-tracker-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  el("importInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const clean = sanitizeTrackerImport(raw);
      if (!clean) throw new Error("invalid tracker file shape");
      tracker = mergeTracker(tracker, clean);
      saveTracker();
      pushTracker();
      render();
    } catch (err) {
      alert("Érvénytelen fájl formátum, az importálás nem sikerült.");
    }
  });
}

// Keeps --hdrH (see styles.css thead th) equal to the sticky header's real
// height, so the sticky table header docks directly under it instead of
// being covered. The mobile media query hides thead entirely, so this is
// effectively a desktop-only concern even though it runs unconditionally.
function updateHeaderHeightVar() {
  const header = document.querySelector("header");
  if (header) document.documentElement.style.setProperty("--hdrH", header.offsetHeight + "px");
}

async function boot() {
  try {
    const r = await fetch("/data/jobs.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const doc = await r.json();
    jobs = (doc.jobs ?? []).map(decorate);

    [...new Set(jobs.map((j) => j.category))].sort((a, b) => a.localeCompare(b, "hu"))
      .forEach((c) => catEl.add(new Option(c, c)));

    loadTracker();
    computeFreshSinceVisit();
    applyHashToUI(); // restore filter state from URL hash before first render
    wire();
    render();
    renderSalaryDist();
    updateHeaderHeightVar();
    addEventListener("resize", updateHeaderHeightVar);

    // Sync after the first paint, never instead of it: the dashboard renders
    // from the local cache immediately and corrects itself when the server
    // copy arrives (offline = the pre-sync behavior, silently).
    pullTracker().then((changed) => { if (changed) render(); });

    const gen = doc.generatedAt ? new Date(doc.generatedAt) : null;
    if (gen) {
      const stale = (Date.now() - gen.getTime()) / 3600000 > REFRESH_STALE_HOURS;
      document.title = `Álláslista (${jobs.length})`;
      metaEl.title = "Utolsó frissítés: " + gen.toLocaleString("hu-HU") + (stale ? " — több mint 26 órája" : "");
      // insertAdjacentHTML, not textContent +=: render() now puts chip
      // buttons in metaEl, and textContent would flatten them to plain text.
      if (stale) metaEl.insertAdjacentHTML("beforeend", " · ⚠ az adat több mint 26 órás");
    }
  } catch (err) {
    metaEl.textContent = "Nem sikerült betölteni az adatot: " + err.message;
    console.error(err);
  }

  // Independent of jobs.json; absent files / errors are silent.
  Promise.all([loadWebVersion(), loadRunNote()]).then(([web, note]) => renderVersions(web, note));
}

boot();

/* ---- mobile header: collapsible filters + hide-on-scroll (2026-07-29) ----
   The sticky header's three control rows covered half the phone viewport.
   On <=820px the filters start collapsed behind the "Szűrők" button, and
   the whole header slides away while scrolling down, returning as soon as
   the user scrolls up. Desktop behaviour is untouched (the media query in
   styles.css keeps .filtersBtn hidden and the controls always visible). */
(() => {
  const header = document.querySelector("header");
  const btn = document.getElementById("filtersBtn");
  if (!header || !btn) return;

  btn.addEventListener("click", () => {
    const open = header.classList.toggle("filtersOpen");
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Szűrők ▴" : "Szűrők ▾";
  });

  const mq = matchMedia("(max-width:820px)");
  let lastY = 0, ticking = false;
  const THRESHOLD = 8;   // px of scroll delta before reacting (touch jitter)
  const MIN_Y = 80;      // never hide near the very top

  addEventListener("scroll", () => {
    if (!mq.matches || ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = Math.max(0, scrollY); // iOS overscroll reports negative values
      if (y > lastY + THRESHOLD && y > MIN_Y) {
        header.classList.add("hdr-hidden");
        // an open filter panel scrolling away would strand the user
        header.classList.remove("filtersOpen");
        btn.setAttribute("aria-expanded", "false");
        btn.textContent = "Szűrők ▾";
      } else if (y < lastY - THRESHOLD) {
        header.classList.remove("hdr-hidden");
      }
      lastY = y;
      ticking = false;
    });
  }, { passive: true });

  // leaving mobile width: make sure the header is visible again
  mq.addEventListener?.("change", (e) => {
    if (!e.matches) header.classList.remove("hdr-hidden", "filtersOpen");
  });
})();
