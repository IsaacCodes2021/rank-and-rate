import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { d1Shim } from '../../db/d1-shim.ts';
import { migrate, openDb, seed } from '../../db/lib.ts';
import { ValidationError } from './night.ts';
import { MAX_EXPECTED_PPH, listExpectedPph, saveExpectedPph, type ExpectedRow } from './settings.ts';

const setup = () => {
  const sqlite = openDb(':memory:');
  migrate(sqlite);
  seed(sqlite);
  return { sqlite, db: d1Shim(sqlite) };
};

const AT = new Date('2026-10-30T20:00:00Z');
const save = (db: D1Database, rows: ExpectedRow[]) => saveExpectedPph(db, { rows, actor: 'admin' }, AT);
const twilight = (group: string, expectedPph: ExpectedRow['expectedPph']) => ({ group, sort: 'Twilight', expectedPph });
const auditRows = (sqlite: DatabaseSync) => sqlite.prepare("SELECT at, actor, before, after FROM audit_log WHERE action = 'expected PPH changed'").all() as Record<string, string>[];
const shown = async (db: D1Database) => Object.fromEntries((await listExpectedPph(db)).map((g) => [g.group, g.bySort]));
const SEEDED = {
  Unload: { Afternoon: 550, Morning: 550, Twilight: 550 },
  North: { Afternoon: 275, Morning: 275, Twilight: 275 },
  Wings: { Afternoon: 350, Morning: 350, Twilight: 350 },
};

test('lists each area with its lines, PS then PD, and every sort starts on the default', async () => {
  const { sqlite, db } = setup();
  const groups = await listExpectedPph(db);
  assert.deepEqual(groups.map((g) => [g.group, g.lines.length]), [['Unload', 13], ['North', 6], ['Wings', 8]]);
  assert.deepEqual(groups[1].lines, ['PD1', 'PD2', 'PD3', 'PD4', 'PD5', 'PD14']);
  assert.deepEqual(await shown(db), SEEDED);

  sqlite.prepare("UPDATE line SET active = 0 WHERE id = 'PD2'").run();
  assert.ok(!(await listExpectedPph(db))[1].lines.includes('PD2'));
});

test('a change is saved for that sort only, and the audit log keeps the old and new values', async () => {
  const { sqlite, db } = setup();
  assert.deepEqual(await save(db, [twilight('North', '300')]), { changed: 1, unchanged: 0 });
  assert.deepEqual(await shown(db), { ...SEEDED, North: { Afternoon: 275, Morning: 275, Twilight: 300 } });

  // The default stays as it was, so nothing else moves.
  assert.equal((sqlite.prepare("SELECT value FROM settings WHERE key = 'expected_pph.North'").get() as { value: string }).value, '275');
  assert.equal((sqlite.prepare("SELECT value FROM settings WHERE key = 'expected_pph.Twilight.North'").get() as { value: string }).value, '300');

  const audit = auditRows(sqlite);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].at, AT.toISOString());
  assert.equal(audit[0].actor, 'admin');
  assert.deepEqual(JSON.parse(audit[0].before), { group: 'North', sort: 'Twilight', expectedPph: 275 });
  assert.deepEqual(JSON.parse(audit[0].after), { group: 'North', sort: 'Twilight', expectedPph: 300 });
});

test('a second change replaces the first and the log follows', async () => {
  const { sqlite, db } = setup();
  await save(db, [twilight('North', 300)]);
  await save(db, [twilight('North', 310)]);
  assert.equal((await shown(db)).North.Twilight, 310);
  assert.deepEqual(JSON.parse(auditRows(sqlite)[1].before), { group: 'North', sort: 'Twilight', expectedPph: 300 });
});

test('saving the same value writes nothing', async () => {
  const { sqlite, db } = setup();
  assert.deepEqual(await save(db, [twilight('North', 275), twilight('Wings', '350')]), { changed: 0, unchanged: 2 });
  assert.equal(auditRows(sqlite).length, 0);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'expected_pph.Twilight.%'").get() as { n: number }).n, 0);
});

test('only what changed is written, across areas and sorts', async () => {
  const { sqlite, db } = setup();
  const rows = [{ group: 'Unload', sort: 'Afternoon', expectedPph: 600 }, twilight('North', 275), twilight('Wings', 360)];
  assert.deepEqual(await save(db, rows), { changed: 2, unchanged: 1 });
  const now = await shown(db);
  assert.deepEqual([now.Unload.Afternoon, now.Unload.Twilight, now.North.Twilight, now.Wings.Twilight, now.Wings.Afternoon], [600, 550, 275, 360, 350]);
  assert.equal(auditRows(sqlite).length, 2);
});

test('one bad row saves nothing', async () => {
  for (const bad of [0, -5, 12.5, MAX_EXPECTED_PPH + 1, '', '  ', 'abc', null]) {
    const { sqlite, db } = setup();
    await assert.rejects(save(db, [twilight('Wings', 400), twilight('North', bad)]), (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.errors[0].message, 'Twilight North: expected PPH must be a whole number from 1 to 2000.');
      return true;
    });
    assert.deepEqual(await shown(db), SEEDED);
    assert.equal(auditRows(sqlite).length, 0);
  }
});

test('the limits themselves are allowed', async () => {
  const { db } = setup();
  await save(db, [twilight('North', 1), twilight('Wings', MAX_EXPECTED_PPH)]);
  const now = await shown(db);
  assert.deepEqual([now.North.Twilight, now.Wings.Twilight], [1, 2000]);
});

test('an area or sort that does not exist, or one sent twice, is refused', async () => {
  const { sqlite, db } = setup();
  await assert.rejects(save(db, [twilight('South', 300)]), /That area or sort does not exist/);
  await assert.rejects(save(db, [{ group: 'North', sort: 'Night', expectedPph: 300 }]), /That area or sort does not exist/);
  await assert.rejects(save(db, [twilight('North', 300), twilight('North', 310)]), /Twilight North appears twice/);
  assert.deepEqual(await shown(db), SEEDED);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'expected_pph.%.%'").get() as { n: number }).n, 0);
});
