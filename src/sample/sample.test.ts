import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDb, seed } from '../../db/lib.ts';
import { summarize } from '../scoring/index.ts';
import { sortSummary } from '../scoring/live.ts';
import { inRange, periodRange } from '../scoring/periods.ts';
import { createApp, type Env } from '../worker/app.ts';
import { DEFAULT_MOMENT, SAMPLE_LINES, isSampleTime, pacificMs, sampleLineHistory, sampleWorld } from './world.ts';

const TODAY = '2026-10-30'; // a Friday
const NOW = new Date(`${TODAY}T20:00:00Z`);

// Any use of this database fails the test: the sample pages must never touch it.
const NO_DATABASE = new Proxy(
  {},
  {
    get(_, name) {
      throw new Error(`The sample pages touched the database: ${String(name)}`);
    },
  },
) as Env['DB'];

function setup(now: Date = NOW) {
  const app = createApp({ now: () => now });
  const env: Env = { DB: NO_DATABASE };
  return {
    get: (path: string) => app.request(path, {}, env),
    text: async (path: string) => (await app.request(path, {}, env)).text(),
  };
}

const rowOf = (page: string, lineId: string) => {
  const m = page.match(new RegExp(`<tr data-line="${lineId}"[\\s\\S]*?</tr>`));
  assert.ok(m, `no row for ${lineId}`);
  return m[0];
};

test('the sample lines are the real lines with the real expected PPH', () => {
  const db = openDb(':memory:');
  migrate(db);
  seed(db);
  const settings = Object.fromEntries((db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((r) => [r.key, Number(r.value)]));
  const real = (db.prepare('SELECT id, type, grp FROM line ORDER BY type DESC, number').all() as { id: string; type: string; grp: string }[]).map((l) => ({
    id: l.id,
    type: l.type,
    group: l.grp,
    expectedPph: settings[`expected_pph.${l.grp}`],
  }));
  assert.deepEqual(SAMPLE_LINES, real);
});

test('local time turns into the right moment on both sides of the clock change', () => {
  assert.equal(new Date(pacificMs('2026-10-30', '13:15')).toISOString(), '2026-10-30T20:15:00.000Z'); // PDT
  assert.equal(new Date(pacificMs('2026-11-02', '13:15')).toISOString(), '2026-11-02T21:15:00.000Z'); // PST
});

test('every sample page works with no database at all, and says the numbers are made up', async () => {
  const t = setup();
  for (const path of ['/sample', '/sample?at=17:35', '/sample/sort/afternoon', '/sample/sort/twilight?at=20:00', '/sample/ps3', '/sample/pd14?period=last-month']) {
    const res = await t.get(path);
    assert.equal(res.status, 200, path);
    const page = await res.text();
    assert.match(page, /Sample data\.<\/strong> These numbers and names are made up, and nothing here is saved\./, path);
    assert.match(page, /name="viewport"/, path);
    assert.match(page, /name="robots" content="noindex"/, path);
  }
});

test('no real data can reach a sample page: every name is a sample name', async () => {
  const page = await setup().text('/sample');
  const names = [...page.matchAll(/<td class="who hide-narrow">([^<]*)<\/td>/g)].map((m) => m[1]).filter((n) => n !== '-');
  assert.ok(names.length > 20);
  for (const name of names) assert.match(name, /^Sample Supervisor \d\d$/);
});

test('the same day always gives the same numbers, and another day different ones', async () => {
  const first = await setup().text('/sample/ps3');
  const again = await setup().text('/sample/ps3');
  assert.equal(first, again);
  const nextDay = await setup(new Date('2026-11-03T20:00:00Z')).text('/sample/ps3');
  assert.notEqual(first, nextDay);
});

test('/sample shows all the areas, mid-sort by default, in the real live view, with lines linked to their history', async () => {
  const page = await setup().text('/sample');
  assert.match(page, /<title>Sample data<\/title>/);
  assert.match(page, /<h1>Afternoon<\/h1>/);
  assert.equal([...page.matchAll(/<tr data-line="/g)].length, 27);
  assert.match(page, /As of 3:30 PM\./);
  assert.match(page, /href="\/sample\/ps3">PS3<\/a>/);
  assert.match(page, /href="\/sample\/pd14">PD14<\/a>/);
  assert.match(page, /href="\/live">Real site<\/a>/);
  assert.match(page, /data-stop="1"/); // the numbers cannot change, so it does not keep asking
  assert.ok(!page.includes('Refreshes every 30 seconds'));
});

test('mid-sort shows late lines, so people can see what that looks like', async () => {
  const page = await setup().text('/sample');
  assert.match(rowOf(page, 'PS5'), /class="pill late"/);
  assert.match(rowOf(page, 'PD9'), /class="pill late"/);
  assert.match(page, /lines late/);
});

test('the moments walk through the night, with the sorts overlapping and separate', async () => {
  const t = setup();
  const start = sampleWorld(TODAY, '13:45');
  assert.equal(start.sort?.sort, 'Afternoon');
  assert.deepEqual(start.open.map((s) => s.sort), ['Afternoon']);
  assert.equal(start.latestFinished, null);

  const overlap = sampleWorld(TODAY, '17:35');
  assert.deepEqual(overlap.open.map((s) => s.sort), ['Twilight', 'Afternoon']);
  const overlapPage = await t.text('/sample?at=17:35');
  assert.match(overlapPage, /<h1>Twilight<\/h1>/);
  assert.match(overlapPage, /href="\/sample\/sort\/afternoon\?at=17:35"/);
  assert.match(overlapPage, /aria-current="page">Two sorts overlap</);

  // On the Afternoon view some finals are in; on Twilight the same line has only just started.
  const afternoon = await t.text('/sample/sort/afternoon?at=17:35');
  assert.match(afternoon, /<h1>Afternoon<\/h1>/);
  assert.match(afternoon, /class="pill final"/);
  assert.ok(!overlapPage.includes('class="pill final"'));

  const a = sampleWorld(TODAY, '17:35', 'Afternoon').sort!;
  const b = sampleWorld(TODAY, '17:35', 'Twilight').sort!;
  assert.ok(sortSummary(b.lines, pacificMs(TODAY, '17:35'), true, null, null).volume < sortSummary(a.lines, pacificMs(TODAY, '17:35'), true, null, null).volume / 5);

  const finished = sampleWorld(TODAY, '23:00');
  assert.deepEqual(finished.open, []);
  assert.equal(finished.latestFinished?.sort, 'Twilight');
  assert.match(await t.text('/sample?at=23:00'), /finished \d+:\d\d PM/);
});

test('a bad time falls back to mid-sort, and a time is only taken inside the night', async () => {
  const t = setup();
  for (const at of ['nonsense', '25:00', '09:00', '13:60', '<script>']) {
    assert.equal(isSampleTime(at), false, at);
    const page = await t.text(`/sample?at=${encodeURIComponent(at)}`);
    assert.match(page, /As of 3:30 PM\./, at);
    assert.ok(!page.includes('<script>alert'), at);
  }
  assert.equal(isSampleTime('13:00'), true);
  assert.equal(isSampleTime('23:59'), true);
  assert.equal(DEFAULT_MOMENT, '15:30');
});

test('sample numbers are realistic when run through the real formulas', () => {
  const world = sampleWorld(TODAY, '17:10', 'Afternoon');
  const s = sortSummary(world.sort!.lines, pacificMs(TODAY, '17:10'), true, Date.parse(world.sort!.startsAt!), null);
  for (const totals of [s.PS, s.PD]) {
    assert.ok(totals.effectiveness! > 80 && totals.effectiveness! < 125, String(totals.effectiveness));
    assert.ok(totals.linesInPlay >= 8);
  }
  for (const line of SAMPLE_LINES) {
    for (const row of sampleLineHistory(line.id, TODAY)) {
      assert.ok(row.effectiveness !== null && row.effectiveness > 60 && row.effectiveness < 140, `${line.id} ${row.date} ${row.effectiveness}`);
      assert.ok(row.hours > 5 && row.hours < 90, `${line.id} ${row.date} hours ${row.hours}`);
      assert.ok(row.onTime !== null && row.onTime >= 40 && row.onTime <= 100, `${line.id} ${row.date} on time ${row.onTime}`);
    }
  }
});

test('history: eight weeks of finished sorts, never tonight, split by sort, newest first', () => {
  const rows = sampleLineHistory('PS3', TODAY);
  const dates = [...new Set(rows.map((r) => r.date))];
  assert.equal(dates.length, 40);
  assert.equal(dates[0], '2026-10-29');
  assert.ok(!dates.includes(TODAY));
  for (const date of dates) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    assert.ok(day !== 0 && day !== 6, date);
  }
  assert.deepEqual([...dates], [...dates].sort().reverse());
  assert.ok(rows.some((r) => r.sort === 'Afternoon'));
  assert.ok(rows.some((r) => r.sort === 'Twilight'));
  assert.ok(rows.length > 60);
});

test('supervisors move between lines over the weeks (D012)', () => {
  assert.ok(new Set(sampleLineHistory('PS3', TODAY).flatMap((r) => r.supervisors)).size > 3);
});

test('/sample/ps3: the totals are the rows added up with the real period formula (D105)', async () => {
  const t = setup();
  const page = await t.text('/sample/ps3');
  assert.match(page, /<title>PS3 history<\/title>/);
  assert.match(page, /<h1>PS3<\/h1>/);
  assert.match(page, /Unload · expected 550 PPH/);
  assert.match(page, /href="\/sample">All areas<\/a>/);

  const rows = sampleLineHistory('PS3', TODAY);
  assert.equal([...page.matchAll(/<tr data-night="/g)].length, rows.length);
  const totals = summarize(rows.map((r) => ({ hours: r.hours, volume: r.volume, expectedPph: 550 })));
  assert.match(page, new RegExp(`<div class="value">${Math.round(totals.pph!).toLocaleString('en-US')}</div>`));
  assert.match(page, new RegExp(`<strong>${Math.round(totals.effectiveness!)}% effective</strong>`));
  assert.match(page, new RegExp(`<div class="value">${Math.round(totals.volume).toLocaleString('en-US')}</div>`));
  assert.match(page, new RegExp(`${rows.length} sorts`));
});

test('/sample/pd3 and /sample/pd9 show their own group and expected PPH', async () => {
  const t = setup();
  assert.match(await t.text('/sample/pd3'), /Load, North · expected 275 PPH/);
  assert.match(await t.text('/sample/pd9'), /Load, Wings · expected 350 PPH/);
});

test('the address can be any case, and anything that is not one of the 27 lines goes back to /sample', async () => {
  const t = setup();
  assert.match(await t.text('/sample/PS3'), /<h1>PS3<\/h1>/);
  for (const path of ['/sample/ps13', '/sample/ps99', '/sample/pd0', '/sample/nope', '/sample/sort/night']) {
    const res = await t.get(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), '/sample');
  }
});

test('the period filters limit the rows, the totals and the chart', async () => {
  const t = setup();
  const lastWeek = await t.text('/sample/ps3?period=last-week');
  assert.match(lastWeek, /aria-current="page">Last week</);
  const expected = sampleLineHistory('PS3', TODAY).filter((r) => inRange(r.date, periodRange('last-week', TODAY)));
  assert.equal([...lastWeek.matchAll(/<tr data-night="/g)].length, expected.length);
  for (const m of lastWeek.matchAll(/<tr data-night="([^|]+)\|/g)) assert.ok(m[1] >= '2026-10-19' && m[1] <= '2026-10-25', m[1]);

  assert.match(await t.text('/sample/ps3'), /aria-current="page">All time</);
  assert.match(await t.text('/sample/ps3?period=nonsense'), /aria-current="page">All time</);
});

test('a custom date range works, either way round, and bad dates are ignored', async () => {
  const t = setup();
  const range = await t.text('/sample/ps3?from=2026-10-05&to=2026-10-07');
  const dates = [...range.matchAll(/<tr data-night="([^|]+)\|/g)].map((m) => m[1]);
  assert.ok(dates.length > 0);
  for (const d of dates) assert.ok(d >= '2026-10-05' && d <= '2026-10-07', d);
  assert.match(range, /name="from" type="date" value="2026-10-05"/);
  assert.ok(!/aria-current="page">All time/.test(range));

  assert.equal([...(await t.text('/sample/ps3?from=2026-10-07&to=2026-10-05')).matchAll(/<tr data-night="/g)].length, dates.length);
  assert.match(await t.text('/sample/ps3?from=junk&to=2026-13-40'), /aria-current="page">All time</);
});

test('a period with no sorts says so', async () => {
  const page = await setup(new Date('2026-11-02T20:00:00Z')).text('/sample/ps3?period=this-week'); // a Monday, and tonight is left out
  assert.match(page, /No sorts in this period/);
  assert.ok(!page.includes('<svg'));
});

test('the history chart: a line per sort against expected, with one drawing per screen size', async () => {
  const page = await setup().text('/sample/ps3');
  assert.equal((page.match(/<svg /g) ?? []).length, 2);
  assert.match(page, /aria-label="Line chart of PPH each night from [^"]+ by sort, against an expected 550\."/);
  assert.match(page, /swatch Afternoon/);
  assert.match(page, /swatch Twilight/);
  assert.match(page, /stroke-dasharray/);
});

test('the real live view is not affected: no sample banner, no line links', async () => {
  const sqlite = openDb(':memory:');
  migrate(sqlite);
  seed(sqlite);
  const { d1Shim } = await import('../../db/d1-shim.ts');
  const res = await createApp({ now: () => NOW }).request('/live', {}, { DB: d1Shim(sqlite) });
  const page = await res.text();
  assert.ok(!page.includes('Sample data'));
  assert.ok(!page.includes('/sample'));
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM shift').get() as { n: number }).n, 0);
});
