import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { migrate, openDb, seed } from './lib.ts';
import { fakeNights, weekdaysBack } from './fake-nights.ts';
import {
  effectiveness,
  expectedPph,
  hours,
  onTimePercent,
  pph,
  sortStartMs,
  volume,
  type Entry,
} from '../src/scoring/index.ts';

const fresh = (): DatabaseSync => {
  const db = openDb(':memory:');
  migrate(db);
  return db;
};

const seeded = (): DatabaseSync => {
  const db = fresh();
  seed(db);
  return db;
};

const all = (db: DatabaseSync, sql: string, ...params: (string | number)[]) =>
  db.prepare(sql).all(...params) as Record<string, unknown>[];
const one = (db: DatabaseSync, sql: string, ...params: (string | number)[]) =>
  db.prepare(sql).get(...params) as Record<string, unknown>;

test('migration creates the 9 tables and applies only once', () => {
  const db = openDb(':memory:');
  assert.deepEqual(migrate(db), ['0001_init.sql']);
  const tables = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY name").map(
    (r) => r.name,
  );
  assert.deepEqual(tables, [
    'assignment',
    'audit_log',
    'entry',
    'entry_metric',
    'line',
    'session',
    'settings',
    'shift',
    'supervisor',
  ]);
  assert.deepEqual(migrate(db), []);
});

test('seed loads 27 lines in 3 groups, with no PS 13', () => {
  const db = seeded();
  assert.equal(one(db, 'SELECT count(*) AS n FROM line').n, 27);
  assert.equal(one(db, "SELECT count(*) AS n FROM line WHERE type = 'PS'").n, 13);
  assert.equal(one(db, "SELECT count(*) AS n FROM line WHERE type = 'PD'").n, 14);
  assert.equal(one(db, "SELECT count(*) AS n FROM line WHERE id = 'PS13'").n, 0);
  const groups = Object.fromEntries(all(db, 'SELECT grp, count(*) AS n FROM line GROUP BY grp').map((r) => [r.grp, r.n]));
  assert.deepEqual(groups, { North: 6, Unload: 13, Wings: 8 });
  const north = all(db, "SELECT id FROM line WHERE grp = 'North' ORDER BY number").map((r) => r.id);
  assert.deepEqual(north, ['PD1', 'PD2', 'PD3', 'PD4', 'PD5', 'PD14']);
  const wings = all(db, "SELECT id FROM line WHERE grp = 'Wings' ORDER BY number").map((r) => r.id);
  assert.deepEqual(wings, ['PD6', 'PD7', 'PD8', 'PD9', 'PD10', 'PD11', 'PD12', 'PD13']);
});

test('seed sets expected PPH 275 / 350 / 550 by group', () => {
  const db = seeded();
  const settings = Object.fromEntries(all(db, 'SELECT key, value FROM settings').map((r) => [r.key, Number(r.value)]));
  assert.deepEqual(settings, { 'expected_pph.North': 275, 'expected_pph.Wings': 350, 'expected_pph.Unload': 550 });
  assert.equal(expectedPph({ group: 'Wings', expectedPphOverride: null }, settings), 350);
});

test('running the seed again changes nothing, and keeps a manager change', () => {
  const db = seeded();
  const dump = () => JSON.stringify([all(db, 'SELECT * FROM settings ORDER BY key'), all(db, 'SELECT * FROM line ORDER BY id')]);
  const before = dump();
  seed(db);
  assert.equal(dump(), before);

  db.prepare("UPDATE settings SET value = '300' WHERE key = 'expected_pph.North'").run();
  db.prepare("UPDATE line SET active = 0 WHERE id = 'PD2'").run();
  seed(db);
  assert.equal(one(db, "SELECT value FROM settings WHERE key = 'expected_pph.North'").value, '300');
  assert.equal(one(db, "SELECT active FROM line WHERE id = 'PD2'").active, 0);
});

test('the tables refuse bad data', () => {
  const db = seeded();
  db.exec("INSERT INTO supervisor (full_name, pin_hash, role) VALUES ('Sample Person', 'x', 'part_time')");
  db.exec("INSERT INTO shift (date, sort) VALUES ('2026-10-26', 'Afternoon')");

  assert.throws(() => db.exec("INSERT INTO supervisor (full_name, pin_hash, role) VALUES ('Other', 'x', 'manager')"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO supervisor (full_name, pin_hash, role) VALUES ('sample person', 'x', 'full_time')"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO shift (date, sort) VALUES ('2026-10-26', 'Night')"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO shift (date, sort) VALUES ('2026-10-26', 'Afternoon')"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO line (id, type, grp, number) VALUES ('PX1', 'PX', 'North', 1)"), /CHECK/);

  const interval = (slot: number, headcount: string, volume: string) =>
    `INSERT INTO entry (shift_id, line_id, supervisor_id, slot, kind, headcount, running_volume, created_at)
     VALUES (1, 'PS1', 1, ${slot}, 'interval', ${headcount}, ${volume}, '2026-10-26T20:15:00Z')`;
  db.exec(interval(100, '5', '120'));
  assert.throws(() => db.exec(interval(100, '6', '240')), /UNIQUE/); // same quarter hour twice
  assert.throws(() => db.exec(interval(101, 'NULL', '240')), /CHECK/); // interval needs a headcount
  assert.throws(() => db.exec(interval(102, '-1', '240')), /CHECK/);
  assert.throws(() => db.exec(interval(103, '5', 'NULL')), /CHECK/);

  const final = (volume: string) =>
    `INSERT INTO entry (shift_id, line_id, supervisor_id, kind, running_volume, total_hours, created_at)
     VALUES (1, 'PS1', NULL, 'final', ${volume}, 4.5, '2026-10-26T24:00:00Z')`;
  db.exec(final('900'));
  assert.throws(() => db.exec(final('950')), /UNIQUE/); // one final per line per shift
  assert.throws(() => db.exec(final('NULL').replace("'PS1'", "'PS2'")), /CHECK/); // a final needs a volume
});

test('deleting a shift removes its entries and their extra metrics; the audit log takes before and after', () => {
  const db = seeded();
  db.exec("INSERT INTO shift (date, sort) VALUES ('2026-10-26', 'Twilight')");
  db.exec(`INSERT INTO entry (shift_id, line_id, kind, running_volume, total_hours, created_at)
           VALUES (1, 'PD1', 'final', 500, 3, '2026-10-26T22:00:00Z')`);
  db.exec("INSERT INTO entry_metric (entry_id, metric_key, value) VALUES (1, 'missloads', 2)");
  db.exec("INSERT INTO audit_log (at, actor, action, before, after) VALUES ('2026-10-26T22:05:00Z', 'admin', 'edit entry', '500', '510')");
  db.exec('DELETE FROM shift WHERE id = 1');
  assert.equal(one(db, 'SELECT count(*) AS n FROM entry').n, 0);
  assert.equal(one(db, 'SELECT count(*) AS n FROM entry_metric').n, 0);
  assert.equal(one(db, 'SELECT count(*) AS n FROM audit_log').n, 1);
});

test('weekdaysBack skips Saturday and Sunday', () => {
  // 2026-10-26 is a Monday
  assert.deepEqual(weekdaysBack('2026-10-26', 3), ['2026-10-26', '2026-10-23', '2026-10-22']);
  assert.deepEqual(weekdaysBack('2026-10-25', 2), ['2026-10-23', '2026-10-22']);
});

const lineEntries = (db: DatabaseSync, shiftId: number, lineId: string): Entry[] =>
  all(db, 'SELECT slot, kind, headcount, running_volume, total_hours FROM entry WHERE shift_id = ? AND line_id = ?', shiftId, lineId).map(
    (r) => ({
      kind: r.kind as Entry['kind'],
      slot: r.slot as number | null,
      headcount: r.headcount as number | null,
      runningVolume: r.running_volume as number | null,
      totalHours: r.total_hours as number | null,
    }),
  );

test('fake nights fill an Afternoon and a Twilight sort for all 27 lines', () => {
  const db = seeded();
  const result = fakeNights(db, { endDate: '2026-10-26' });
  assert.equal(result.shifts, 2);

  const shifts = all(db, 'SELECT id, sort, status, starts_at, ends_at FROM shift ORDER BY sort');
  assert.deepEqual(shifts.map((s) => s.sort), ['Afternoon', 'Twilight']);
  for (const s of shifts) {
    assert.equal(s.status, 'final');
    assert.equal(one(db, "SELECT count(*) AS n FROM entry WHERE shift_id = ? AND kind = 'final'", s.id as number).n, 27);
    assert.equal(one(db, 'SELECT count(*) AS n FROM assignment WHERE shift_id = ?', s.id as number).n, 27);
    assert.ok(Date.parse(s.ends_at as string) > Date.parse(s.starts_at as string));
    // the stored start follows the sort-start rule (D066) from the first entry
    const first = one(db, "SELECT min(created_at) AS t FROM entry WHERE shift_id = ? AND kind = 'interval'", s.id as number).t as string;
    assert.equal(sortStartMs(Date.parse(first)), Date.parse(s.starts_at as string));
  }
  assert.match(String(one(db, 'SELECT min(full_name) AS n FROM supervisor').n), /^Sample Supervisor/);
});

test('fake nights give realistic numbers when run through the formulas', () => {
  const db = seeded();
  fakeNights(db, { endDate: '2026-10-26' });
  const settings = Object.fromEntries(all(db, 'SELECT key, value FROM settings').map((r) => [r.key, Number(r.value)]));
  const lines = all(db, 'SELECT id, grp FROM line');
  for (const shift of all(db, 'SELECT id FROM shift')) {
    for (const line of lines) {
      const entries = lineEntries(db, shift.id as number, line.id as string);
      const hrs = hours(entries);
      const actual = pph(volume(entries), hrs);
      const eff = effectiveness(actual, expectedPph({ group: line.grp as string, expectedPphOverride: null }, settings));
      assert.ok(hrs > 10 && hrs < 90, `${line.id} hours ${hrs}`);
      assert.ok(eff !== null && eff > 40 && eff < 160, `${line.id} effectiveness ${eff}`);
      const lastSlot = Math.max(...entries.filter((e) => e.kind === 'interval').map((e) => e.slot as number));
      const onTime = onTimePercent(entries, lastSlot) as number;
      assert.ok(onTime >= 60 && onTime <= 100, `${line.id} on-time ${onTime}`);
    }
  }
});

test('fake nights can be run again with the same result, and count weekday nights only', () => {
  const db = seeded();
  const sum = () => one(db, 'SELECT count(*) AS n, sum(running_volume) AS v FROM entry');
  fakeNights(db, { endDate: '2026-10-26', nights: 3 });
  const first = sum();
  assert.equal(one(db, 'SELECT count(*) AS n FROM shift').n, 6);
  const dates = all(db, 'SELECT DISTINCT date FROM shift ORDER BY date').map((r) => r.date);
  assert.deepEqual(dates, ['2026-10-22', '2026-10-23', '2026-10-26']);

  fakeNights(db, { endDate: '2026-10-26', nights: 3 });
  assert.deepEqual(sum(), first);
  assert.equal(one(db, 'SELECT count(*) AS n FROM shift').n, 6);
  assert.equal(one(db, "SELECT count(*) AS n FROM supervisor WHERE full_name LIKE 'Sample Supervisor %'").n, 12);
});
