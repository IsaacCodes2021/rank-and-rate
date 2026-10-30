import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_SECONDS, readSession, sameSecret, signSession } from './session.ts';

const KEY = 'k'.repeat(40);
const OTHER_KEY = 'z'.repeat(40);
const NOW = Date.UTC(2026, 9, 29, 20, 0, 0);
const exp = Math.floor(NOW / 1000) + SESSION_SECONDS;

test('a signed session reads back until it expires 12 hours later', async () => {
  const token = await signSession({ role: 'admin', exp }, KEY);
  assert.deepEqual(await readSession(token, KEY, NOW), { role: 'admin', exp });
  assert.ok(await readSession(token, KEY, NOW + (SESSION_SECONDS - 1) * 1000));
  assert.equal(await readSession(token, KEY, NOW + SESSION_SECONDS * 1000), null);
});

test('a session signed with another key, or changed in any way, is refused', async () => {
  const token = await signSession({ role: 'admin', exp }, KEY);
  assert.equal(await readSession(token, OTHER_KEY, NOW), null);

  const [body, sig] = token.split('.');
  const longer = btoa(JSON.stringify({ role: 'admin', exp: exp + 999999 })).replace(/=+$/, '');
  assert.equal(await readSession(`${longer}.${sig}`, KEY, NOW), null);
  assert.equal(await readSession(`${body}.${sig.slice(0, -2)}AA`, KEY, NOW), null);
  assert.equal(await readSession(`${body}.${sig}.extra`, KEY, NOW), null);
});

test('garbage never throws', async () => {
  for (const junk of ['', '.', 'abc', 'a.b', '!!!.???', `${'x'.repeat(5000)}.y`]) {
    assert.equal(await readSession(junk, KEY, NOW), null);
  }
});

test('sameSecret matches only the exact value', async () => {
  assert.equal(await sameSecret('correct horse', 'correct horse'), true);
  assert.equal(await sameSecret('correct hors', 'correct horse'), false);
  assert.equal(await sameSecret('Correct horse', 'correct horse'), false);
  assert.equal(await sameSecret('', 'correct horse'), false);
});
