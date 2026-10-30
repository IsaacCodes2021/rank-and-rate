import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, isValidPin, newSessionToken, sessionIdOf } from './supervisor.ts';

const SALT = 'p'.repeat(40);

test('an ID number is 4 to 12 digits and nothing else', () => {
  for (const good of ['1234', '0012', '123456789012']) assert.equal(isValidPin(good), true, good);
  for (const bad of ['', '123', '1234567890123', '12a4', '12 34', '-1234', '12.5', '١٢٣٤']) assert.equal(isValidPin(bad), false, bad);
});

test('the same number and key always give the same hash, which does not contain the number', async () => {
  const hash = await hashPin('10000001', SALT);
  assert.equal(hash, await hashPin('10000001', SALT));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hash.includes('10000001'));
});

test('a different number or a different key gives a different hash', async () => {
  const hash = await hashPin('10000001', SALT);
  assert.notEqual(hash, await hashPin('10000002', SALT));
  assert.notEqual(hash, await hashPin('10000001', 'q'.repeat(40)));
  assert.notEqual(await hashPin('0123', SALT), await hashPin('123', SALT)); // leading zeros count
});

test('session tokens are random, and the stored id is not the token', async () => {
  const a = newSessionToken();
  assert.notEqual(a, newSessionToken());
  assert.ok(a.length >= 40);
  const id = await sessionIdOf(a);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.notEqual(id, a);
  assert.equal(id, await sessionIdOf(a));
});
