-- Failed sign-ins, used to slow down guessing (D107). Rows older than a day are deleted
-- whenever a new failure is written.

CREATE TABLE sign_in_failure (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  who TEXT NOT NULL,                                           -- 'admin', or 'supervisor:<id>' later
  at  TEXT NOT NULL
);

CREATE INDEX sign_in_failure_by_who ON sign_in_failure (who, at);
