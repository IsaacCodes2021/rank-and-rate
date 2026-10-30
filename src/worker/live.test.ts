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
    // Moves the clock on past the copy the Worker keeps, so the next page is read fresh.
    setNow: (d: Date) => {
      now = d;
    },
    text: async (path: string) => {
      now = new Date(now.getTime() + CACHE_MS + 1);
      return (await get(path)).text();
    },
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
    admin: async () => cookieOf(await post('/api/admin/sign-in', { code: CODE })),
  };
}

const rowOf = (page: string, lineId: string) => {
  const m = page.match(new RegExp(`<tr data-line="${lineId}"[\\s\\S]*?</tr>`));
  assert.ok(m, `no row for ${lineId}`);
  return m[0];
};

test('the live view needs no sign-in and is never cached by the browser', async () => {
  const t = await setup();
  const res = await t.get('/live');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(res.headers.get('x-frame-options'));
  const page = await res.text();
  assert.match(page, /<title>Live sort<\/title>/);
  assert.match(page, /name="viewport"/);
  assert.match(page, /name="robots" content="noindex"/);
  assert.match(page, /href="\/shift"/);
});

test('with nothing running it says so, and offers to pick up the next sort', async () => {
  const t = await setup();
  const page = await t.text('/live');
  assert.match(page, /No sort is running/);
  assert.match(page, /picks up the next sort by itself/);
});

test('a running sort: totals, on-time, and every line, with worked numbers', async () => {
  const t = await setup();
  const pat = await t.join('Pat Sample');
  const sam = await t.join('Sam Sample');
  const id = await t.start(pat, 'Afternoon', ['PS1', 'PD1']);
  await t.start(sam, 'Afternoon', ['PS2']);

  t.setNow(at('13:15'));
  // PS1: 8 x 0.25 = 2 hours, 1,300 pieces: 650 PPH, 118% of 550. PD1: 4 x 0.25 = 1 hour, 300: 300 PPH, 109% of 275.
  await t.update(pat, id, [{ lineId: 'PS1', headcount: 8, volume: 1300 }, { lineId: 'PD1', headcount: 4, volume: 300 }]);
  // PS2: 4 x 0.25 = 1 hour, 200 pieces: 200 PPH, 36%.
  await t.update(sam, id, [{ lineId: 'PS2', headcount: 4, volume: 200 }]);

  const page = await t.text('/live');
  assert.match(page, /<h1>Afternoon<\/h1>/);
  assert.match(page, /Fri, Oct 30 · started 1:00 PM · next update due 1:30 PM/);

  const ps1 = rowOf(page, 'PS1');
  assert.match(ps1, /Pat Sample/);
  assert.match(ps1, /<strong>650<\/strong>/);
  assert.match(ps1, /<span>118%<\/span>/);
  assert.match(ps1, />2\.0</);
  assert.match(ps1, />1,300</);
  assert.match(ps1, />1:15 PM</);
  assert.match(rowOf(page, 'PS2'), /<strong>200<\/strong>/);
  assert.match(rowOf(page, 'PD1'), /<strong>300<\/strong>/);
  assert.match(rowOf(page, 'PD2'), /No one on it/);
  assert.deepEqual([...page.matchAll(/<tr data-line="([^"]+)"/g)].length, 27);

  // PS: 1,500 pieces, 3 hours = 500 PPH. Plan 1,500 / 550 = 2.7 hours: 0.3 hours over plan, 91% effective.
  assert.match(page, /PS \(unload\) PPH<\/div>\s*<div class="value">500<\/div>/);
  assert.match(page, /Expected 550 · <strong>91% effective<\/strong>/);
  assert.match(page, /0\.3 hrs over plan/);
  // PD: 300 / 1 hour. Plan 300 / 275 = 1.09 hours: 0.1 hours under plan.
  assert.match(page, /PD \(load\) PPH<\/div>\s*<div class="value">300<\/div>/);
  assert.match(page, /0\.1 hrs under plan/);
  assert.match(page, /<div class="value">3<small> \/ 3<\/small><\/div>/);
  assert.match(page, /None late/);
  assert.match(page, /<div class="value">1,800<\/div>/);
  assert.match(page, /4\.0 hours worked/);
});

test('a line that stops updating shows as late, on the line and in the totals', async () => {
  const t = await setup();
  const pat = await t.join('Pat Sample');
  const id = await t.start(pat, 'Afternoon', ['PS1', 'PS2']);
  t.setNow(at('13:15'));
  await t.update(pat, id, [{ lineId: 'PS1', headcount: 8, volume: 1300 }, { lineId: 'PS2', headcount: 8, volume: 1300 }]);
  t.setNow(at('13:30'));
  await t.update(pat, id, [{ lineId: 'PS1', headcount: 8, volume: 2600 }]);

  t.setNow(at('13:36')); // the 1:30 window is still open, so nothing is late yet
  assert.ok(!(await t.text('/live')).includes('class="pill late"'));

  t.setNow(at('13:40')); // it has closed
  const page = await t.text('/live');
  assert.match(rowOf(page, 'PS2'), /<span class="pill late">Late · 1:15 PM<\/span>/);
  assert.ok(!rowOf(page, 'PS1').includes('pill late'));
  assert.match(page, /<div class="value">1<small> \/ 2<\/small><\/div>/);
  assert.match(page, /1 line late/);
  assert.match(page, /1 running|2 running/);
});

test('sorts never mix: overlapping sorts each get their own view, even on the same line', async () => {
  const t = await setup();
  const day = await t.join('Pat Sample');
  const night = await t.join('Sam Sample');
  const afternoon = await t.start(day, 'Afternoon', ['PS1']);
  t.setNow(at('13:15'));
  await t.update(day, afternoon, [{ lineId: 'PS1', headcount: 8, volume: 1300 }]);

  t.setNow(at('17:45'));
  const twilight = await t.start(night, 'Twilight', ['PS1']);
  await t.update(night, twilight, [{ lineId: 'PS1', headcount: 2, volume: 90 }]);

  const dayPage = await t.text(`/live/${afternoon}`);
  assert.match(dayPage, /<h1>Afternoon<\/h1>/);
  assert.match(rowOf(dayPage, 'PS1'), /Pat Sample/);
  assert.ok(!rowOf(dayPage, 'PS1').includes('Sam Sample'));
  assert.match(rowOf(dayPage, 'PS1'), />1,300</);

  const nightPage = await t.text(`/live/${twilight}`);
  assert.match(nightPage, /<h1>Twilight<\/h1>/);
  assert.match(rowOf(nightPage, 'PS1'), /Sam Sample/);
  assert.ok(!rowOf(nightPage, 'PS1').includes('Pat Sample'));
  assert.match(rowOf(nightPage, 'PS1'), /<strong>180<\/strong>/); // 90 / 0.5 hours
  assert.ok(!nightPage.includes('1,300'));

  // The newest sort is the default, and both are a tap away.
  const current = await t.text('/live');
  assert.match(current, /<h1>Twilight<\/h1>/);
  assert.match(current, new RegExp(`href="/live/${afternoon}"[^>]*>Afternoon`));
  assert.match(current, new RegExp(`href="/live/${twilight}"[^>]*>Twilight`));
});

test('when the sort finishes /live keeps showing it, and moves on when the next one starts', async () => {
  const t = await setup();
  const pat = await t.join('Pat Sample');
  const afternoon = await t.start(pat, 'Afternoon', ['PS1']);
  t.setNow(at('13:15'));
  await t.update(pat, afternoon, [{ lineId: 'PS1', headcount: 8, volume: 400 }]);
  t.setNow(at('17:00'));
  await t.final(pat, afternoon, [{ lineId: 'PS1', volume: 2000 }]);

  const finished = await t.text('/live');
  assert.match(finished, /<h1>Afternoon<\/h1>/);
  assert.match(finished, /finished 5:00 PM/);
  assert.match(rowOf(finished, 'PS1'), /<span class="pill final">Final · 5:00 PM<\/span>/);
  assert.match(finished, /data-stop="0"/); // a viewer on /live is waiting for the next sort
  assert.match(await t.text(`/live/${afternoon}`), /data-stop="1"/); // this one will not change

  t.setNow(at('18:30'));
  await t.start(pat, 'Twilight', ['PS1']);
  assert.match(await t.text('/live?panel=1'), /<h1>Twilight<\/h1>/);
});

test('a refresh gets just the panel', async () => {
  const t = await setup();
  const panel = await t.text('/live?panel=1');
  assert.ok(!panel.includes('<!doctype'));
  assert.ok(!panel.includes('<script'));
  assert.ok(!panel.includes('<main'));
  assert.match(panel, /No sort is running/);
});

test('viewers share a copy, so the database is read at most every 20 seconds per Worker', async () => {
  const t = await setup();
  const pat = await t.join('Pat Sample');
  const id = await t.start(pat, 'Afternoon', ['PS1']);
  t.setNow(at('13:15'));
  await t.update(pat, id, [{ lineId: 'PS1', headcount: 8, volume: 400 }]);
  assert.match(await (await t.get('/live')).text(), />400</);

  t.setNow(new Date(at('13:15').getTime() + 1000));
  await t.update(pat, id, [{ lineId: 'PS1', headcount: 8, volume: 900 }]);
  assert.match(await (await t.get('/live')).text(), />400</); // still the shared copy
  t.setNow(new Date(at('13:15').getTime() + CACHE_MS + 1));
  assert.match(await (await t.get('/live')).text(), />900</);
});

test('each sort has its own shared copy', async () => {
  const t = await setup();
  const pat = await t.join('Pat Sample');
  const afternoon = await t.start(pat, 'Afternoon', ['PS1']);
  const twilight = await t.start(pat, 'Twilight', ['PD1']);
  assert.match(await (await t.get(`/live/${afternoon}`)).text(), /<h1>Afternoon<\/h1>/);
  assert.match(await (await t.get(`/live/${twilight}`)).text(), /<h1>Twilight<\/h1>/);
});

test('the chart: PS and PD against expected, with a readable table twin', async () => {
  const t = await setup();
  const pat = await t.join('Pat Sample');
  const id = await t.start(pat, 'Afternoon', ['PS1', 'PD1']);
  t.setNow(at('13:15'));
  await t.update(pat, id, [{ lineId: 'PS1', headcount: 8, volume: 1300 }, { lineId: 'PD1', headcount: 4, volume: 300 }]);
  t.setNow(at('13:30'));
  await t.update(pat, id, [{ lineId: 'PS1', headcount: 8, volume: 2400 }, { lineId: 'PD1', headcount: 4, volume: 700 }]);

  const page = await t.text('/live');
  assert.equal((page.match(/<svg /g) ?? []).length, 2); // one drawing for a desktop, one for a phone
  assert.match(page, /role="img" aria-label="Line chart of running PPH from 1:15 PM to 1:30 PM\. PS is at 600\. PD is at 350\."/);
  assert.match(page, /tabindex="0"/);
  assert.match(page, /stroke-dasharray/); // expected
  assert.match(page, /Show these numbers as a table/);
  assert.match(page, /<td>1:15 PM<\/td><td class="num">650<\/td><td class="num">550<\/td><td class="num">300<\/td><td class="num">275<\/td>/);
  assert.match(page, /<td>1:30 PM<\/td><td class="num">600<\/td><td class="num">550<\/td><td class="num">350<\/td><td class="num">275<\/td>/);
});

test('before any update there is no chart, and lines someone picked say so', async () => {
  const t = await setup();
  const pat = await t.join('Pat Sample');
  await t.start(pat, 'Afternoon', ['PS1']);
  const page = await t.text('/live');
  assert.match(page, /The chart starts with the first update/);
  assert.ok(!page.includes('<svg'));
  assert.match(rowOf(page, 'PS1'), /No update yet/);
});

test("the admin's end-of-night totals show as a finished sort", async () => {
  const t = await setup();
  const admin = await t.admin();
  await t.post('/api/admin/night', { date: '2026-10-30', sort: 'Afternoon', rows: [{ lineId: 'PS1', hours: 20, volume: 9647 }] }, admin);
  const page = await t.text('/live');
  assert.match(page, /<h1>Afternoon<\/h1>/);
  assert.match(rowOf(page, 'PS1'), /<strong>482<\/strong>/); // 9,647 / 20
  assert.match(rowOf(page, 'PS1'), /<span>88%<\/span>/); // 482.35 / 550
});

test('a name is made safe for the page, and a bad address goes back to /live', async () => {
  const t = await setup();
  const pat = await t.join('<script>alert(1)</script>');
  const id = await t.start(pat, 'Afternoon', ['PS1']);
  const page = await t.text(`/live/${id}`);
  assert.ok(!page.includes('<script>alert'));
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const missing = await t.get('/live/99999');
  assert.equal(missing.status, 302);
  assert.equal(missing.headers.get('location'), '/live');
});

test('the page shows no number that identifies anyone beyond the name, and no hashes', async () => {
  const t = await setup();
  const pat = await t.join('Pat Sample');
  await t.start(pat, 'Afternoon', ['PS1']);
  const page = await t.text('/live');
  assert.ok(!page.includes('10000001'));
  const [{ pin_hash: hash }] = t.sqlite.prepare('SELECT pin_hash FROM supervisor').all() as { pin_hash: string }[];
  assert.ok(!page.includes(hash));
});
