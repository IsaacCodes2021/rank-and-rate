import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Shim } from './d1-shim.ts';
import { fakeLiveSql } from './fake-live.ts';
import { migrate, openDb, seed } from './lib.ts';
import { loadLiveSort, recentSorts } from '../src/data/live.ts';
import { sortSummary } from '../src/scoring/live.ts';

const NOW = Date.parse('2026-10-30T22:00:00Z');
const TODAY = '2026-10-30';

test('fake live sorts: two open sorts that overlap on the same lines, one with late and finished lines', async () => {
  const sqlite = openDb(':memory:');
  migrate(sqlite);
  seed(sqlite);
  const db = d1Shim(sqlite);
  sqlite.exec(fakeLiveSql(NOW, TODAY));

  const { open } = await recentSorts(db, TODAY);
  assert.deepEqual(open.map((s) => s.sort), ['Twilight', 'Afternoon']);

  const afternoon = (await loadLiveSort(db, open[1].id))!;
  const a = sortSummary(afternoon.lines, NOW, true, Date.parse(afternoon.startsAt!), null);
  assert.equal(a.linesInPlay, 25); // PS14 and PD13 have nobody on them
  assert.equal(a.linesLate, 2);
  assert.equal([...a.numbers.values()].filter((n) => n.hasFinal).length, 9);
  assert.ok(a.PS.effectiveness! > 70 && a.PS.effectiveness! < 130, `PS ${a.PS.effectiveness}`);
  assert.ok(a.PD.effectiveness! > 70 && a.PD.effectiveness! < 130, `PD ${a.PD.effectiveness}`);

  const twilight = (await loadLiveSort(db, open[0].id))!;
  const t = sortSummary(twilight.lines, NOW, true, Date.parse(twilight.startsAt!), null);
  assert.equal(t.linesInPlay, 7);
  assert.equal(t.linesLate, 0);
  assert.ok(t.volume < a.volume / 5);
});

test('fake live sorts can be made again, replacing the last set and nothing else', () => {
  const sqlite = openDb(':memory:');
  migrate(sqlite);
  seed(sqlite);
  sqlite.exec("INSERT INTO shift (date, sort, status) VALUES ('2026-10-29', 'Afternoon', 'final')");
  sqlite.exec(fakeLiveSql(NOW, TODAY));
  const count = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
  const entries = count('SELECT count(*) AS n FROM entry');
  sqlite.exec(fakeLiveSql(NOW, TODAY));
  assert.equal(count('SELECT count(*) AS n FROM entry'), entries);
  assert.equal(count('SELECT count(*) AS n FROM shift'), 3);
  assert.equal(count("SELECT count(*) AS n FROM supervisor WHERE full_name LIKE 'Sample Live %'"), 16);
});
