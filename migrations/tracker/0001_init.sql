CREATE TABLE tracker (
  id TEXT PRIMARY KEY CHECK (length(id) <= 200),
  st TEXT NOT NULL CHECK (st IN ('saved','applied','interview','offer','rejected','ignored')),
  at TEXT NOT NULL CHECK (length(at) <= 40)
);
