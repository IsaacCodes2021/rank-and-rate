import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Shim } from '../../db/d1-shim.ts';
import { migrate, openDb, seed } from '../../db/lib.ts';
import { createApp, type Env } from './app.ts';

const SIGNUP = 'test-signup-code';
const CODE = 'test-only-code-1234';
const PDT = '-07:00';
const at = (time: string, date = '2026-10-30') => new Date(`${date}T${time}:00${PDT}`);
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const slotAt = (d: Date) => d.getTime() / FIFTEEN_MINUTES;

async function setup() {
  const sqlite = openDb(':memory:');
  migrate(sqlite);
  seed(sqlite);
  let now = at('13:00');
  const app = createApp({ now: () => now, failureDelayMs: 0 });
  const env: Env = { DB: d1Shim(sqlite), ADMIN_CODE: CODE, SESSION_SECRET: 's'.repeat(40), PIN_SALT: 'p'.repeat(40), SIGNUP_CODE: SIGNUP };
  const post = (path: string, body: unknown, cookie?: string) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }, env);
  const get = (path: string, cookie?: string) => app.request(path, { headers: cookie ? { cookie } : {} }, env);
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];
  const pick = (cookie: string, sort: string, lines: unknown) => post('/api/supervisor/shift', { sort, lines }, cookie);
  let people = 0;
  return {
    sqlite,
    get,
    post,
    pick,
    setNow: (d: Date) => {
      now = d;
    },
    join: async (name = 'Sample Supervisor 01') => {
      people += 1;
      const res = await post('/api/supervisor/sign-up', { code: SIGNUP, name, pin: `1000000${people}`, role: 'part_time' });
      assert.equal(res.status, 200);
      return cookieOf(res);
    },
    admin: async () => cookieOf(await post('/api/admin/sign-in', { code: CODE })),
    start: async (cookie: string, sort: string, lines: string[]) => {
      const res = await pick(cookie, sort, lines);
      assert.equal(res.status, 200);
      return ((await res.json()) as { shiftId: number }).shiftId;
    },
    lines: (cookie: string, shiftId: unknown, lines: unknown) => post('/api/supervisor/shift/lines', { shiftId, lines }, cookie),
    update: (cookie: string, shiftId: unknown, rows: unknown) => post('/api/supervisor/update', { shiftId, rows }, cookie),
    final: (cookie: string, shiftId: unknown, rows: unknown) => post('/api/supervisor/final', { shiftId, rows }, cookie),
    // Follows redirects, as a phone would.
    page: async (path: string, cookie: string) => {
      let res = await get(path, cookie);
      while (res.status === 302) res = await get(res.headers.get('location') as string, cookie);
      return res.text();
    },
    rows: (sql: string) => (sqlite.prepare(sql).all() as Record<string, unknown>[]).map((r) => ({ ...r })),
    one: (sql: string) => ({ ...(sqlite.prepare(sql).get() as Record<string, unknown>) }),
    count: (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n,
  };
}

const errorsOf = async (res: Response) => ((await res.json()) as { errors: { lineId: string | null; message: string }[] }).errors;
const NOT_OPEN = 'That sort is not open for you. Go back to your sorts and try again.';

test('every shift screen and save needs a supervisor sign-in', async () => {
  const t = await setup();
  for (const path of ['/shift', '/shift/start', '/shift/1', '/shift/1/lines', '/shift/1/final']) {
    const res = await t.get(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), '/sign-in');
  }
  const admin = await t.admin();
  for (const cookie of [undefined, admin]) {
    assert.equal((await t.post('/api/supervisor/shift', { sort: 'Afternoon', lines: ['PS1'] }, cookie)).status, 401);
    assert.equal((await t.post('/api/supervisor/shift/lines', { shiftId: 1, lines: ['PS1'] }, cookie)).status, 401);
    assert.equal((await t.post('/api/supervisor/update', { shiftId: 1, rows: [{ lineId: 'PS1', headcount: 5, volume: 100 }] }, cookie)).status, 401);
    assert.equal((await t.post('/api/supervisor/final', { shiftId: 1, rows: [{ lineId: 'PS1', volume: 100 }] }, cookie)).status, 401);
  }
  assert.equal(t.count('SELECT count(*) AS n FROM entry'), 0);
  assert.equal(t.count('SELECT count(*) AS n FROM shift'), 0);
});

test('a supervisor with no sort sees the start screen, with the sorts and every active line', async () => {
  const t = await setup();
  t.sqlite.prepare("UPDATE line SET active = 0 WHERE id = 'PD2'").run();
  const res = await t.get('/shift', await t.join());
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const page = await res.text();
  assert.match(page, /id="start-shift"/);
  assert.deepEqual([...page.matchAll(/type="radio" name="sort" value="([^"]+)"/g)].map((m) => m[1]), ['Afternoon', 'Morning', 'Twilight']);
  assert.ok(!page.includes(' checked'), 'nothing is ticked for a first-timer, and the sort is never guessed');
  assert.equal((page.match(/name="line"/g) ?? []).length, 26);
  assert.ok(!page.includes('value="PD2"'));
  assert.ok(!page.includes('value="PS13"'));
  assert.ok(!page.includes('>Back</a>')); // nowhere to go back to yet
});

test("picking a sort and lines starts it, dated in the building's time zone", async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1', 'PD3']);

  assert.deepEqual(t.rows('SELECT id, date, sort, starts_at, ends_at, status FROM shift'), [
    { id, date: '2026-10-30', sort: 'Afternoon', starts_at: null, ends_at: null, status: 'open' },
  ]);
  assert.deepEqual(t.rows('SELECT line_id, supervisor_id, started_at FROM assignment ORDER BY line_id'), [
    { line_id: 'PD3', supervisor_id: 1, started_at: at('13:00').toISOString() },
    { line_id: 'PS1', supervisor_id: 1, started_at: at('13:00').toISOString() },
  ]);
  assert.equal(t.count("SELECT count(*) AS n FROM audit_log WHERE action = 'started sort' AND actor = 'Sample Supervisor 01'"), 1);

  const page = await t.page('/shift', me);
  assert.match(page, /<h1>Afternoon update<\/h1>/);
  assert.match(page, new RegExp(`id="update" data-shift="${id}"`));
  assert.deepEqual([...page.matchAll(/<tr data-line="([^"]+)"/g)].map((m) => m[1]), ['PS1', 'PD3']);
});

test("late in the evening the date is still the building's date, not UTC's", async () => {
  const t = await setup();
  const me = await t.join();
  t.setNow(at('18:30')); // already the next day in UTC
  await t.start(me, 'Twilight', ['PS1']);
  assert.equal(t.one('SELECT date FROM shift').date, '2026-10-30');
});

test('a bad pick is refused and nothing is written', async () => {
  const t = await setup();
  const me = await t.join();
  t.sqlite.prepare("UPDATE line SET active = 0 WHERE id = 'PD2'").run();
  const refused: [string, unknown, string][] = [
    ['', ['PS1'], 'Choose the sort first.'],
    ['Night', ['PS1'], 'Choose the sort first.'],
    ['Afternoon', [], 'Pick at least one line.'],
    ['Afternoon', 'PS1', 'Pick at least one line.'],
    ['Afternoon', ['PS13'], 'Unknown or inactive line.'],
    ['Afternoon', ['PD2'], 'Unknown or inactive line.'],
    ['Afternoon', [5], 'Unknown or inactive line.'],
  ];
  for (const [sort, lines, message] of refused) {
    const res = await t.pick(me, sort, lines);
    assert.equal(res.status, 400, message);
    assert.deepEqual((await errorsOf(res)).map((e) => e.message), [message]);
  }
  assert.equal(t.count('SELECT count(*) AS n FROM shift'), 0);
  assert.equal(t.count('SELECT count(*) AS n FROM assignment'), 0);
});

test('updates are saved per quarter hour; the first one sets the start of the sort (D066)', async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1']);

  t.setNow(at('13:14'));
  assert.equal((await t.update(me, id, [{ lineId: 'PS1', headcount: 5, volume: 500 }])).status, 200);
  assert.equal(t.one('SELECT starts_at FROM shift').starts_at, at('13:00').toISOString()); // 13:14 - 15 min, nearest 5

  t.setNow(at('13:31'));
  await t.update(me, id, [{ lineId: 'PS1', headcount: '6', volume: '1200' }]);
  assert.equal(t.one('SELECT starts_at FROM shift').starts_at, at('13:00').toISOString()); // only the first entry sets it

  assert.deepEqual(t.rows('SELECT line_id, supervisor_id, slot, kind, headcount, running_volume, total_hours FROM entry ORDER BY slot'), [
    { line_id: 'PS1', supervisor_id: 1, slot: slotAt(at('13:15')), kind: 'interval', headcount: 5, running_volume: 500, total_hours: null },
    { line_id: 'PS1', supervisor_id: 1, slot: slotAt(at('13:30')), kind: 'interval', headcount: 6, running_volume: 1200, total_hours: null },
  ]);

  // Worked numbers: 5 x 0.25 + 6 x 0.25 = 2.75 hours; 1,200 / 2.75 = 436 PPH.
  const page = await t.page('/shift', me);
  assert.match(page, /Last: 6 people · 1,200 pieces at 1:31 PM · 436 PPH/);
  assert.match(page, /data-last-head="6"/);
  assert.match(page, /aria-label="PS1 people"[^>]*value="6"/);
});

test('a second update in the same quarter hour replaces the first, and the audit log keeps both', async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1']);
  t.setNow(at('13:14'));
  await t.update(me, id, [{ lineId: 'PS1', headcount: 5, volume: 500 }]);
  t.setNow(at('13:16'));
  await t.update(me, id, [{ lineId: 'PS1', headcount: 5, volume: 550 }]);

  assert.deepEqual(t.rows('SELECT headcount, running_volume FROM entry'), [{ headcount: 5, running_volume: 550 }]);
  const logged = t.rows("SELECT action, before, after FROM audit_log WHERE action LIKE 'update %' ORDER BY id");
  assert.deepEqual(logged.map((r) => r.action), ['update saved', 'update changed']);
  assert.equal(logged[0].before, null);
  assert.equal(JSON.parse(String(logged[1].before)).volume, 500);
  assert.equal(JSON.parse(String(logged[1].after)).volume, 550);
});

test('sorts never mix: one takes its finals while the next takes its first update, on the same line', async () => {
  const t = await setup();
  const day = await t.join('Sample Supervisor 01');
  const night = await t.join('Sample Supervisor 02');
  const afternoon = await t.start(day, 'Afternoon', ['PS1', 'PS2']);
  t.setNow(at('13:15'));
  await t.update(day, afternoon, [{ lineId: 'PS1', headcount: 8, volume: 1000 }, { lineId: 'PS2', headcount: 4, volume: 300 }]);

  // The same line, in the same quarter hour, in two different sorts.
  t.setNow(at('18:15'));
  const twilight = await t.start(night, 'Twilight', ['PS1']);
  assert.notEqual(afternoon, twilight);
  assert.equal((await t.final(day, afternoon, [{ lineId: 'PS1', volume: 5000 }, { lineId: 'PS2', volume: 900 }])).status, 200);
  assert.equal((await t.update(night, twilight, [{ lineId: 'PS1', headcount: 3, volume: 200 }])).status, 200);

  assert.deepEqual(t.rows('SELECT sort, starts_at, ends_at, status FROM shift ORDER BY sort'), [
    { sort: 'Afternoon', starts_at: at('13:00').toISOString(), ends_at: at('18:15').toISOString(), status: 'final' },
    { sort: 'Twilight', starts_at: at('18:00').toISOString(), ends_at: null, status: 'open' },
  ]);
  assert.deepEqual(
    t.rows("SELECT s.sort, e.line_id, e.kind, e.headcount, e.running_volume, e.supervisor_id FROM entry e JOIN shift s ON s.id = e.shift_id WHERE e.line_id = 'PS1' ORDER BY s.sort, e.kind"),
    [
      { sort: 'Afternoon', line_id: 'PS1', kind: 'final', headcount: null, running_volume: 5000, supervisor_id: 1 },
      { sort: 'Afternoon', line_id: 'PS1', kind: 'interval', headcount: 8, running_volume: 1000, supervisor_id: 1 },
      { sort: 'Twilight', line_id: 'PS1', kind: 'interval', headcount: 3, running_volume: 200, supervisor_id: 2 },
    ],
  );

  // Each sort's totals are its own: hours, volume and PPH take nothing from the other.
  const admin = await t.admin();
  const night1 = await (await t.get('/api/admin/night?date=2026-10-30&sort=Afternoon', admin)).json();
  assert.deepEqual(night1, { ok: true, rows: [{ lineId: 'PS1', hours: 2, volume: 5000 }, { lineId: 'PS2', hours: 1, volume: 900 }] });
  const page = await t.page(`/shift/${twilight}`, night);
  assert.match(page, /Last: 3 people · 200 pieces at 6:15 PM · 267 PPH/); // 200 / 0.75 hours
  assert.ok(!page.includes('5,000'));
});

test('one supervisor can work two sorts at once, and each save goes to the sort on its screen', async () => {
  const t = await setup();
  const me = await t.join();
  const afternoon = await t.start(me, 'Afternoon', ['PS1', 'PS2']);
  t.setNow(at('13:15'));
  await t.update(me, afternoon, [{ lineId: 'PS1', headcount: 8, volume: 1000 }]);

  // Starting Twilight leaves Afternoon exactly as it was, including the line with no entries yet.
  t.setNow(at('18:15'));
  const twilight = await t.start(me, 'Twilight', ['PS1']);
  assert.equal(t.count('SELECT count(*) AS n FROM assignment WHERE shift_id = ' + afternoon), 2);

  // The Afternoon screen was left open on the phone. Its final still goes to Afternoon, not to
  // Twilight, which is the sort they picked most recently.
  assert.equal((await t.final(me, afternoon, [{ lineId: 'PS1', volume: 5000 }])).status, 200);
  assert.equal((await t.update(me, twilight, [{ lineId: 'PS1', headcount: 3, volume: 200 }])).status, 200);

  assert.deepEqual(
    t.rows('SELECT s.sort, e.kind, e.running_volume FROM entry e JOIN shift s ON s.id = e.shift_id ORDER BY s.sort, e.kind'),
    [
      { sort: 'Afternoon', kind: 'final', running_volume: 5000 },
      { sort: 'Afternoon', kind: 'interval', running_volume: 1000 },
      { sort: 'Twilight', kind: 'interval', running_volume: 200 },
    ],
  );
  assert.equal(t.one('SELECT ends_at FROM shift WHERE id = ' + twilight).ends_at, null); // Afternoon's final did not end Twilight
  assert.equal(t.one('SELECT status FROM shift WHERE id = ' + afternoon).status, 'open'); // PS2 still has no final
});

test('with two sorts open the supervisor chooses; each screen names its sort and links the other', async () => {
  const t = await setup();
  const me = await t.join();
  const afternoon = await t.start(me, 'Afternoon', ['PS1']);
  t.setNow(at('18:15'));
  const twilight = await t.start(me, 'Twilight', ['PD1', 'PD2']);

  const list = await t.page('/shift', me);
  assert.match(list, /<h1>Your sorts<\/h1>/);
  assert.equal((list.match(/<tr data-sort=/g) ?? []).length, 2);
  assert.match(list, new RegExp(`href="/shift/${afternoon}">Afternoon</a>`));
  assert.match(list, new RegExp(`href="/shift/${twilight}">Twilight</a>`));

  const screen = await t.page(`/shift/${afternoon}`, me);
  assert.match(screen, /<h1>Afternoon update<\/h1>/);
  assert.match(screen, new RegExp(`Also open: <a class="link" href="/shift/${twilight}">Twilight</a>`));
  assert.match(await t.page(`/shift/${afternoon}/final`, me), /<h1>Afternoon final<\/h1>/);
  assert.match(await t.page(`/shift/${twilight}/lines`, me), /<h1>Twilight lines<\/h1>/);

  // With Afternoon's finals in, only Twilight is left, so /shift goes straight to it.
  t.setNow(at('18:20'));
  await t.final(me, afternoon, [{ lineId: 'PS1', volume: 5000 }]);
  assert.match(await t.page('/shift', me), /<h1>Twilight update<\/h1>/);
  assert.ok(!(await t.page(`/shift/${twilight}`, me)).includes('Also open'));
});

test('a line on my other sort is not one of my lines on this sort', async () => {
  const t = await setup();
  const me = await t.join();
  const afternoon = await t.start(me, 'Afternoon', ['PS1']);
  const twilight = await t.start(me, 'Twilight', ['PD1']);
  t.setNow(at('13:15'));
  const res = await t.update(me, afternoon, [{ lineId: 'PD1', headcount: 5, volume: 500 }]);
  assert.equal(res.status, 400);
  assert.deepEqual(await errorsOf(res), [{ lineId: 'PD1', message: 'That is not one of your lines on this sort.' }]);
  assert.deepEqual(await errorsOf(await t.final(me, twilight, [{ lineId: 'PS1', volume: 500 }])), [{ lineId: 'PS1', message: 'That is not one of your lines on this sort.' }]);
  assert.equal(t.count('SELECT count(*) AS n FROM entry'), 0);
});

test('a save must name a sort that is open to this supervisor', async () => {
  const t = await setup();
  const me = await t.join();
  const other = await t.join('Sample Supervisor 02');
  const theirs = await t.start(other, 'Afternoon', ['PS1']);
  const mine = await t.start(me, 'Twilight', ['PS2']);
  t.setNow(at('13:15'));
  const row = [{ lineId: 'PS1', headcount: 5, volume: 500 }];

  for (const shiftId of [theirs, 999, undefined, null, 'abc', String(mine), 1.5]) {
    for (const res of [await t.update(me, shiftId, row), await t.final(me, shiftId, row), await t.lines(me, shiftId, ['PS1'])]) {
      assert.equal(res.status, 400, String(shiftId));
      assert.deepEqual(await errorsOf(res), [{ lineId: null, message: NOT_OPEN }]);
    }
  }
  assert.equal(t.count('SELECT count(*) AS n FROM entry'), 0);
  assert.equal(t.count('SELECT count(*) AS n FROM assignment'), 2);
  for (const path of [`/shift/${theirs}`, `/shift/${theirs}/final`, `/shift/${theirs}/lines`, '/shift/999']) {
    const res = await t.get(path, me);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), '/shift');
  }
});

test("a supervisor can only enter for their own lines, and nothing else saves with it", async () => {
  const t = await setup();
  const me = await t.join();
  const other = await t.join('Sample Supervisor 02');
  const id = await t.start(me, 'Afternoon', ['PS1']);
  await t.start(other, 'Afternoon', ['PS2']);
  t.setNow(at('13:15'));

  const update = await t.update(me, id, [{ lineId: 'PS1', headcount: 5, volume: 500 }, { lineId: 'PS2', headcount: 5, volume: 500 }]);
  assert.equal(update.status, 400);
  assert.deepEqual(await errorsOf(update), [{ lineId: 'PS2', message: 'That is not one of your lines on this sort.' }]);

  const final = await t.final(me, id, [{ lineId: 'PS2', volume: 500 }]);
  assert.equal(final.status, 400);
  assert.deepEqual(await errorsOf(final), [{ lineId: 'PS2', message: 'That is not one of your lines on this sort.' }]);

  assert.equal(t.count('SELECT count(*) AS n FROM entry'), 0);
  assert.equal(t.one('SELECT starts_at FROM shift').starts_at, null);
});

test('blank rows are skipped; a bad row refuses the whole save', async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1', 'PS2']);
  t.setNow(at('13:15'));

  const saved = await t.update(me, id, [{ lineId: 'PS1', headcount: 5, volume: 500 }, { lineId: 'PS2', headcount: '', volume: '' }]);
  assert.deepEqual(await saved.json(), { ok: true, saved: 1, skipped: 1 });

  const bad: [unknown, unknown, string][] = [
    [5, '', 'Enter both people and volume, or leave both blank.'],
    ['', 500, 'Enter both people and volume, or leave both blank.'],
    [-1, 500, 'People must be a whole number from 0 to 200.'],
    [201, 500, 'People must be a whole number from 0 to 200.'],
    [2.5, 500, 'People must be a whole number from 0 to 200.'],
    ['five', 500, 'People must be a whole number from 0 to 200.'],
    [5, -1, 'Volume must be a whole number from 0 to 1000000.'],
    [5, 1000001, 'Volume must be a whole number from 0 to 1000000.'],
    [5, 1.5, 'Volume must be a whole number from 0 to 1000000.'],
  ];
  t.setNow(at('13:30'));
  for (const [headcount, volume, message] of bad) {
    const res = await t.update(me, id, [{ lineId: 'PS1', headcount: 6, volume: 900 }, { lineId: 'PS2', headcount, volume }]);
    assert.equal(res.status, 400, message);
    assert.deepEqual(await errorsOf(res), [{ lineId: 'PS2', message }]);
  }
  assert.equal(t.count('SELECT count(*) AS n FROM entry'), 1);

  assert.deepEqual(await errorsOf(await t.update(me, id, [{ lineId: 'PS1', headcount: '', volume: '' }])), [{ lineId: null, message: 'Nothing to save: every row is blank.' }]);
  assert.deepEqual(await errorsOf(await t.update(me, id, 'junk')), [{ lineId: null, message: 'Nothing to save: every row is blank.' }]);
  assert.equal((await t.update(me, id, [null, 5, 'x'])).status, 400);
  assert.equal((await t.update(me, id, [{ lineId: 'PS1', headcount: { a: 1 }, volume: [500] }])).status, 400);
  assert.equal(t.count('SELECT count(*) AS n FROM entry'), 1);
});

test('finals close the sort only once every assigned line has one, across supervisors', async () => {
  const t = await setup();
  const me = await t.join();
  const other = await t.join('Sample Supervisor 02');
  const id = await t.start(me, 'Afternoon', ['PS1', 'PS2']);
  assert.equal(await t.start(other, 'Afternoon', ['PD1']), id); // the same sort on the same day is one shift
  t.setNow(at('13:15'));
  await t.update(me, id, [{ lineId: 'PS1', headcount: 4, volume: 400 }, { lineId: 'PS2', headcount: 4, volume: 300 }]);

  t.setNow(at('17:00'));
  assert.deepEqual(await (await t.final(me, id, [{ lineId: 'PS1', volume: 5000 }, { lineId: 'PS2', volume: '' }])).json(), { ok: true, saved: 1, skipped: 1 });
  assert.deepEqual(t.one('SELECT status, ends_at FROM shift'), { status: 'open', ends_at: at('17:00').toISOString() });

  // An open line can still be updated; the finished line cannot.
  t.setNow(at('17:15'));
  const late = await t.update(me, id, [{ lineId: 'PS1', headcount: 4, volume: 5100 }]);
  assert.deepEqual(await errorsOf(late), [{ lineId: 'PS1', message: 'This line already has its final update.' }]);
  assert.equal((await t.update(me, id, [{ lineId: 'PS2', headcount: 4, volume: 3000 }])).status, 200);

  t.setNow(at('17:30'));
  await t.final(me, id, [{ lineId: 'PS2', volume: 3500 }]);
  assert.equal(t.one('SELECT status FROM shift').status, 'open'); // PD1 is still out

  t.setNow(at('17:45'));
  await t.final(other, id, [{ lineId: 'PD1', volume: 900 }]);
  assert.deepEqual(t.one('SELECT status, ends_at FROM shift'), { status: 'final', ends_at: at('17:45').toISOString() });
});

test("a final carries no hours; they come from the updates, for the admin's screen too", async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1']);
  t.setNow(at('13:15'));
  await t.update(me, id, [{ lineId: 'PS1', headcount: 8, volume: 400 }]);
  t.setNow(at('13:30'));
  await t.update(me, id, [{ lineId: 'PS1', headcount: 8, volume: 800 }]);
  t.setNow(at('17:00'));
  await t.final(me, id, [{ lineId: 'PS1', volume: 2000 }]);

  assert.deepEqual(t.rows("SELECT supervisor_id, slot, headcount, running_volume, total_hours FROM entry WHERE kind = 'final'"), [
    { supervisor_id: 1, slot: null, headcount: null, running_volume: 2000, total_hours: null },
  ]);
  const admin = await t.admin();
  const night = await (await t.get('/api/admin/night?date=2026-10-30&sort=Afternoon', admin)).json();
  assert.deepEqual(night, { ok: true, rows: [{ lineId: 'PS1', hours: 4, volume: 2000 }] });
});

test('with every final in, the supervisor sees a summary and can still correct a final', async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1']);
  t.setNow(at('13:15'));
  await t.update(me, id, [{ lineId: 'PS1', headcount: 8, volume: 400 }]);
  t.setNow(at('17:00'));
  await t.final(me, id, [{ lineId: 'PS1', volume: 2000 }]);

  // Worked numbers: 8 x 0.25 = 2 hours; 2,000 / 2 = 1,000 PPH.
  const page = await t.page(`/shift/${id}`, me);
  assert.match(page, /<h1>Afternoon: check your numbers<\/h1>/);
  assert.match(page, /id="looks-right"[^>]*>Looks right, sign out</);
  assert.match(page, /<td class="line">PS1<\/td><td>2<\/td><td>2,000<\/td><td>1,000<\/td>/);
  assert.match(page, /href="\/shift\/start"/);
  assert.match(await t.page(`/shift/${id}/final`, me), /aria-label="PS1 final volume"[^>]*value="2000"/);

  t.setNow(at('17:05'));
  await t.final(me, id, [{ lineId: 'PS1', volume: 2100 }]);
  assert.equal(t.one("SELECT running_volume FROM entry WHERE kind = 'final'").running_volume, 2100);
  assert.equal(t.one('SELECT ends_at FROM shift').ends_at, at('17:05').toISOString());
  const logged = t.rows("SELECT action, before FROM audit_log WHERE action LIKE 'final %' ORDER BY id");
  assert.deepEqual(logged.map((r) => r.action), ['final saved', 'final changed']);
  assert.equal(JSON.parse(String(logged[1].before)).volume, 2000);
});

test('a bad final refuses the whole save; a final with no updates still sets the start', async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1', 'PS2']);
  t.setNow(at('17:00'));
  const bad = await t.final(me, id, [{ lineId: 'PS1', volume: 500 }, { lineId: 'PS2', volume: 'lots' }]);
  assert.deepEqual(await errorsOf(bad), [{ lineId: 'PS2', message: 'Volume must be a whole number from 0 to 1000000.' }]);
  assert.equal(t.count('SELECT count(*) AS n FROM entry'), 0);
  assert.deepEqual(await errorsOf(await t.final(me, id, [])), [{ lineId: null, message: 'Nothing to save: every row is blank.' }]);

  await t.final(me, id, [{ lineId: 'PS1', volume: 500 }]);
  assert.equal(t.one('SELECT starts_at FROM shift').starts_at, at('16:45').toISOString());
  assert.match(await t.page('/shift', me), /PS1<\/strong> final is in: 500 pieces/);
  assert.match(await t.page(`/shift/${id}/final`, me), /Last: 500 pieces at 5:00 PM · no PPH yet/);
});

test('lines can be added and dropped, but a line with their entries stays', async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1', 'PS2']);
  t.setNow(at('13:15'));
  await t.update(me, id, [{ lineId: 'PS1', headcount: 5, volume: 500 }]);

  const page = await t.page(`/shift/${id}/lines`, me);
  assert.match(page, /name="line" value="PS1" checked disabled/);
  assert.match(page, /name="line" value="PS2" checked>/);
  assert.match(page, /name="line" value="PS3">/);
  assert.match(page, new RegExp(`data-shift="${id}"`));

  assert.equal((await t.lines(me, id, ['PS3'])).status, 200); // drops PS2, adds PS3, and PS1 stays
  assert.deepEqual(t.rows('SELECT line_id, started_at FROM assignment ORDER BY line_id'), [
    { line_id: 'PS1', started_at: at('13:00').toISOString() },
    { line_id: 'PS3', started_at: at('13:15').toISOString() },
  ]);
  assert.deepEqual((await errorsOf(await t.lines(me, id, ['PS13']))).map((e) => e.message), ['Unknown or inactive line.']);
  assert.equal(t.count("SELECT count(*) AS n FROM audit_log WHERE action = 'changed lines'"), 1);
});

test('a sort picked by mistake can be left, and leaves nothing behind or touches the other sort', async () => {
  const t = await setup();
  const me = await t.join();
  const afternoon = await t.start(me, 'Afternoon', ['PS1']);
  t.setNow(at('13:15'));
  await t.update(me, afternoon, [{ lineId: 'PS1', headcount: 5, volume: 500 }]);
  const mistake = await t.start(me, 'Twilight', ['PS1']);

  assert.equal((await t.lines(me, mistake, [])).status, 200);
  assert.deepEqual(t.rows('SELECT sort FROM shift'), [{ sort: 'Afternoon' }]);
  assert.equal(t.count('SELECT count(*) AS n FROM assignment'), 1);
  assert.match(await t.page('/shift', me), /<h1>Afternoon update<\/h1>/);
});

test('a sort someone else is on is not removed when one supervisor leaves it', async () => {
  const t = await setup();
  const me = await t.join();
  const other = await t.join('Sample Supervisor 02');
  const id = await t.start(me, 'Twilight', ['PS1']);
  await t.start(other, 'Twilight', ['PS2']);
  await t.lines(me, id, []);
  assert.deepEqual(t.rows('SELECT sort, status FROM shift'), [{ sort: 'Twilight', status: 'open' }]);
  assert.deepEqual(t.rows('SELECT line_id FROM assignment'), [{ line_id: 'PS2' }]);
});

test('a new line reopens a closed sort until it has its final too', async () => {
  const t = await setup();
  const me = await t.join();
  const other = await t.join('Sample Supervisor 02');
  const id = await t.start(me, 'Afternoon', ['PS1']);
  t.setNow(at('17:00'));
  await t.final(me, id, [{ lineId: 'PS1', volume: 2000 }]);
  assert.equal(t.one('SELECT status FROM shift').status, 'final');

  await t.start(other, 'Afternoon', ['PS2']);
  assert.equal(t.one('SELECT status FROM shift').status, 'open');
  t.setNow(at('17:30'));
  await t.final(other, id, [{ lineId: 'PS2', volume: 1000 }]);
  assert.equal(t.one('SELECT status FROM shift').status, 'final');
});

test('the same sort on the same night is one shift, shared with what the admin saved', async () => {
  const t = await setup();
  const me = await t.join();
  const admin = await t.admin();
  await t.post('/api/admin/night', { date: '2026-10-30', sort: 'Afternoon', rows: [{ lineId: 'PD1', hours: 10, volume: 2000 }] }, admin);

  const id = await t.start(me, 'Afternoon', ['PS1']);
  assert.equal(t.count('SELECT count(*) AS n FROM shift'), 1);
  assert.equal(t.one('SELECT status FROM shift').status, 'open');
  t.setNow(at('17:00'));
  await t.final(me, id, [{ lineId: 'PS1', volume: 500 }]);
  assert.equal(t.one('SELECT status FROM shift').status, 'final');
  assert.equal(t.one("SELECT total_hours FROM entry WHERE line_id = 'PD1'").total_hours, 10);
});

test('a sort past midnight keeps its date; a phone left on it cannot save once it has aged out', async () => {
  const t = await setup();
  const me = await t.join();
  t.setNow(at('18:30'));
  const id = await t.start(me, 'Twilight', ['PS1']);

  t.setNow(at('00:10', '2026-10-31'));
  assert.equal(await t.start(me, 'Twilight', ['PS2']), id); // still that night's Twilight
  assert.deepEqual(t.rows('SELECT date, sort FROM shift'), [{ date: '2026-10-30', sort: 'Twilight' }]);
  assert.equal((await t.update(me, id, [{ lineId: 'PS1', headcount: 5, volume: 500 }])).status, 200);

  t.setNow(at('18:00', '2026-10-31')); // about 18 hours later; the 12-hour sign-in has run out too
  const signedInAgain = await t.post('/api/supervisor/sign-in', { name: 'Sample Supervisor 01', pin: '10000001' });
  const cookie = (signedInAgain.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(await t.page('/shift', cookie), /id="start-shift"/);

  const stale = await t.update(cookie, id, [{ lineId: 'PS1', headcount: 5, volume: 900 }]);
  assert.deepEqual(await errorsOf(stale), [{ lineId: null, message: NOT_OPEN }]);
  assert.equal(t.count('SELECT count(*) AS n FROM entry'), 1);

  // Tonight's Twilight is a new shift, with nothing carried over.
  const tonight = await t.start(cookie, 'Twilight', ['PS1']);
  assert.notEqual(tonight, id);
  assert.match(await t.page(`/shift/${tonight}`, cookie), /No updates yet/);
});

test("someone else's entries on a shared line count toward its totals on that sort", async () => {
  const t = await setup();
  const me = await t.join();
  const other = await t.join('Sample Supervisor 02');
  const id = await t.start(me, 'Afternoon', ['PS1']);
  await t.start(other, 'Afternoon', ['PS1']);
  t.setNow(at('13:15'));
  await t.update(me, id, [{ lineId: 'PS1', headcount: 4, volume: 400 }]);
  t.setNow(at('13:30'));
  await t.update(other, id, [{ lineId: 'PS1', headcount: 4, volume: 800 }]);

  assert.deepEqual(t.rows('SELECT supervisor_id, running_volume FROM entry ORDER BY slot'), [
    { supervisor_id: 1, running_volume: 400 },
    { supervisor_id: 2, running_volume: 800 },
  ]);
  assert.match(await t.page('/shift', me), /800 pieces at 1:30 PM · 400 PPH/); // 800 / 2 hours
});

test('the update screen has number keypads, one Save, and links to the other screens', async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1', 'PD14']);
  const page = await t.page('/shift', me);
  assert.equal((page.match(/inputmode="numeric"/g) ?? []).length, 4);
  assert.equal((page.match(/enterkeyhint="done"/g) ?? []).length, 1);
  assert.match(page, /aria-label="PD14 running volume"[^>]*enterkeyhint="done"/);
  assert.equal((page.match(/type="submit"/g) ?? []).length, 1);
  for (const href of [`/shift/${id}/final`, `/shift/${id}/lines`, '/shift/start']) assert.ok(page.includes(`href="${href}"`), href);
  assert.ok(!page.includes('pin'), 'no PIN on the update screen (D032)');
});

test('the next sort starts with the lines from last time ticked, but never a guessed sort', async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1', 'PD3']);
  t.setNow(at('17:00'));
  await t.final(me, id, [{ lineId: 'PS1', volume: 500 }, { lineId: 'PD3', volume: 400 }]);

  const page = await t.page('/shift/start', me);
  assert.match(page, /name="line" value="PS1" checked>/);
  assert.match(page, /name="line" value="PD3" checked>/);
  assert.match(page, /name="line" value="PS2">/);
  assert.ok(!/name="sort"[^>]* checked/.test(page));

  // Everybody's lines are their own.
  const other = await t.join('Sample Supervisor 02');
  assert.ok(!(await t.page('/shift/start', other)).includes(' checked'));
});

test('coming back after finishing a sort goes straight to the next one, with the finished one a tap away', async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1']);
  t.setNow(at('17:00'));
  await t.final(me, id, [{ lineId: 'PS1', volume: 500 }]);
  const page = await t.page('/shift', me);
  assert.match(page, /id="start-shift"/);
  assert.match(page, /name="line" value="PS1" checked>/);
  assert.match(page, new RegExp(`id="finished">Finished: <a class="link" href="/shift/${id}">Afternoon</a>`));
});

test('a line taken off the list since last time is not ticked', async () => {
  const t = await setup();
  const me = await t.join();
  await t.start(me, 'Afternoon', ['PS1', 'PD2']);
  t.sqlite.prepare("UPDATE line SET active = 0 WHERE id = 'PD2'").run();
  const page = await t.page('/shift/start', me);
  assert.match(page, /name="line" value="PS1" checked>/);
  assert.ok(!page.includes('value="PD2"'));
});

test('after an update the screen says it saved and when the next one is due', async () => {
  const t = await setup();
  const me = await t.join();
  const id = await t.start(me, 'Afternoon', ['PS1']);
  assert.ok(!(await t.page(`/shift/${id}`, me)).includes('Next update'), 'nothing to say before the first update');

  t.setNow(at('13:14'));
  await t.update(me, id, [{ lineId: 'PS1', headcount: 5, volume: 500 }]);
  assert.match(await t.page(`/shift/${id}?saved=1`, me), /id="saved">Saved\. Next update around 1:30 PM\./);

  t.setNow(at('13:31'));
  const later = await t.page(`/shift/${id}`, me);
  assert.match(later, /id="next">Next update around 1:45 PM/);
  assert.ok(!later.includes('id="saved"'));
});

test('verification: the last final leads to the numbers, then one tap signs out or goes on to the next sort', async () => {
  const t = await setup();
  const me = await t.join();
  const afternoon = await t.start(me, 'Afternoon', ['PS1', 'PS2']);
  t.setNow(at('13:15'));
  await t.update(me, afternoon, [{ lineId: 'PS1', headcount: 8, volume: 400 }]);

  // Not every line is in yet, so it is back to the update screen for the rest.
  t.setNow(at('17:00'));
  await t.final(me, afternoon, [{ lineId: 'PS1', volume: 2000 }]);
  assert.match(await t.page(`/shift/${afternoon}`, me), /<h1>Afternoon update<\/h1>/);

  // With the next sort open, the check goes on to it rather than signing out.
  t.setNow(at('17:05'));
  const twilight = await t.start(me, 'Twilight', ['PD1']);
  await t.final(me, afternoon, [{ lineId: 'PS2', volume: 900 }]);
  const check = await t.page(`/shift/${afternoon}`, me);
  assert.match(check, /<h1>Afternoon: check your numbers<\/h1>/);
  assert.match(check, new RegExp(`href="/shift/${twilight}">Looks right, go to Twilight<`));
  assert.ok(!check.includes('id="looks-right"'));
  assert.match(check, new RegExp(`href="/shift/${afternoon}/final">Change a number<`));
});

test('the start screen can go back when reached from a sort; the home page links to the shift screen', async () => {
  const t = await setup();
  const me = await t.join();
  assert.match(await t.page('/shift/start', me), /href="\/shift">Back<\/a>/);
  assert.match(await t.page('/', me), /href="\/shift"/);
});
