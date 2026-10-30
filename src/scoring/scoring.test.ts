import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveness,
  expectedPph,
  flowPerHour,
  hours,
  onTimePercent,
  overUnder,
  pph,
  planHours,
  quarterHourSlot,
  round,
  sortStartMs,
  summarize,
  volume,
  type Entry,
} from './index.ts';

const interval = (slot: number, headcount: number, runningVolume: number): Entry => ({
  kind: 'interval',
  slot,
  headcount,
  runningVolume,
  totalHours: null,
});

const final = (runningVolume: number, totalHours: number | null = null): Entry => ({
  kind: 'final',
  slot: null,
  headcount: null,
  runningVolume,
  totalHours,
});

const QUARTER_MS = 15 * 60 * 1000;
const finalAt = (slot: number, runningVolume: number): Entry => ({ ...final(runningVolume), atMs: slot * QUARTER_MS });

test('hours: a skipped quarter hour counts the last headcount (D117)', () => {
  // 6 people for slots 100, 101, 102 (two of them skipped), then 4 people at 103: 4.5 + 1 = 5.5.
  assert.equal(hours([interval(100, 6, 100), interval(103, 4, 400)]), 5.5);
  // The same night with every update sent comes to the same hours.
  assert.equal(hours([interval(100, 6, 100), interval(101, 6, 200), interval(102, 6, 300), interval(103, 4, 400)]), 5.5);
});

test('hours: the order of the entries does not matter', () => {
  assert.equal(hours([interval(103, 4, 400), interval(100, 6, 100)]), 5.5);
});

test('hours: carried through to the final (the 3,333 PPH example)', () => {
  // 6 people at 1:15 PM, final at 5:00 PM: 16 quarter hours x 6 x 0.25 = 24 hours.
  const entries = [interval(100, 6, 1200), finalAt(115, 5000)];
  assert.equal(hours(entries), 24);
  assert.equal(round(pph(volume(entries), hours(entries)), 0), 208);
});

test('hours: while the sort is going they stop at the latest update, where the volume stops too', () => {
  assert.equal(hours([interval(100, 6, 1200)]), 1.5);
  assert.equal(hours([interval(100, 6, 1200), final(5000)]), 1.5); // a final with no time adds nothing
});

test('hours: a final saved before the last update does not cut hours short', () => {
  assert.equal(hours([interval(100, 4, 100), interval(103, 4, 400), finalAt(101, 400)]), 4);
});

test('hours: a final with no updates has no hours to carry', () => {
  assert.equal(hours([finalAt(115, 5000)]), 0);
});

test('hours: a headcount of zero carries as zero', () => {
  // 4 people at 100, then nobody at 101 and 102 (one skipped), then 4 at 103: 1 + 0 + 1 = 2.
  assert.equal(hours([interval(100, 4, 100), interval(101, 0, 100), interval(103, 4, 300)]), 2);
});

test('hours: a blank headcount is ignored, and the one before it keeps carrying', () => {
  const blank: Entry = { kind: 'interval', slot: 101, headcount: null, runningVolume: 200, totalHours: null };
  assert.equal(hours([interval(100, 4, 100), blank, interval(102, 4, 300)]), 3);
});

test('hours: a headcount carries for at most 6 hours', () => {
  // One update at slot 100 and a final typed 15 hours later: 25 quarter hours x 6 x 0.25 = 37.5, not 91.5.
  assert.equal(hours([interval(100, 6, 1200), finalAt(160, 5000)]), 37.5);
  // Exactly at the limit nothing is cut.
  assert.equal(hours([interval(100, 6, 1200), finalAt(124, 5000)]), 37.5);
  // The same limit applies between two updates: 25 x 4 x 0.25 + 1 x 2 x 0.25 = 25.5.
  assert.equal(hours([interval(100, 4, 100), interval(200, 2, 900)]), 25.5);
});

test('hours: skipping updates does not change on-time %, which still counts real updates only', () => {
  const entries = [interval(100, 6, 100), interval(103, 4, 400)];
  assert.equal(hours(entries), 5.5);
  assert.equal(onTimePercent(entries, 103), 50); // 2 of 4
});

test('hours: 5 people for 1 hour is 5 hours (D004, D117)', () => {
  const entries = [interval(100, 5, 100), interval(101, 5, 200), interval(102, 5, 300), interval(103, 5, 400)];
  assert.equal(hours(entries), 5);
});

test('hours: headcount changes block by block', () => {
  const entries = [interval(100, 4, 0), interval(101, 6, 0), interval(102, 8, 0)];
  assert.equal(hours(entries), 4.5);
});

test('hours: a final total_hours replaces the quarter-hour sum (D052)', () => {
  const entries = [interval(100, 5, 100), final(9647, 20)];
  assert.equal(hours(entries), 20);
});

test('hours: no entries, or a blank headcount, is zero', () => {
  assert.equal(hours([]), 0);
  assert.equal(hours([{ kind: 'interval', slot: 1, headcount: null, runningVolume: null, totalHours: null }]), 0);
});

test('volume: the latest running volume wins, not the biggest slot order in the array (D016)', () => {
  const entries = [interval(102, 5, 300), interval(100, 5, 100), interval(101, 5, 200)];
  assert.equal(volume(entries), 300);
});

test('volume: a final entry wins over the intervals', () => {
  assert.equal(volume([interval(100, 5, 100), final(950)]), 950);
});

test('volume: no entries is zero', () => {
  assert.equal(volume([]), 0);
});

test('pph, effectiveness, plan hours and over/under on the worked example (D010, D011)', () => {
  // 9,647 pieces in 20 hours on an Unload line (expected 550 PPH).
  // D011 and task T103 quoted 9,561 for this example; 9,561 / 550 is 17.38, not 17.54, so that figure was a typo.
  const actual = pph(9647, 20);
  assert.equal(round(actual), 482.35);
  assert.equal(round(effectiveness(actual, 550), 1), 87.7);
  const plan = planHours(9647, 550);
  assert.equal(round(plan), 17.54);
  assert.equal(round(overUnder(20, plan)), 2.46);
});

test('plan hours: 9,561 / 550 is 17.38, so the old example in D011 does not hold', () => {
  assert.equal(round(planHours(9561, 550)), 17.38);
});

test('zero or missing hours never crash and give null', () => {
  assert.equal(pph(100, 0), null);
  assert.equal(pph(100, -1), null);
  assert.equal(pph(null, 5), null);
  assert.equal(pph(Number.NaN, 5), null);
  assert.equal(effectiveness(null, 550), null);
  assert.equal(effectiveness(400, 0), null);
  assert.equal(planHours(100, 0), null);
  assert.equal(planHours(100, null), null);
  assert.equal(overUnder(null, 3), null);
  assert.equal(flowPerHour(100, 0), null);
});

test('zero volume is a real zero, not a missing number', () => {
  assert.equal(pph(0, 5), 0);
  assert.equal(effectiveness(0, 550), 0);
  assert.equal(planHours(0, 550), 0);
});

test('over/under is positive when hours run over plan (D011)', () => {
  assert.equal(round(overUnder(20, 17.54)), 2.46);
  assert.equal(round(overUnder(15, 17.54)), -2.54);
});

test('on-time %: 3 of the 4 quarter hours had an entry (D019)', () => {
  const entries = [interval(100, 5, 1), interval(101, 5, 2), interval(103, 5, 3)];
  assert.equal(onTimePercent(entries, 103), 75);
});

test('on-time %: counts only up to the slot asked for', () => {
  const entries = [interval(100, 5, 1), interval(102, 5, 2)];
  assert.equal(onTimePercent(entries, 101), 50);
  assert.equal(onTimePercent(entries, 102), (2 / 3) * 100);
});

test('on-time %: no interval entries, or asking before the first one, is null', () => {
  assert.equal(onTimePercent([], 100), null);
  assert.equal(onTimePercent([final(500, 5)], 100), null);
  assert.equal(onTimePercent([interval(100, 5, 1)], 99), null);
});

test('flow per hour: total volume over the sort span (D048)', () => {
  assert.equal(flowPerHour(9647, 5.5), 1754);
});

test('an update counts for the nearest quarter hour', () => {
  const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 26, h, m, s);
  const quarter = (h: number, m: number) => at(h, m) / (15 * 60 * 1000);
  assert.equal(quarterHourSlot(at(13, 15)), quarter(13, 15));
  assert.equal(quarterHourSlot(at(13, 14)), quarter(13, 15));
  assert.equal(quarterHourSlot(at(13, 16)), quarter(13, 15));
  assert.equal(quarterHourSlot(at(13, 22, 29)), quarter(13, 15));
  assert.equal(quarterHourSlot(at(13, 22, 30)), quarter(13, 30));
  assert.equal(quarterHourSlot(at(13, 29)), quarter(13, 30));
});

test('sort start: first entry minus 15 minutes, rounded to the nearest 5 (D066)', () => {
  const at = (h: number, m: number) => Date.UTC(2026, 9, 26, h, m);
  assert.equal(sortStartMs(at(13, 14)), at(13, 0));
  assert.equal(sortStartMs(at(13, 15)), at(13, 0));
  assert.equal(sortStartMs(at(13, 16)), at(13, 0));
  assert.equal(sortStartMs(at(13, 18)), at(13, 5));
  assert.equal(sortStartMs(at(13, 22)), at(13, 5));
  assert.equal(sortStartMs(at(13, 23)), at(13, 10));
});

test('expected PPH: a line override wins, else the group setting (D041)', () => {
  const settings = { 'expected_pph.North': 275, 'expected_pph.Wings': 350, 'expected_pph.Unload': 550 };
  assert.equal(expectedPph({ group: 'North', expectedPphOverride: null }, settings), 275);
  assert.equal(expectedPph({ group: 'Wings', expectedPphOverride: null }, settings), 350);
  assert.equal(expectedPph({ group: 'Unload', expectedPphOverride: null }, settings), 550);
  assert.equal(expectedPph({ group: 'Wings', expectedPphOverride: 400 }, settings), 400);
  assert.equal(expectedPph({ group: 'Dock', expectedPphOverride: null }, settings), null);
});

test('summarize: one shift matches the single-shift formulas', () => {
  const s = summarize([{ hours: 20, volume: 9647, expectedPph: 550 }]);
  assert.equal(round(s.pph), 482.35);
  assert.equal(round(s.planHours), 17.54);
  assert.equal(round(s.overUnder), 2.46);
  assert.equal(round(s.effectiveness, 1), 87.7);
});

test('summarize: adds up first, so a long shift counts for more than a short one (D072, D105)', () => {
  const s = summarize([
    { hours: 10, volume: 5500, expectedPph: 550 }, // 100% on 10 h
    { hours: 2, volume: 550, expectedPph: 550 }, // 50% on 2 h
  ]);
  assert.equal(s.hours, 12);
  assert.equal(s.volume, 6050);
  assert.equal(round(s.planHours), 11);
  assert.equal(round(s.effectiveness, 2), 91.67);
  // a plain average of the two nightly percentages would have been 75
});

test('summarize: lines with different expectations keep their own plan hours', () => {
  const s = summarize([
    { hours: 10, volume: 2750, expectedPph: 275 }, // plan 10 h
    { hours: 10, volume: 3500, expectedPph: 350 }, // plan 10 h
  ]);
  assert.equal(round(s.planHours), 20);
  assert.equal(round(s.effectiveness), 100);
});

test('summarize: nothing in the period, or an unknown expectation, gives nulls and never crashes', () => {
  const empty = summarize([]);
  assert.equal(empty.hours, 0);
  assert.equal(empty.pph, null);
  assert.equal(empty.effectiveness, null);
  const unknown = summarize([{ hours: 5, volume: 100, expectedPph: null }]);
  assert.equal(unknown.planHours, null);
  assert.equal(unknown.effectiveness, null);
  assert.equal(round(unknown.pph), 20);
  const noHours = summarize([{ hours: 0, volume: 0, expectedPph: 550 }]);
  assert.equal(noHours.pph, null);
  assert.equal(noHours.effectiveness, null);
});
