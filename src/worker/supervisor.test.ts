import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Shim } from '../../db/d1-shim.ts';
import { migrate, openDb, seed } from '../../db/lib.ts';
import { LOCK_MINUTES, MAX_FAILURES } from '../auth/limits.ts';
import { SESSION_SECONDS } from '../auth/session.ts';
import { ADMIN_COOKIE, SUPERVISOR_COOKIE, createApp, type AppOptions, type Env } from './app.ts';

const CODE = 'test-only-code-1234';
const KEY = 's'.repeat(40);
const SALT = 'p'.repeat(40);
const START = new Date('2026-10-30T20:00:00Z');
const NAME = 'Sample Supervisor 01';
const NUMBER = '10000001'; // made up, as is every number in this file

async function setup(options: AppOptions = {}, env: Partial<Env> = {}) {
  const sqlite = openDb(':memory:');
  migrate(sqlite);
  seed(sqlite);
  let now = START;
  const app = createApp({ now: () => now, failureDelayMs: 0, ...options });
  const fullEnv: Env = { DB: d1Shim(sqlite), ADMIN_CODE: CODE, SESSION_SECRET: KEY, PIN_SALT: SALT, ...env };
  const post = (path: string, body: unknown, cookie?: string) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }, fullEnv);
  const get = (path: string, cookie?: string) => app.request(path, { headers: cookie ? { cookie } : {} }, fullEnv);
  const admin = cookieOf(await post('/api/admin/sign-in', { code: CODE }));
  return {
    sqlite,
    post,
    get,
    admin,
    setNow: (d: Date) => {
      now = d;
    },
    add: (name: string, pin: string, role = 'part_time') => post('/api/admin/supervisors', { name, pin, role }, admin),
    signIn: (name: string, pin: unknown) => post('/api/supervisor/sign-in', { name, pin }),
    rows: (sql: string) => sqlite.prepare(sql).all() as Record<string, unknown>[],
    count: (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n,
  };
}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];
const later = (ms: number) => new Date(START.getTime() + ms);

test('the right name and number give an HttpOnly cookie that lasts 12 hours', async () => {
  const t = await setup();
  assert.equal((await t.add(NAME, NUMBER, 'full_time')).status, 200);

  const res = await t.signIn(NAME, NUMBER);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; expiresAt: string };
  assert.equal(body.expiresAt, later(SESSION_SECONDS * 1000).toISOString());

  const setCookie = res.headers.get('set-cookie') ?? '';
  assert.match(setCookie, new RegExp(`^${SUPERVISOR_COOKIE}=[^;]+`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, new RegExp(`Max-Age=${SESSION_SECONDS}`));

  const me = await t.get('/api/supervisor/me', cookieOf(res));
  assert.equal(me.status, 200);
  assert.equal(me.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await me.json(), { ok: true, name: NAME, role: 'full_time' });
  assert.equal(t.count(`SELECT count(*) AS n FROM audit_log WHERE actor = '${NAME}' AND action = 'signed in'`), 1);
});

test('capitals and extra spaces in the name do not matter; spaces around the number do not either', async () => {
  const t = await setup();
  await t.add(NAME, NUMBER);
  assert.equal((await t.signIn('  sample   SUPERVISOR 01 ', ` ${NUMBER} `)).status, 200);
});

test('a wrong number and an unknown name get the same answer, and neither gives a cookie', async () => {
  const t = await setup();
  await t.add(NAME, NUMBER);
  const wrongNumber = await t.signIn(NAME, '10000002');
  const unknownName = await t.signIn('Nobody Here', NUMBER);
  for (const res of [wrongNumber, unknownName]) {
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  }
  assert.deepEqual(await wrongNumber.json(), await unknownName.json());
});

test('odd input is refused, never an error; a number must arrive as text', async () => {
  const t = await setup();
  await t.add(NAME, '01234');
  const pins = ['', 'abcd', '1234', 1234, null, { a: 1 }, ['01234']];
  for (const [i, pin] of pins.entries()) {
    t.setNow(later(i * (LOCK_MINUTES + 1) * 60 * 1000)); // keeps these tries from adding up to a lockout
    assert.equal((await t.signIn(NAME, pin)).status, 401, JSON.stringify(pin));
  }
  assert.equal((await t.post('/api/supervisor/sign-in', {})).status, 401);
  assert.equal((await t.post('/api/supervisor/sign-in', { name: 5, pin: 5 })).status, 401);
  assert.equal((await t.signIn(NAME, '01234')).status, 200);
});

test('a wrong try is slowed down, also for a name that does not exist', async () => {
  const t = await setup({ failureDelayMs: 60 });
  for (const name of [NAME, 'Nobody Here']) {
    const started = performance.now();
    await t.signIn(name, '99999999');
    assert.ok(performance.now() - started >= 50, name);
  }
});

test(`after ${MAX_FAILURES} wrong tries that person waits ${LOCK_MINUTES} minutes; nobody else does`, async () => {
  const t = await setup();
  await t.add(NAME, NUMBER);
  await t.add('Sample Supervisor 02', '10000002');
  for (let i = 0; i < MAX_FAILURES; i += 1) {
    assert.equal((await t.signIn(NAME, `2000000${i}`)).status, 401);
  }
  const locked = await t.signIn(NAME, NUMBER);
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('set-cookie'), null);
  assert.equal((await t.signIn('Sample Supervisor 02', '10000002')).status, 200);

  t.setNow(later((LOCK_MINUTES + 1) * 60 * 1000));
  assert.equal((await t.signIn(NAME, NUMBER)).status, 200);
});

test('a session stops working after 12 hours, and expired sessions get cleared out', async () => {
  const t = await setup();
  await t.add(NAME, NUMBER);
  const cookie = cookieOf(await t.signIn(NAME, NUMBER));
  t.setNow(later(SESSION_SECONDS * 1000 - 1000));
  assert.equal((await t.get('/api/supervisor/me', cookie)).status, 200);
  t.setNow(later(SESSION_SECONDS * 1000 + 1000));
  assert.equal((await t.get('/api/supervisor/me', cookie)).status, 401);

  await t.signIn(NAME, NUMBER);
  assert.equal(t.count('SELECT count(*) AS n FROM session'), 1);
});

test('signing out ends the session for good, not just the cookie', async () => {
  const t = await setup();
  await t.add(NAME, NUMBER);
  const cookie = cookieOf(await t.signIn(NAME, NUMBER));
  const res = await t.post('/api/supervisor/sign-out', {}, cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`^${SUPERVISOR_COOKIE}=;.*Max-Age=0`));
  assert.equal((await t.get('/api/supervisor/me', cookie)).status, 401);
  assert.equal(t.count('SELECT count(*) AS n FROM session'), 0);
  assert.equal((await t.post('/api/supervisor/sign-out', {})).status, 200); // already out is fine
});

test('a supervisor who is no longer active cannot sign in, and their session stops', async () => {
  const t = await setup();
  await t.add(NAME, NUMBER);
  const cookie = cookieOf(await t.signIn(NAME, NUMBER));
  t.sqlite.prepare('UPDATE supervisor SET active = 0').run();
  assert.equal((await t.get('/api/supervisor/me', cookie)).status, 401);
  assert.equal((await t.signIn(NAME, NUMBER)).status, 401);
});

test('a made-up cookie is refused, and the database holds only a hash of the real one', async () => {
  const t = await setup();
  await t.add(NAME, NUMBER);
  const cookie = cookieOf(await t.signIn(NAME, NUMBER));
  assert.equal((await t.get('/api/supervisor/me')).status, 401);
  assert.equal((await t.get('/api/supervisor/me', `${cookie}x`)).status, 401);
  assert.equal((await t.get('/api/supervisor/me', `${SUPERVISOR_COOKIE}=made-up`)).status, 401);

  const token = cookie.split('=')[1];
  const [row] = t.rows('SELECT id FROM session');
  assert.notEqual(row.id, token);
  assert.equal((await t.get('/api/supervisor/me', `${SUPERVISOR_COOKIE}=${row.id}`)).status, 401);
});

test('a supervisor sign-in gives no admin rights, and an admin sign-in is not a supervisor', async () => {
  const t = await setup();
  await t.add(NAME, NUMBER);
  const token = cookieOf(await t.signIn(NAME, NUMBER)).split('=')[1];
  const night = { date: '2026-10-26', sort: 'Afternoon', rows: [{ lineId: 'PS1', hours: 20, volume: 9647 }] };
  for (const cookie of [`${SUPERVISOR_COOKIE}=${token}`, `${ADMIN_COOKIE}=${token}`]) {
    assert.equal((await t.get('/api/admin/me', cookie)).status, 401);
    assert.equal((await t.post('/api/admin/night', night, cookie)).status, 401);
    assert.equal((await t.post('/api/admin/supervisors', { name: 'New Person', pin: '30000000', role: 'part_time' }, cookie)).status, 401);
  }
  assert.equal(t.count('SELECT count(*) AS n FROM entry'), 0);
  assert.equal((await t.get('/api/supervisor/me', t.admin)).status, 401);
});

test('sign-in and adding supervisors refuse to work until PIN_SALT is set and long enough', async () => {
  for (const PIN_SALT of [undefined, 'too-short']) {
    const t = await setup({}, { PIN_SALT });
    assert.equal((await t.signIn(NAME, NUMBER)).status, 503);
    assert.equal((await t.add(NAME, NUMBER)).status, 503);
    assert.equal(t.count('SELECT count(*) AS n FROM supervisor'), 0);
  }
});

test('only the admin can add a supervisor', async () => {
  const t = await setup();
  const res = await t.post('/api/admin/supervisors', { name: NAME, pin: NUMBER, role: 'part_time' });
  assert.equal(res.status, 401);
  assert.equal(t.count('SELECT count(*) AS n FROM supervisor'), 0);
});

test('a number already in use is refused and nothing is written (D111)', async () => {
  const t = await setup();
  assert.equal((await t.add(NAME, NUMBER)).status, 200);
  const res = await t.add('Sample Supervisor 02', NUMBER);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, errors: [{ lineId: null, message: 'That ID number is already in use.' }] });
  assert.equal(t.count('SELECT count(*) AS n FROM supervisor'), 1);
  assert.equal(t.count("SELECT count(*) AS n FROM audit_log WHERE action = 'added supervisor'"), 1);

  assert.equal((await t.add('Sample Supervisor 03', `0${NUMBER}`)).status, 200); // a leading zero makes it another number
});

test('a number stays taken when its owner is no longer active', async () => {
  const t = await setup();
  await t.add(NAME, NUMBER);
  t.sqlite.prepare('UPDATE supervisor SET active = 0').run();
  assert.equal((await t.add('Sample Supervisor 02', NUMBER)).status, 400);
});

test('a name already in use, a bad number, a bad name and a bad role are all refused', async () => {
  const t = await setup();
  await t.add(NAME, NUMBER);
  const refused: [string, string, string, string][] = [
    ['sample  supervisor 01', '10000002', 'part_time', 'That name is already in use.'],
    ['Other', '123', 'part_time', 'The ID number must be 4 to 12 digits.'],
    ['Other', '12ab5678', 'part_time', 'The ID number must be 4 to 12 digits.'],
    ['   ', '10000002', 'part_time', 'Enter a full name of up to 80 characters.'],
    ['x'.repeat(81), '10000002', 'part_time', 'Enter a full name of up to 80 characters.'],
    ['Other', '10000002', 'manager', 'Pick part-time or full-time.'],
  ];
  for (const [name, pin, role, message] of refused) {
    const res = await t.add(name, pin, role);
    assert.equal(res.status, 400, message);
    assert.deepEqual(await res.json(), { ok: false, errors: [{ lineId: null, message }] });
  }
  assert.equal(t.count('SELECT count(*) AS n FROM supervisor'), 1);
});

test('the number is never stored or logged in plain text, on adding or on a wrong try', async () => {
  const t = await setup();
  await t.add(NAME, NUMBER, 'full_time');
  await t.signIn(NAME, '20000000');
  await t.signIn(NAME, NUMBER);

  const [sup] = t.rows('SELECT pin_hash FROM supervisor');
  assert.match(String(sup.pin_hash), /^[0-9a-f]{64}$/);
  const everything = JSON.stringify([
    t.rows('SELECT * FROM supervisor'),
    t.rows('SELECT * FROM audit_log'),
    t.rows('SELECT * FROM sign_in_failure'),
    t.rows('SELECT * FROM session'),
  ]);
  assert.ok(!everything.includes(NUMBER));
  assert.ok(!everything.includes('20000000'));

  const audit = JSON.stringify(t.rows('SELECT * FROM audit_log'));
  assert.ok(!audit.includes(String(sup.pin_hash)));
  assert.deepEqual(
    t.rows("SELECT actor, action, after FROM audit_log WHERE action = 'added supervisor'").map((r) => ({ ...r })),
    [{ actor: 'admin', action: 'added supervisor', after: JSON.stringify({ name: NAME, role: 'full_time' }) }],
  );
  assert.deepEqual(t.rows('SELECT who FROM sign_in_failure').map((r) => r.who), ['supervisor:1']);
});

test('/sign-in shows the form, with a number keypad, and never gets cached', async () => {
  const t = await setup();
  const res = await t.get('/sign-in');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const page = await res.text();
  assert.match(page, /id="supervisor-sign-in"/);
  assert.match(page, /name="viewport"/);
  assert.match(page, /<input id="pin" type="password" inputmode="numeric"/);
});

test('once signed in, /sign-in shows who you are, with the name made safe for the page', async () => {
  const t = await setup();
  await t.add('Pat <b>Sample</b>', NUMBER);
  const cookie = cookieOf(await t.signIn('Pat <b>Sample</b>', NUMBER));
  const page = await (await t.get('/sign-in', cookie)).text();
  assert.match(page, /Pat &lt;b&gt;Sample&lt;\/b&gt;/);
  assert.ok(!page.includes('<b>Sample'));
  assert.ok(!page.includes('id="supervisor-sign-in"'));
});

test('the supervisors page is admin only, lists names and roles, and shows no numbers or hashes', async () => {
  const t = await setup();
  const out = await t.get('/admin/supervisors');
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), '/admin');

  assert.match(await (await t.get('/admin/supervisors', t.admin)).text(), /No supervisors yet/);

  await t.add('Sample Supervisor 02', '10000002');
  await t.add(NAME, NUMBER, 'full_time');
  const res = await t.get('/admin/supervisors', t.admin);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const page = await res.text();
  assert.equal((page.match(/<tr data-supervisor>/g) ?? []).length, 2);
  assert.ok(page.indexOf(NAME) < page.indexOf('Sample Supervisor 02'));
  assert.match(page, /Full-time/);
  assert.ok(!page.includes(NUMBER));
  for (const row of t.rows('SELECT pin_hash FROM supervisor')) assert.ok(!page.includes(String(row.pin_hash)));
});
