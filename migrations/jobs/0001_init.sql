-- D1 `jobs-data` schema. Contract: docs/architecture-v2.md ("D1 `jobs-data` schema").
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,                 -- li-<n> | pr-<n> | nfj-<slug> | in-<jobkey>
  role TEXT NOT NULL, company TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('LinkedIn','Profession','NoFluff','Indeed')),
  category TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('Employee','Contract')),
  description TEXT NOT NULL,
  salary_lo INTEGER NOT NULL, salary_hi INTEGER NOT NULL,
  salary_posted INTEGER NOT NULL CHECK (salary_posted IN (0,1)),
  benchmark TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,                -- Mentett | Értesítő | NFJ keresés | Indeed
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,   -- YYYY-MM-DD
  closed TEXT,                         -- YYYY-MM-DD, set once
  repost_of TEXT                       -- id of an owner-ignored twin, shown flagged
);
CREATE TABLE verdicts (                -- the rejection ledger
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,                -- fit:… | tracker:… | dead:… | dedupe:… | legacy
  judge_version TEXT,                  -- set for fit: verdicts written by v2
  at TEXT NOT NULL                     -- ISO timestamp
);
CREATE TABLE streaks (id TEXT PRIMARY KEY, count INTEGER NOT NULL CHECK (count >= 0));
CREATE TABLE runs (
  slot TEXT PRIMARY KEY,               -- 2026-11-25T13:00:00.000Z
  payload_sha256 TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  run_note TEXT NOT NULL,              -- the last-run.json document
  diff TEXT NOT NULL                   -- {added:[ids], removed:[ids], updated:n}
);
CREATE TABLE email_candidates (
  id TEXT PRIMARY KEY,                 -- li-<n>
  received_at TEXT NOT NULL,
  consumed_slot TEXT                   -- set when a run has evaluated it
);
