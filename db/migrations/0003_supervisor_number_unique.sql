-- A supervisor's PIN is their ID number (D111), and each number belongs to one person.
-- pin_hash is a keyed hash, so the same number always gives the same hash; this index
-- makes the database refuse a number that is already in use.
CREATE UNIQUE INDEX supervisor_one_per_number ON supervisor (pin_hash);
