-- The 9 tables from the data-model tab (D081). Times are UTC ISO-8601 text.
-- Calculated numbers (hours, PPH, effectiveness, plan hours, over/under, on-time %, FPH)
-- are never stored; see src/scoring.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE line (
  id                    TEXT PRIMARY KEY,                      -- PS1 .. PD14
  type                  TEXT NOT NULL CHECK (type IN ('PS', 'PD')),
  grp                   TEXT NOT NULL,                         -- North, Wings or Unload; expected_pph.<grp> lives in settings
  number                INTEGER NOT NULL CHECK (number BETWEEN 1 AND 99),
  active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  expected_pph_override REAL CHECK (expected_pph_override IS NULL OR expected_pph_override > 0),
  UNIQUE (type, number)
);

CREATE TABLE supervisor (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin_hash  TEXT NOT NULL,                                     -- salted hash, never the PIN (D058)
  role      TEXT NOT NULL CHECK (role IN ('part_time', 'full_time')),
  active    INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE shift (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT NOT NULL,                                     -- local date of the sort, YYYY-MM-DD
  sort      TEXT NOT NULL CHECK (sort IN ('Afternoon', 'Morning', 'Twilight')),
  starts_at TEXT,                                              -- set by the first entry (D066); admin can correct
  ends_at   TEXT,                                              -- set by the last final update; admin can correct
  status    TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'final')),
  UNIQUE (date, sort)
);

CREATE TABLE assignment (
  shift_id      INTEGER NOT NULL REFERENCES shift (id) ON DELETE CASCADE,
  line_id       TEXT    NOT NULL REFERENCES line (id),
  supervisor_id INTEGER NOT NULL REFERENCES supervisor (id),
  started_at    TEXT    NOT NULL,
  PRIMARY KEY (shift_id, line_id, supervisor_id)
);

CREATE TABLE session (
  id            TEXT PRIMARY KEY,                              -- hash of the session token, never the token
  supervisor_id INTEGER NOT NULL REFERENCES supervisor (id) ON DELETE CASCADE,
  expires_at    TEXT NOT NULL                                  -- 12 hours after sign-in (D083)
);

CREATE TABLE entry (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id       INTEGER NOT NULL REFERENCES shift (id) ON DELETE CASCADE,
  line_id        TEXT    NOT NULL REFERENCES line (id),
  supervisor_id  INTEGER REFERENCES supervisor (id),           -- empty when the admin types a total (D052)
  slot           INTEGER,                                      -- quarter hours since the Unix epoch; empty on a final entry
  kind           TEXT NOT NULL CHECK (kind IN ('interval', 'final')),
  headcount      INTEGER CHECK (headcount IS NULL OR headcount >= 0),
  running_volume INTEGER CHECK (running_volume IS NULL OR running_volume >= 0),
  total_hours    REAL CHECK (total_hours IS NULL OR total_hours >= 0),
  created_at     TEXT NOT NULL,
  CHECK (kind = 'final' OR (slot IS NOT NULL AND headcount IS NOT NULL AND running_volume IS NOT NULL)),
  CHECK (kind = 'interval' OR running_volume IS NOT NULL)
);

-- One interval per line per quarter hour, and one final per line per shift.
-- A second save replaces the first; the audit log keeps both (D073).
CREATE UNIQUE INDEX entry_one_interval_per_slot ON entry (shift_id, line_id, slot) WHERE kind = 'interval';
CREATE UNIQUE INDEX entry_one_final_per_line ON entry (shift_id, line_id) WHERE kind = 'final';
CREATE INDEX entry_by_supervisor ON entry (supervisor_id);

CREATE TABLE entry_metric (
  entry_id   INTEGER NOT NULL REFERENCES entry (id) ON DELETE CASCADE,
  metric_key TEXT    NOT NULL,
  value      REAL    NOT NULL,
  PRIMARY KEY (entry_id, metric_key)
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  before TEXT,
  after  TEXT
);
