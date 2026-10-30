import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Shim } from '../../db/d1-shim.ts';
import { migrate, openDb, seed } from '../../db/lib.ts';
import { createApp, pacificDate, type Env } from '../worker/app.ts';

const CODE = 'test-only-code-1234';
const KEY = 's'.repeat(40);

function setup() {
  const sqlite = openDb(':memory:');
  migrate(sqlite);
  seed(sqlite);
  const app = createApp({ now: () => new Date('2026-10-29T20:00:00Z'), failureDelayMs: 0 });
  const env: Env = { DB: d1Shim(sqlite), ADMIN_CODE: CODE, SESSION_SECRET: KEY };
  const json = { 'content-type': 'application/json' };
  return {
    sqlite,
    get: (path: string, cookie?: string) => app.request(path, { headers: cookie ? { cookie } : {} }, env),
    post: (path: string, body: unknown, cookie?: string) =>
      app.request(path, { method: 'POST', headers: { ...json, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }, env),
    signIn: async () => {
      const res = await app.request('/api/admin/sign-in', { method: 'POST', headers: json, body: JSON.stringify({ code: CODE }) }, env);
      return (res.headers.get('set-cookie') ?? '').split(';')[0];
    },
  };
}

const lineIds = (page: string) => [...page.matchAll(/<tr data-line="([^"]+)"/g)].map((m) => m[1]);

test('signed out, /admin shows only the sign-in form, never cached', async () => {
  const t = setup();
  const res = await t.get('/admin');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(res.headers.get('x-frame-options'));
  const page = await res.text();
  assert.match(page, /id="sign-in"/);
  assert.match(page, /type="password"/);
  assert.match(page, /name="viewport"/);
  assert.deepEqual(lineIds(page), []);
});

test('signed in, /admin shows the D065 screen: 27 lines, PS then PD, number keypads, one Save', async () => {
  const t = setup();
  const page = await (await t.get('/admin', await t.signIn())).text();
  const ids = lineIds(page);
  assert.equal(ids.length, 27);
  assert.equal(ids[0], 'PS1');
  assert.equal(ids[12], 'PS14');
  assert.equal(ids[13], 'PD1');
  assert.equal(ids[26], 'PD14');
  assert.ok(!ids.includes('PS13'));

  assert.equal((page.match(/inputmode="decimal"/g) ?? []).length, 27); // total hours
  assert.equal((page.match(/inputmode="numeric"/g) ?? []).length, 27); // volume
  assert.equal((page.match(/enterkeyhint="done"/g) ?? []).length, 1); // only the very last field
  assert.match(page, /aria-label="PD14 volume"[^>]*enterkeyhint="done"/);
  assert.equal((page.match(/type="submit"/g) ?? []).length, 1);
  assert.match(page, /id="date" type="date" value="2026-10-29"/);
  assert.match(page, /<select id="sort" required><option value="">Choose<\/option><option>Afternoon<\/option><option>Morning<\/option><option>Twilight<\/option><\/select>/);
});

test('an inactive line is left off the screen', async () => {
  const t = setup();
  t.sqlite.prepare("UPDATE line SET active = 0 WHERE id = 'PD2'").run();
  const ids = lineIds(await (await t.get('/admin', await t.signIn())).text());
  assert.equal(ids.length, 26);
  assert.ok(!ids.includes('PD2'));
});

test('the saved numbers for a date and sort can be loaded back, admin only', async () => {
  const t = setup();
  assert.equal((await t.get('/api/admin/night?date=2026-10-26&sort=Afternoon')).status, 401);

  const cookie = await t.signIn();
  await t.post('/api/admin/night', { date: '2026-10-26', sort: 'Afternoon', rows: [{ lineId: 'PS1', hours: '20', volume: '9647' }] }, cookie);
  const res = await t.get('/api/admin/night?date=2026-10-26&sort=Afternoon', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { ok: true, rows: [{ lineId: 'PS1', hours: 20, volume: 9647 }] });

  assert.equal((await t.get('/api/admin/night?date=2026-13-01&sort=Afternoon', cookie)).status, 400);
  assert.equal((await t.get('/api/admin/night?date=2026-10-26&sort=Night', cookie)).status, 400);
  assert.equal((await t.get('/api/admin/night', cookie)).status, 400);
});

test("the screen's date is the building's local date, across the end of daylight saving", () => {
  assert.equal(pacificDate(new Date('2026-10-30T06:30:00Z')), '2026-10-29'); // 11:30 PM PDT
  assert.equal(pacificDate(new Date('2026-10-30T07:30:00Z')), '2026-10-30'); // 12:30 AM PDT
  assert.equal(pacificDate(new Date('2026-11-02T07:30:00Z')), '2026-11-01'); // 11:30 PM PST
});
