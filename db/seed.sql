-- The building's setup (D006, D041). Safe to run again: existing rows are left alone,
-- so a changed expected PPH or a deactivated line is not overwritten.

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('expected_pph.North', '275'),
  ('expected_pph.Wings', '350'),
  ('expected_pph.Unload', '550');

-- Unload: PS 1-14, no PS 13 (13 lines)
INSERT OR IGNORE INTO line (id, type, grp, number) VALUES
  ('PS1', 'PS', 'Unload', 1),
  ('PS2', 'PS', 'Unload', 2),
  ('PS3', 'PS', 'Unload', 3),
  ('PS4', 'PS', 'Unload', 4),
  ('PS5', 'PS', 'Unload', 5),
  ('PS6', 'PS', 'Unload', 6),
  ('PS7', 'PS', 'Unload', 7),
  ('PS8', 'PS', 'Unload', 8),
  ('PS9', 'PS', 'Unload', 9),
  ('PS10', 'PS', 'Unload', 10),
  ('PS11', 'PS', 'Unload', 11),
  ('PS12', 'PS', 'Unload', 12),
  ('PS14', 'PS', 'Unload', 14);

-- North: PD 1-5 and 14 (6 lines)
INSERT OR IGNORE INTO line (id, type, grp, number) VALUES
  ('PD1', 'PD', 'North', 1),
  ('PD2', 'PD', 'North', 2),
  ('PD3', 'PD', 'North', 3),
  ('PD4', 'PD', 'North', 4),
  ('PD5', 'PD', 'North', 5),
  ('PD14', 'PD', 'North', 14);

-- Wings: PD 6-13 (8 lines)
INSERT OR IGNORE INTO line (id, type, grp, number) VALUES
  ('PD6', 'PD', 'Wings', 6),
  ('PD7', 'PD', 'Wings', 7),
  ('PD8', 'PD', 'Wings', 8),
  ('PD9', 'PD', 'Wings', 9),
  ('PD10', 'PD', 'Wings', 10),
  ('PD11', 'PD', 'Wings', 11),
  ('PD12', 'PD', 'Wings', 12),
  ('PD13', 'PD', 'Wings', 13);
