import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Shim } from '../../db/d1-shim.ts';
import { migrate, openDb, seed } from '../../db/lib.ts';
import { LOCK_MINUTES, MAX_FAILURES } from '../auth/limits.ts';
import { SESSION_SECONDS } from '../auth/session.ts';
import { ADMIN_COOKIE, createApp, type AppOptions, type Env } from './app.ts';

const CODE = 'test-only-code-1234';
const KEY = 's'.repeat(40);
const START = new Date('2026-10-29T20:00:00Z');

function setup(options: AppOptions = {}, env: Partial<Env> = {}) {
  const sqlite = openDb(':memory:');
  migrate(sqlite);
  seed(sqlite);
  let now = START;
  const app = createApp({ now: () => now, failureDelayMs: 0, ...options });
  const fullEnv: Env = { DB: d1Shim(sqlite), ADMIN_CODE: CODE, SESSION_SECRET: KEY, ...env };
  return {
    sqlite,
    setNow: (d: Date) => {
      now = d;
    },
    post: (path: string, body: unknown, cookie?: string) =>
      app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }, fullEnv),
    get: (path: string, cookie?: string) => app.request(path, { headers: cookie ? { cookie } : {} }, fullEnv),
  };
}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];
const later = (ms: number) => new Date(START.getTime() + ms);
const count = (t: ReturnType<typeof setup>, sql: string) => (t.sqlite.prepare(sql).get() as { n: number }).n;

test('the right code gives a signed, HttpOnly cookie that lasts 12 hours', async () => {
  const t = setup();
  const res = await t.post('/api/admin/sign-in', { code: CODE });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; expiresAt: string };
  assert.equal(body.ok, true);
  assert.equal(body.expiresAt, later(SESSION_SECONDS * 1000).toISOString());

  const setCookie = res.headers.get('set-cookie') ?? '';
  assert.match(setCookie, new RegExp(`^${ADMIN_COOKIE}=[^;]+`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, new RegExp(`Max-Age=${SESSION_SECONDS}`));
  assert.equal(count(t, "SELECT count(*) AS n FROM audit_log WHERE actor = 'admin' AND action = 'signed in'"), 1);

  const me = await t.get('/api/admin/me', cookieOf(res));
  assert.equal(me.status, 200);
});

test('a wrong code is refused, recorded, and gives no cookie', async () => {
  const t = setup();
  const res = await t.post('/api/admin/sign-in', { code: 'not-the-code' });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: 'Wrong code.' });
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(count(t, "SELECT count(*) AS n FROM sign_in_failure WHERE who = 'admin'"), 1);

  const missing = await t.post('/api/admin/sign-in', {});
  assert.equal(missing.status, 401);
});

test('a wrong code is slowed down', async () => {
  const t = setup({ failureDelayMs: 60 });
  const started = performance.now();
  await t.post('/api/admin/sign-in', { code: 'nope-nope-nope' });
  assert.ok(performance.now() - started >= 50);
});

test(`after ${MAX_FAILURES} wrong codes, even the right one waits ${LOCK_MINUTES} minutes`, async () => {
  const t = setup();
  for (let i = 0; i < MAX_FAILURES; i += 1) {
    assert.equal((await t.post('/api/admin/sign-in', { code: `guess-${i}-guess` })).status, 401);
  }
  const locked = await t.post('/api/admin/sign-in', { code: CODE });
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('set-cookie'), null);

  t.setNow(later((LOCK_MINUTES + 1) * 60 * 1000));
  assert.equal((await t.post('/api/admin/sign-in', { code: CODE })).status, 200);
});

test('the cookie stops working after 12 hours', async () => {
  const t = setup();
  const cookie = cookieOf(await t.post('/api/admin/sign-in', { code: CODE }));
  t.setNow(later(SESSION_SECONDS * 1000 - 1000));
  assert.equal((await t.get('/api/admin/me', cookie)).status, 200);
  t.setNow(later(SESSION_SECONDS * 1000 + 1000));
  assert.equal((await t.get('/api/admin/me', cookie)).status, 401);
});

test('no cookie, a changed cookie, or one signed with another key is refused', async () => {
  const t = setup();
  const cookie = cookieOf(await t.post('/api/admin/sign-in', { code: CODE }));
  assert.equal((await t.get('/api/admin/me')).status, 401);
  assert.equal((await t.get('/api/admin/me', `${cookie}x`)).status, 401);
  assert.equal((await t.get('/api/admin/me', `${ADMIN_COOKIE}=forged.value`)).status, 401);

  const other = setup({}, { SESSION_SECRET: 'o'.repeat(40) });
  assert.equal((await other.get('/api/admin/me', cookie)).status, 401);
});

test('sign-in refuses to work until both secrets are set and long enough', async () => {
  for (const env of [{ ADMIN_CODE: undefined }, { SESSION_SECRET: undefined }, { ADMIN_CODE: 'abc' }, { SESSION_SECRET: 'too-short' }]) {
    const t = setup({}, env);
    const res = await t.post('/api/admin/sign-in', { code: CODE });
    assert.equal(res.status, 503);
  }
});

test('a 4-character admin code is allowed (D109)', async () => {
  const t = setup({}, { ADMIN_CODE: '4821' });
  assert.equal((await t.post('/api/admin/sign-in', { code: '4821' })).status, 200);
  assert.equal((await t.post('/api/admin/sign-in', { code: '4822' })).status, 401);
});

test('posts must be JSON', async () => {
  const t = setup();
  const env: Env = { DB: d1Shim(t.sqlite), ADMIN_CODE: CODE, SESSION_SECRET: KEY };
  const res = await createApp({ failureDelayMs: 0 }).request('/api/admin/sign-in', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${CODE}` }, env);
  assert.equal(res.status, 415);
});

test('sign-out clears the cookie', async () => {
  const t = setup();
  const res = await t.post('/api/admin/sign-out', {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`^${ADMIN_COOKIE}=;.*Max-Age=0`));
});

test('saving a night needs the admin cookie, then saves and reports problems', async () => {
  const t = setup();
  const night = { date: '2026-10-26', sort: 'Afternoon', rows: [{ lineId: 'PS1', hours: 20, volume: 9647 }, { lineId: 'PS2', hours: null, volume: null }] };

  assert.equal((await t.post('/api/admin/night', night)).status, 401);
  assert.equal(count(t, 'SELECT count(*) AS n FROM entry'), 0);

  const cookie = cookieOf(await t.post('/api/admin/sign-in', { code: CODE }));
  const saved = await t.post('/api/admin/night', night, cookie);
  assert.equal(saved.status, 200);
  const result = (await saved.json()) as { ok: boolean; created: number; skipped: number };
  assert.deepEqual([result.ok, result.created, result.skipped], [true, 1, 1]);

  const bad = await t.post('/api/admin/night', { ...night, rows: [{ lineId: 'PS1', hours: 20, volume: null }] }, cookie);
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { ok: false, errors: [{ lineId: 'PS1', message: 'Enter both hours and volume, or leave both blank.' }] });

  const junk = await t.post('/api/admin/night', { date: '2026-10-26', sort: 'Afternoon', rows: [null, 5, 'x'] }, cookie);
  assert.equal(junk.status, 400);
  const noRows = await t.post('/api/admin/night', { date: '2026-10-26' }, cookie);
  assert.equal(noRows.status, 400);
});
