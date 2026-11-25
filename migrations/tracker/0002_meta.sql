-- Key/value markers for the tracker database. The v1 -> D1 import inserts
-- ('tracker_imported', <ISO timestamp>) as its last step; until that row
-- exists the Worker answers 503 on GET and PUT /api/tracker.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
