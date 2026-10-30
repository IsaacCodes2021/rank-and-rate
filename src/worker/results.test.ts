import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Shim } from '../../db/d1-shim.ts';
import { migrate, openDb, seed } from '../../db/lib.ts';
import { createApp, type Env } from './app.ts';

const SIGNUP = 'test-signup-code';
const CODE = 'test-only-code-1234';
const at = (time: string, date = '2026-10-30') => new Date(`${date}T${time}:00-07:00`);
const CACHE_MS = 20_000;

async function setup() {
  const sqlite = openDb(':memory:');
  migrate(sqlite);
  seed(sqlite);
  let now = at('13:00');
  const app = createApp({ now: () => now, failureDelayMs: 0 });
  const env: Env = { DB: d1Shim(sqlite), ADMIN_CODE: CODE, SESSION_SECRET: 's'.repeat(40), PIN_SALT: 'p'.repeat(40), SIGNUP_CODE: SIGNUP };
  const post = (path: string, body: unknown, cookie?: string) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }, env);
  const get = (path: string) => app.request(path, {}, env);
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];
  let people = 0;
  return {
    sqlite,
    get,
    post,
    setNow: (d: Date) => {
      now = d;
    },
    // Moves the clock on past the copy the Worker keeps, so the next page is read fresh.
    text: async (path: string) => {
      now = new Date(now.getTime() + CACHE_MS + 1);
      return (await get(path)).text();
    },
    admin: async () => cookieOf(await post('/api/admin/sign-in', { code: CODE })),
    join: async (name: string) => {
      people += 1;
      const res = await post('/api/supervisor/sign-up', { code: SIGNUP, name, pin: `1000000${people}`, role: 'part_time' });
      assert.equal(res.status, 200);
      return cookieOf(res);
    },
    start: async (cookie: string, sort: string, lines: string[]) => {
      const res = await post('/api/supervisor/shift', { sort, lines }, cookie);
      assert.equal(res.status, 200);
      return ((await res.json()) as { shiftId: number }).shiftId;
    },
    update: (cookie: string, shiftId: number, rows: unknown) => post('/api/supervisor/update', { shiftId, rows }, cookie),
    final: (cookie: string, shiftId: number, rows: unknown) => post('/api/supervisor/final', { shiftId, rows }, cookie),
  };
}

type Tester = Awaited<ReturnType<typeof setup>>;

const save = (t: Tester, admin: string, date: string, sort: string, rows: { lineId: string; hours: number; volume: number }[]) => t.post('/api/admin/night', { date, sort, rows }, admin);
const ranks = (page: string) => [...page.matchAll(/<tr data-rank="([^"]+)"/g)].map((m) => m[1]);
const winOf = (page: string, label: string) => {
  const m = page.match(new RegExp(`<div class="card win[^"]*"[^>]*><div class="what">${label}[\\s\\S]*?</div></div></div>`));
  assert.ok(m, `no card for ${label}`);
  return m[0];
};

test('with nothing finished it says so, needs no sign-in and is never cached by the browser', async () => {
  const t = await setup();
  const res = await t.get('/results');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const page = await res.text();
  assert.match(page, /<title>Results<\/title>/);
  assert.match(page, /name="robots" content="noindex"/);
  assert.match(page, /No finished sorts yet/);
  assert.match(page, /href="\/live">Live sort</);
});

test('typed totals: the winners and the ranking, with worked numbers (D028)', async () => {
  const t = await setup();
  const admin = await t.admin();
  await save(t, admin, '2026-10-30', 'Afternoon', [
    { lineId: 'PS1', hours: 20, volume: 11000 }, // 550 PPH, 100%
    { lineId: 'PS2', hours: 10, volume: 6600 }, // 660 PPH, 120%
    { lineId: 'PD1', hours: 10, volume: 3300 }, // 330 PPH, 120%, the smaller volume of the two at 120%
    { lineId: 'PD6', hours: 10, volume: 3500 }, // 350 PPH, 100%
  ]);
  const page = await t.text('/results');
  assert.match(page, /<h1>Afternoon results<\/h1>/);
  assert.match(page, /Fri, Oct 30 · 4 of 27 lines/);
  assert.match(page, /aria-current="page">Latest night</);
  assert.match(page, /aria-current="true">Afternoon</);

  assert.match(winOf(page, 'Best PS'), /data-win="PS2"/);
  assert.match(winOf(page, 'Best PD'), /data-win="PD6"/); // by PPH, so 350 beats 330 at lower effectiveness
  assert.match(winOf(page, 'Best overall'), /data-win="PS2"/);
  assert.match(winOf(page, 'Best overall'), /<div class="big">120%<\/div>/);
  assert.match(winOf(page, 'Best overall'), /PPH vs 550 expected/);

  assert.deepEqual(ranks(page), ['PS2', 'PD1', 'PS1', 'PD6']);
  const heads = [...page.match(/<thead>[\s\S]*?<\/thead>/)![0].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['#', 'Line', 'Supervisor', 'Hours', 'Volume', 'PPH', 'Effective', 'Over / under']);
  const row = page.match(/<tr data-rank="PS1"[\s\S]*?<\/tr>/)![0];
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  assert.deepEqual(cells.slice(0, 8), ['3', 'PS1', '-', '20.0', '11,000', '550', '100%', 'on plan']);
  assert.match(row, /href="\/line\/ps1\?sort=afternoon"/);
});

test('typed totals have no names, and the supervisors card says why', async () => {
  const t = await setup();
  const admin = await t.admin();
  await save(t, admin, '2026-10-30', 'Afternoon', [{ lineId: 'PS1', hours: 20, volume: 11000 }]);
  const page = await t.text('/results');
  assert.match(page, /No names yet/);
  assert.match(page, /1 line with no name, because totals typed on the admin screen do not say who ran the line/);
});

test("a supervisor's record follows them across lines, from the updates and finals they entered (D012)", async () => {
  const t = await setup();
  const pat = await t.join('Pat Sample');
  const id = await t.start(pat, 'Afternoon', ['PS1', 'PD1']);
  t.setNow(at('13:15'));
  await t.update(pat, id, [{ lineId: 'PS1', headcount: 8, volume: 1000 }, { lineId: 'PD1', headcount: 4, volume: 200 }]);
  t.setNow(at('14:15'));
  await t.final(pat, id, [{ lineId: 'PS1', volume: 5500 }, { lineId: 'PD1', volume: 1100 }]);

  const page = await t.text('/results');
  // PS1: 8 x 0.25 x 5 quarter hours = 10 hours, 550 PPH. PD1: 4 x 0.25 x 5 = 5 hours, 220 PPH, plan 4.
  assert.deepEqual(ranks(page), ['PS1', 'PD1']);
  const person = page.match(/<tr data-person>[\s\S]*?<\/tr>/)![0];
  assert.match(person, /Pat Sample/);
  assert.match(person, /PS1, PD1 · 15\.0 hrs · 6,600 pcs/);
  assert.match(person, /<strong>440<\/strong>/); // 6,600 / 15
  assert.match(person, /93%/); // plan 10 + 4 = 14 hours in 15
  assert.ok(!page.includes('with no name'));
  assert.match(winOf(page, 'Best PS'), /Pat Sample/);
});

test('only finished sorts count: a sort still running stays off the page', async () => {
  const t = await setup();
  const pat = await t.join('Pat Sample');
  const id = await t.start(pat, 'Afternoon', ['PS1', 'PS2']);
  t.setNow(at('13:15'));
  await t.update(pat, id, [{ lineId: 'PS1', headcount: 8, volume: 1000 }, { lineId: 'PS2', headcount: 8, volume: 1000 }]);
  t.setNow(at('14:15'));
  await t.final(pat, id, [{ lineId: 'PS1', volume: 5500 }]); // PS2 has no final, so the sort is open
  assert.match(await t.text('/results'), /No finished sorts yet/);
});

test('one sort at a time: each has its own winners and ranking, and sorts never mix (D115, D125)', async () => {
  const t = await setup();
  const admin = await t.admin();
  await save(t, admin, '2026-10-30', 'Afternoon', [{ lineId: 'PS1', hours: 20, volume: 11000 }]);
  await save(t, admin, '2026-10-30', 'Twilight', [{ lineId: 'PS2', hours: 20, volume: 9000 }]);

  const first = await t.text('/results');
  assert.match(first, /<h1>Afternoon results<\/h1>/); // opens on the first in the usual order
  assert.deepEqual(ranks(first), ['PS1']);
  assert.match(first, /href="\/results\?sort=twilight&amp;period=latest">Twilight</);

  const second = await t.text('/results?sort=twilight');
  assert.match(second, /<h1>Twilight results<\/h1>/);
  assert.deepEqual(ranks(second), ['PS2']);
  assert.match(second, /href="\/line\/ps2\?sort=twilight"/);
  assert.match(await t.text('/results?sort=nonsense'), /<h1>Afternoon results<\/h1>/);
});

test('the latest night belongs to the sort picked, even if another sort ran later', async () => {
  const t = await setup();
  const admin = await t.admin();
  await save(t, admin, '2026-10-28', 'Twilight', [{ lineId: 'PS1', hours: 20, volume: 11000 }]);
  await save(t, admin, '2026-10-30', 'Afternoon', [{ lineId: 'PS2', hours: 20, volume: 11000 }]);
  const page = await t.text('/results?sort=twilight');
  assert.match(page, /Wed, Oct 28/);
  assert.deepEqual(ranks(page), ['PS1']);
});

test('periods add up the nights in range, with totals first (D072, D105)', async () => {
  const t = await setup();
  const admin = await t.admin();
  await save(t, admin, '2026-10-30', 'Afternoon', [{ lineId: 'PS1', hours: 20, volume: 11000 }, { lineId: 'PS2', hours: 20, volume: 13200 }]);
  await save(t, admin, '2026-10-26', 'Afternoon', [{ lineId: 'PS1', hours: 10, volume: 6600 }, { lineId: 'PS2', hours: 10, volume: 3300 }]);
  await save(t, admin, '2026-10-20', 'Afternoon', [{ lineId: 'PS1', hours: 10, volume: 2750 }]);

  // This week is the 26th to the 30th. PS1: 30 hours, 17,600, 107%. PS2: 30 hours, 16,500, 100%.
  const week = await t.text('/results?period=this-week');
  assert.match(week, /This week · 2 nights/);
  assert.deepEqual(ranks(week), ['PS1', 'PS2']);
  const ps1 = week.match(/<tr data-rank="PS1"[\s\S]*?<\/tr>/)![0];
  assert.match(ps1, />30\.0</);
  assert.match(ps1, />17,600</);
  assert.match(ps1, /107%/);
  assert.match(ps1, /2\.0 under/);
  // Each ranked first on one of the two nights.
  assert.match(week, /<th class="num hide-narrow">Nights #1<\/th>/);
  assert.match(ps1, /<td class="num hide-narrow">2<\/td><td class="num hide-narrow">1<\/td>/);

  const all = await t.text('/results?period=all-time');
  assert.match(all, /All time · 3 nights/);
  assert.deepEqual(ranks(all), ['PS2', 'PS1']); // PS1 falls to 40 hours, 20,350: 92.5%

  const range = await t.text('/results?from=2026-10-20&to=2026-10-20');
  assert.deepEqual(ranks(range), ['PS1']);
  assert.match(range, /Oct 20 to Oct 20 · 1 night/);
  assert.match(range, /name="from" type="date" value="2026-10-20"/);

  assert.match(await t.text('/results?period=last-month'), /No Afternoon sorts in this period/);
  assert.ok(!(await t.text('/results')).includes('Nights #1')); // one night has nothing to count
});

test('viewers share a copy, so the database is read at most every 20 seconds per Worker', async () => {
  const t = await setup();
  const admin = await t.admin();
  await save(t, admin, '2026-10-30', 'Afternoon', [{ lineId: 'PS1', hours: 20, volume: 11000 }]);
  t.setNow(new Date(at('13:00').getTime() + CACHE_MS + 1));
  assert.deepEqual(ranks(await (await t.get('/results')).text()), ['PS1']);
  await save(t, admin, '2026-10-30', 'Afternoon', [{ lineId: 'PS2', hours: 20, volume: 11000 }]);
  assert.deepEqual(ranks(await (await t.get('/results')).text()), ['PS1']); // still the shared copy
  assert.deepEqual(ranks(await t.text('/results')), ['PS1', 'PS2']);
});

test('a line page shows the real history of one line on one sort (T304)', async () => {
  const t = await setup();
  const admin = await t.admin();
  await save(t, admin, '2026-10-30', 'Afternoon', [{ lineId: 'PS1', hours: 20, volume: 11000 }, { lineId: 'PS2', hours: 20, volume: 5000 }]);
  await save(t, admin, '2026-10-29', 'Afternoon', [{ lineId: 'PS1', hours: 10, volume: 6600 }]);
  await save(t, admin, '2026-10-29', 'Twilight', [{ lineId: 'PS1', hours: 10, volume: 2750 }]);

  const page = await t.text('/line/ps1');
  assert.match(page, /<title>PS1 history<\/title>/);
  assert.match(page, /Unload · expected 550 PPH/);
  assert.match(page, /href="\/results">Results</);
  assert.match(page, /aria-current="true">Afternoon</);
  assert.equal([...page.matchAll(/<tr data-night="/g)].length, 2);
  assert.match(page, /<tr data-night="2026-10-30\|Afternoon"/);
  assert.match(page, /<div class="value">587<\/div>/); // 17,600 / 30
  assert.match(page, /<strong>107% effective<\/strong>/);
  assert.equal((page.match(/<svg /g) ?? []).length, 2);

  const twilight = await t.text('/line/PS1?sort=twilight');
  assert.equal([...twilight.matchAll(/<tr data-night="/g)].length, 1);
  assert.match(twilight, /<div class="value">275<\/div>/);
  assert.match(twilight, /href="\/line\/ps1\?sort=afternoon&amp;period=all-time">Afternoon</);

  assert.equal([...(await t.text('/line/ps1?from=2026-10-30&to=2026-10-30')).matchAll(/<tr data-night="/g)].length, 1);
});

test('a line with no finished sorts says so, and anything that is not a line goes back to the results', async () => {
  const t = await setup();
  assert.match(await t.text('/line/pd9'), /No Afternoon sorts in this period/);
  assert.match(await t.text('/line/pd9'), /Load, Wings · expected 350 PPH/);
  for (const path of ['/line/ps13', '/line/nope', '/line/ps99']) {
    const res = await t.get(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), '/results');
  }
});

test('a name is made safe for the page, and no number that identifies anyone or hash is shown', async () => {
  const t = await setup();
  const pat = await t.join('<script>alert(1)</script>');
  const id = await t.start(pat, 'Afternoon', ['PS1']);
  t.setNow(at('13:15'));
  await t.update(pat, id, [{ lineId: 'PS1', headcount: 8, volume: 1000 }]);
  t.setNow(at('14:15'));
  await t.final(pat, id, [{ lineId: 'PS1', volume: 5500 }]);
  for (const path of ['/results', '/line/ps1']) {
    const page = await t.text(path);
    assert.ok(!page.includes('<script>alert'), path);
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, path);
    assert.ok(!page.includes('10000001'), path);
    const [{ pin_hash: hash }] = t.sqlite.prepare('SELECT pin_hash FROM supervisor').all() as { pin_hash: string }[];
    assert.ok(!page.includes(hash), path);
  }
});
