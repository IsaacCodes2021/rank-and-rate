import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inRange, isPeriodKey, periodRange } from './periods.ts';

// 2026-10-30 is a Friday.
const FRIDAY = '2026-10-30';

test('this week runs from Monday to today', () => {
  assert.deepEqual(periodRange('this-week', FRIDAY), { from: '2026-10-26', to: FRIDAY });
});

test('on a Monday this week is just today, and on a Sunday it reaches back to that Monday', () => {
  assert.deepEqual(periodRange('this-week', '2026-10-26'), { from: '2026-10-26', to: '2026-10-26' });
  assert.deepEqual(periodRange('this-week', '2026-11-01'), { from: '2026-10-26', to: '2026-11-01' });
});

test('last week is the whole week before, Monday to Sunday', () => {
  assert.deepEqual(periodRange('last-week', FRIDAY), { from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(periodRange('last-week', '2026-10-26'), { from: '2026-10-19', to: '2026-10-25' });
});

test('this month runs from the first to today', () => {
  assert.deepEqual(periodRange('this-month', FRIDAY), { from: '2026-10-01', to: FRIDAY });
  assert.deepEqual(periodRange('this-month', '2026-11-01'), { from: '2026-11-01', to: '2026-11-01' });
});

test('last month is the whole month before, across a year end and a leap February', () => {
  assert.deepEqual(periodRange('last-month', FRIDAY), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(periodRange('last-month', '2027-01-15'), { from: '2026-12-01', to: '2026-12-31' });
  assert.deepEqual(periodRange('last-month', '2028-03-01'), { from: '2028-02-01', to: '2028-02-29' });
});

test('all time has no limits', () => {
  assert.deepEqual(periodRange('all-time', FRIDAY), { from: null, to: null });
  assert.equal(inRange('2001-01-01', periodRange('all-time', FRIDAY)), true);
});

test('both ends of a range are included', () => {
  const week = periodRange('last-week', FRIDAY);
  assert.equal(inRange('2026-10-18', week), false);
  assert.equal(inRange('2026-10-19', week), true);
  assert.equal(inRange('2026-10-25', week), true);
  assert.equal(inRange('2026-10-26', week), false);
  assert.equal(inRange('2026-10-26', { from: '2026-10-26', to: null }), true);
  assert.equal(inRange('2026-10-25', { from: '2026-10-26', to: null }), false);
});

test('only the listed periods count as periods', () => {
  assert.equal(isPeriodKey('this-week'), true);
  assert.equal(isPeriodKey('forever'), false);
  assert.equal(isPeriodKey(''), false);
});
