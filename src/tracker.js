// Tracker sync contract (unchanged from v1): GET returns { [id]: { st, at } },
// PUT replaces the whole map. Storage moved from one KV key to D1
// `jobs-tracker` (migrations/tracker/0001_init.sql) in v2.

// Must match TRACKER_STATUSES in public/app.js and the CHECK in the migration.
export const STATUSES = new Set(["saved", "applied", "interview", "offer", "rejected", "ignored"]);
export const MAX_BYTES = 512 * 1024; // ~5000 entries is <200 KB; anything bigger is garbage

// Same shape check as public/app.js's sanitizeTrackerImport, server-side:
// a malformed PUT must not be able to wedge every device's next sync.
// The result has a null prototype, so an id like "__proto__" is kept as a
// plain key instead of being silently swallowed by Object.prototype's setter.
export function sanitize(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const clean = Object.create(null);
  for (const [id, v] of Object.entries(raw)) {
    if (typeof id !== "string" || id.length > 200) return null;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    if (!STATUSES.has(v.st) || typeof v.at !== "string" || v.at.length > 40) return null;
    clean[id] = { st: v.st, at: v.at };
  }
  return clean;
}

// "Initialised" sentinel (migrations/tracker/0002_meta.sql): the one-off
// v1 → D1 import writes this row last. Until it exists the API answers 503,
// so an empty or half-imported table can never be served as the truth (a
// browser would read "{}" as "everything was deleted on another device").
export const IMPORTED_KEY = "tracker_imported";
export const READY_SQL = "SELECT 1 AS ready FROM meta WHERE key = 'tracker_imported'";

// SQLite builds the response document, so the Worker never parses or
// re-serialises the map (Free-plan CPU). An empty table yields "{}". One
// round trip returns both the sentinel and the document.
export const SELECT_DOC_SQL =
  "SELECT (" + READY_SQL + ") AS ready, " +
  "(SELECT json_group_object(id, json_object('st', st, 'at', at)) FROM tracker) AS doc";

export const DELETE_ALL_SQL = "DELETE FROM tracker";

// One bound parameter: the sanitised map as JSON. json_each over an object
// yields one row per id (key) with the entry as JSON (value).
export const INSERT_FROM_JSON_SQL =
  "INSERT INTO tracker (id, st, at) " +
  "SELECT key, json_extract(value, '$.st'), json_extract(value, '$.at') FROM json_each(?1)";
