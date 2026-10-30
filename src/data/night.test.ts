import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { d1Shim } from '../../db/d1-shim.ts';
import { migrate, openDb, seed } from '../../db/lib.ts';
import { effectiveness, expectedPph, hours, pph, planHours, round, volume, type Entry } from '../scoring/index.ts';
import { MAX_HOURS, ValidationError, getNightTotals, listActiveLines, saveNightTotals, type NightRow } from './night.ts';

const setup = () => {
  const sqlite = openDb(':memory:');
  migrate(sqlite);
  seed(sqlite);
  return { sqlite, db: d1Shim(sqlite) };
};

const rowsOf = (sqlite: DatabaseSync, make: (id: string, i: number) => Partial<NightRow>): NightRow[] =>
  (sqlite.prepare('SELECT id FROM line ORDER BY type DESC, number').all() as { id: string }[]).map((l, i) => ({
    lineId: l.id,
    hours: null,
    volume: null,
    ...make(l.id, i),
  }));

const count = (sqlite: DatabaseSync, sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
const base = { date: '2026-10-26', sort: 'Afternoon', actor: 'admin' };
const NOW = new Date('2026-10-27T03:00:00Z');

async function rejects(db: D1Database, input: Parameters<typeof saveNightTotals>[1]) {
  try {
    await saveNightTotals(db, input, NOW);
  } catch (err) {
    assert.ok(err instanceof ValidationError, `expected a ValidationError, got ${err}`);
    return err.errors;
  }
  assert.fail('expected the save to be refused');
}

test('a full night of 27 lines saves one final per line and closes the sort (D065)', async () => {
  const { sqlite, db } = setup();
  const result = await saveNightTotals(db, { ...base, rows: rowsOf(sqlite, () => ({ hours: 10, volume: 4000 })) }, NOW);
  assert.deepEqual({ ...result, shiftId: undefined }, { shiftId: undefined, created: 27, updated: 0, unchanged: 0, skipped: 0 });
  assert.equal(count(sqlite, "SELECT count(*) AS n FROM entry WHERE kind = 'final' AND supervisor_id IS NULL"), 27);
  assert.equal(count(sqlite, "SELECT count(*) AS n FROM shift WHERE status = 'final'"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS n FROM audit_log WHERE action = 'night totals saved' AND actor = 'admin'"), 27);
});

test('the saved totals give the right numbers through the formulas', async () => {
  const { sqlite, db } = setup();
  await saveNightTotals(db, { ...base, rows: rowsOf(sqlite, (id) => (id === 'PS1' ? { hours: 20, volume: 9647 } : {})) }, NOW);
  const r = sqlite.prepare("SELECT slot, kind, headcount, running_volume, total_hours FROM entry WHERE line_id = 'PS1'").all() as Record<string, number | string | null>[];
  const entries: Entry[] = r.map((e) => ({
    kind: e.kind as Entry['kind'],
    slot: e.slot as number | null,
    headcount: e.headcount as number | null,
    runningVolume: e.running_volume as number | null,
    totalHours: e.total_hours as number | null,
  }));
  const settings = { 'expected_pph.Unload': 550 };
  const expected = expectedPph({ group: 'Unload', expectedPphOverride: null }, settings);
  assert.equal(hours(entries), 20);
  assert.equal(volume(entries), 9647);
  assert.equal(round(planHours(9647, expected)), 17.54);
  assert.equal(round(effectiveness(pph(volume(entries), hours(entries)), expected), 1), 87.7);
});

test('blank rows are skipped and typed-in strings from a form work', async () => {
  const { sqlite, db } = setup();
  const rows = rowsOf(sqlite, (id) => {
    if (id === 'PS1') return { hours: '12.5' as unknown as number, volume: '6800' as unknown as number };
    if (id === 'PD1') return { hours: 8, volume: 2100 };
    if (id === 'PD2') return { hours: '' as unknown as number, volume: '  ' as unknown as number };
    return {};
  });
  const result = await saveNightTotals(db, { ...base, rows }, NOW);
  assert.equal(result.created, 2);
  assert.equal(result.skipped, 25);
  assert.equal(count(sqlite, 'SELECT count(*) AS n FROM entry'), 2);
  const ps1 = sqlite.prepare("SELECT total_hours AS h, running_volume AS v FROM entry WHERE line_id = 'PS1'").get() as { h: number; v: number };
  assert.deepEqual({ ...ps1 }, { h: 12.5, v: 6800 });
});

test('a row with only one of hours and volume refuses the whole save, and nothing is written', async () => {
  const { sqlite, db } = setup();
  const rows = rowsOf(sqlite, (id) => (id === 'PS1' ? { hours: 10, volume: 4000 } : id === 'PS2' ? { hours: 10, volume: null } : {}));
  const errors = await rejects(db, { ...base, rows });
  assert.deepEqual(errors, [{ lineId: 'PS2', message: 'Enter both hours and volume, or leave both blank.' }]);
  assert.equal(count(sqlite, 'SELECT count(*) AS n FROM entry'), 0);
  assert.equal(count(sqlite, 'SELECT count(*) AS n FROM shift'), 0);
  assert.equal(count(sqlite, 'SELECT count(*) AS n FROM audit_log'), 0);
});

test('bad input is refused with a message for each problem', async () => {
  const { sqlite, db } = setup();
  const good = { hours: 10, volume: 4000 };
  const one = (lineId: string, fields: Partial<NightRow>): NightRow[] => [{ lineId, hours: 10, volume: 4000, ...fields }];

  assert.match((await rejects(db, { ...base, rows: one('PS13', good) }))[0].message, /Unknown or inactive/);
  assert.match((await rejects(db, { ...base, rows: one('PS1', { hours: -1 }) }))[0].message, /Hours must be/);
  assert.match((await rejects(db, { ...base, rows: one('PS1', { hours: MAX_HOURS + 1 }) }))[0].message, /Hours must be/);
  assert.match((await rejects(db, { ...base, rows: one('PS1', { hours: 'abc' as unknown as number }) }))[0].message, /Hours must be/);
  assert.match((await rejects(db, { ...base, rows: one('PS1', { volume: 12.5 }) }))[0].message, /Volume must be a whole number/);
  assert.match((await rejects(db, { ...base, rows: one('PS1', { volume: -5 }) }))[0].message, /Volume must be/);
  assert.match((await rejects(db, { ...base, date: '2026-02-30', rows: one('PS1', good) }))[0].message, /real date/);
  assert.match((await rejects(db, { ...base, date: '10/26/2026', rows: one('PS1', good) }))[0].message, /real date/);
  assert.match((await rejects(db, { ...base, sort: 'Night', rows: one('PS1', good) }))[0].message, /Afternoon, Morning or Twilight/);
  assert.match((await rejects(db, { ...base, rows: [...one('PS1', good), ...one('PS1', good)] }))[0].message, /twice/);
  assert.match((await rejects(db, { ...base, rows: rowsOf(sqlite, () => ({})) }))[0].message, /every row is blank/);

  sqlite.prepare("UPDATE line SET active = 0 WHERE id = 'PD2'").run();
  assert.match((await rejects(db, { ...base, rows: one('PD2', good) }))[0].message, /Unknown or inactive/);

  // all of the above together report every problem at once
  const many = await rejects(db, { ...base, rows: [...one('PS1', { hours: -1 }), ...one('PS2', { volume: 1.5 })] });
  assert.deepEqual(many.map((e) => e.lineId), ['PS1', 'PS2']);
  assert.equal(count(sqlite, 'SELECT count(*) AS n FROM entry'), 0);
});

test('saving the same night again replaces the totals and the audit log keeps the old ones', async () => {
  const { sqlite, db } = setup();
  const first = rowsOf(sqlite, (id) => (['PS1', 'PS2', 'PD1'].includes(id) ? { hours: 10, volume: 4000 } : {}));
  await saveNightTotals(db, { ...base, rows: first }, NOW);

  const later = new Date('2026-10-27T04:00:00Z');
  const second = rowsOf(sqlite, (id) => (id === 'PS1' ? { hours: 11, volume: 4200 } : ['PS2', 'PD1'].includes(id) ? { hours: 10, volume: 4000 } : {}));
  const result = await saveNightTotals(db, { ...base, actor: 'admin', rows: second }, later);
  assert.deepEqual({ created: result.created, updated: result.updated, unchanged: result.unchanged }, { created: 0, updated: 1, unchanged: 2 });

  assert.equal(count(sqlite, 'SELECT count(*) AS n FROM entry'), 3);
  const ps1 = sqlite.prepare("SELECT total_hours AS h, running_volume AS v FROM entry WHERE line_id = 'PS1'").get() as { h: number; v: number };
  assert.deepEqual({ ...ps1 }, { h: 11, v: 4200 });

  const audit = sqlite.prepare("SELECT before, after FROM audit_log WHERE action = 'night totals changed'").all() as { before: string; after: string }[];
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].before), { line: 'PS1', date: '2026-10-26', sort: 'Afternoon', hours: 10, volume: 4000 });
  assert.deepEqual(JSON.parse(audit[0].after), { line: 'PS1', date: '2026-10-26', sort: 'Afternoon', hours: 11, volume: 4200 });
});

test('saving identical totals again writes nothing new', async () => {
  const { sqlite, db } = setup();
  const rows = rowsOf(sqlite, (id) => (id === 'PS1' ? { hours: 10, volume: 4000 } : {}));
  await saveNightTotals(db, { ...base, rows }, NOW);
  const result = await saveNightTotals(db, { ...base, rows }, new Date('2026-10-27T05:00:00Z'));
  assert.deepEqual({ created: result.created, updated: result.updated, unchanged: result.unchanged }, { created: 0, updated: 0, unchanged: 1 });
  assert.equal(count(sqlite, 'SELECT count(*) AS n FROM audit_log'), 1);
  assert.equal((sqlite.prepare('SELECT created_at AS t FROM entry').get() as { t: string }).t, NOW.toISOString());
});

test('totals typed after a phone night take over the hours, and the 15-minute entries stay', async () => {
  const { sqlite, db } = setup();
  sqlite.exec("INSERT INTO shift (date, sort) VALUES ('2026-10-26', 'Afternoon')");
  for (let k = 0; k < 4; k += 1) {
    sqlite.exec(
      `INSERT INTO entry (shift_id, line_id, slot, kind, headcount, running_volume, created_at)
       VALUES (1, 'PS1', ${1000 + k}, 'interval', 5, ${100 * (k + 1)}, '2026-10-26T20:15:00Z')`,
    );
  }
  assert.equal((sqlite.prepare("SELECT status FROM shift WHERE id = 1").get() as { status: string }).status, 'open');

  const result = await saveNightTotals(db, { ...base, rows: rowsOf(sqlite, (id) => (id === 'PS1' ? { hours: 6, volume: 900 } : {})) }, NOW);
  assert.equal(result.shiftId, 1);
  assert.equal((sqlite.prepare("SELECT status FROM shift WHERE id = 1").get() as { status: string }).status, 'final');
  assert.equal(count(sqlite, "SELECT count(*) AS n FROM entry WHERE kind = 'interval'"), 4);

  const entries = (sqlite.prepare("SELECT slot, kind, headcount, running_volume, total_hours FROM entry WHERE line_id = 'PS1'").all() as Record<string, number | string | null>[]).map(
    (e): Entry => ({ kind: e.kind as Entry['kind'], slot: e.slot as number | null, headcount: e.headcount as number | null, runningVolume: e.running_volume as number | null, totalHours: e.total_hours as number | null }),
  );
  assert.equal(hours(entries), 6); // not 5 people x 4 quarter hours = 5
  assert.equal(volume(entries), 900);
});

test('a full-timer saving for themselves is recorded, and an admin correction keeps that name on the entry', async () => {
  const { sqlite, db } = setup();
  sqlite.exec("INSERT INTO supervisor (full_name, pin_hash, role) VALUES ('Sample Supervisor 01', 'x', 'full_time')");
  const rows = rowsOf(sqlite, (id) => (id === 'PS1' ? { hours: 10, volume: 4000 } : {}));
  await saveNightTotals(db, { ...base, actor: 'Sample Supervisor 01', supervisorId: 1, rows }, NOW);
  assert.equal((sqlite.prepare("SELECT supervisor_id AS s FROM entry WHERE line_id = 'PS1'").get() as { s: number }).s, 1);

  const fix = rowsOf(sqlite, (id) => (id === 'PS1' ? { hours: 9.5, volume: 4000 } : {}));
  await saveNightTotals(db, { ...base, actor: 'admin', rows: fix }, new Date('2026-10-27T06:00:00Z'));
  const entry = sqlite.prepare("SELECT supervisor_id AS s, total_hours AS h FROM entry WHERE line_id = 'PS1'").get() as { s: number; h: number };
  assert.deepEqual({ ...entry }, { s: 1, h: 9.5 });
  assert.equal(count(sqlite, "SELECT count(*) AS n FROM audit_log WHERE actor = 'admin' AND action = 'night totals changed'"), 1);
});

test('active lines come in screen order: PS then PD, by number, without inactive ones', async () => {
  const { sqlite, db } = setup();
  const ids = (await listActiveLines(db)).map((l) => l.id);
  assert.equal(ids.length, 27);
  assert.deepEqual(ids.slice(0, 3), ['PS1', 'PS2', 'PS3']);
  assert.equal(ids[12], 'PS14');
  assert.equal(ids[13], 'PD1');
  assert.equal(ids[26], 'PD14');
  assert.ok(!ids.includes('PS13'));
  sqlite.prepare("UPDATE line SET active = 0 WHERE id = 'PD2'").run();
  assert.equal((await listActiveLines(db)).length, 26);
});

test('a saved night reads back for correcting, including hours worked out from 15-minute entries', async () => {
  const { sqlite, db } = setup();
  await saveNightTotals(db, { ...base, rows: rowsOf(sqlite, (id) => (id === 'PS1' ? { hours: 12.5, volume: 6800 } : {})) }, NOW);
  // PD1 ran the phone flow: four quarter hours of 4 people, then a final update with no total hours
  const firstSlot = Date.parse('2026-10-26T20:15:00Z') / (15 * 60 * 1000);
  for (let k = 0; k < 4; k += 1) {
    sqlite.exec(`INSERT INTO entry (shift_id, line_id, slot, kind, headcount, running_volume, created_at)
                 VALUES (1, 'PD1', ${firstSlot + k}, 'interval', 4, ${100 * (k + 1)}, '2026-10-26T20:15:00Z')`);
  }
  sqlite.exec(`INSERT INTO entry (shift_id, line_id, kind, running_volume, created_at) VALUES (1, 'PD1', 'final', 450, '2026-10-26T21:05:00Z')`);

  assert.deepEqual(await getNightTotals(db, '2026-10-26', 'Afternoon'), [
    { lineId: 'PD1', hours: 4, volume: 450 },
    { lineId: 'PS1', hours: 12.5, volume: 6800 },
  ]);
  assert.deepEqual(await getNightTotals(db, '2026-10-26', 'Twilight'), []);
});
