import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, clockOf, count, longDay, oneDecimal, pacificOffsetHours, shortDay } from './format.ts';

test('times are the building time, on both sides of the clock change', () => {
  assert.equal(clock(Date.parse('2026-10-30T20:15:00Z')), '1:15 PM'); // PDT
  assert.equal(clock(Date.parse('2026-11-02T21:15:00Z')), '1:15 PM'); // PST
  assert.equal(clockOf('2026-10-31T01:05:00Z'), '6:05 PM');
});

test('numbers are whole with commas, or to one place', () => {
  assert.equal(count(1234567.4), '1,234,567');
  assert.equal(count(0), '0');
  assert.equal(count(0.5), '1');
  assert.equal(oneDecimal(1234.56), '1,234.6');
  assert.equal(oneDecimal(2), '2.0');
});

test('days are written from the date alone, whatever the time zone', () => {
  assert.equal(shortDay('2026-10-05'), 'Oct 5');
  assert.equal(longDay('2026-10-30'), 'Fri, Oct 30');
});

test('the offset follows the clock change, including on the day it happens', () => {
  assert.equal(pacificOffsetHours('2026-10-30'), -7);
  assert.equal(pacificOffsetHours('2026-11-01'), -8); // the clocks went back at 2 AM
  assert.equal(pacificOffsetHours('2026-11-02'), -8);
  assert.equal(pacificOffsetHours('2026-11-02'), -8); // and again from the kept copy
});
