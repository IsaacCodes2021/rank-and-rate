import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Shim } from '../../db/d1-shim.ts';
import { migrate, openDb, seed } from '../../db/lib.ts';
import { createApp, type Env } from './app.ts';

const fakeD1 = (db: ReturnType<typeof openDb>): Env['DB'] => d1Shim(db);

test('the entry file exports only the Worker (Cloudflare refuses any other export)', async () => {
  const entry = await import('./index.ts');
  assert.deepEqual(Object.keys(entry), ['default']);
  assert.equal(typeof entry.default.fetch, 'function');
});

test('the home address goes to the live sort view', async () => {
  const res = await createApp().request('/', {}, { DB: {} as Env['DB'] });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/live');
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
