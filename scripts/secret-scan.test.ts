import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from './secret-scan.ts';

const rules = (text: string) => scanText('x.ts', text).map((f) => f.rule);

// The fake secrets below are put together at run time, so the source never holds a string
// that looks like a real key (GitHub's push protection refuses those, rightly).
const join = (...parts: string[]) => parts.join('');
const FAKE_PRIVATE_KEY = join('-----BEGIN RSA ', 'PRIVATE KEY-----');
const FAKE_CLOUDFLARE = join('CLOUDFLARE_API_TOKEN=', 'x'.repeat(40));
const FAKE_GITHUB = join('gh', 'p_', 'x'.repeat(36));
const FAKE_AWS = join('AK', 'IA', 'X'.repeat(16));

test('flags a private key block', () => {
  assert.deepEqual(rules(FAKE_PRIVATE_KEY), ['private key block']);
});

test('flags a token, password or admin code written into code', () => {
  assert.deepEqual(rules('const adminCode = "hunter2hunter2hunter2"'), ['secret written into code']);
  assert.deepEqual(rules('admin_code = "hunter2hunter2hunter2"'), ['secret written into code']);
  assert.deepEqual(rules('API_KEY: "abcdefghijklmnop1234"'), ['secret written into code']);
  assert.deepEqual(rules("password = 'correct-horse-battery'"), ['secret written into code']);
});

test('flags a Cloudflare token variable with a real-looking value', () => {
  assert.deepEqual(rules(FAKE_CLOUDFLARE), ['Cloudflare API token variable']);
});

test('flags a GitHub token and an AWS key id', () => {
  assert.deepEqual(rules(FAKE_GITHUB), ['GitHub token']);
  assert.deepEqual(rules(FAKE_AWS), ['AWS access key id']);
});

test('does not flag ordinary code or short placeholders', () => {
  assert.deepEqual(rules("const token = await readToken(request)"), []);
  assert.deepEqual(rules("password = 'x'"), []);
  assert.deepEqual(rules('pin_hash TEXT NOT NULL,'), []);
  assert.deepEqual(rules("'fake-not-a-real-hash'"), []);
});

test('a line can opt out with a marker, and findings carry file and line number', () => {
  assert.deepEqual(rules('password = "correct-horse-battery" // secret-scan: allow'), []);
  const found = scanText('db/x.sql', 'ok\nsecret = "abcdefghijklmnop"');
  assert.deepEqual(found, [{ file: 'db/x.sql', line: 2, rule: 'secret written into code' }]);
});
