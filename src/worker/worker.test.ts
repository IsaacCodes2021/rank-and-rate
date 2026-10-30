import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Shim } from '../../db/d1-shim.ts';
import { migrate, openDb, seed } from '../../db/lib.ts';
import { createApp, type Env } from './index.ts';

const fakeD1 = (db: ReturnType<typeof openDb>): Env['DB'] => d1Shim(db);

test('the home page is a plain placeholder with a phone viewport', async () => {
  const res = await createApp().request('/', {}, { DB: {} as Env['DB'] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const body = await res.text();
  assert.match(body, /<title>Rank and Rate<\/title>/);
  assert.match(body, /name="viewport"/);
});

test('health reports the 27 seeded lines when the database answers', async () => {
  const db = openDb(':memory:');
  migrate(db);
  seed(db);
  const res = await createApp().request('/api/health', {}, { DB: fakeD1(db) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, lines: 27 });
});

test('health returns 503 when the database fails, so the monitor can alert', async () => {
  const db = openDb(':memory:'); // no tables: the query fails
  const res = await createApp().request('/api/health', {}, { DB: fakeD1(db) });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false });
});

test('an unknown address is a 404', async () => {
  const res = await createApp().request('/nope', {}, { DB: {} as Env['DB'] });
  assert.equal(res.status, 404);
});
