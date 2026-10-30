import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round, type Entry } from './index.ts';
import { lastClosedSlot, lineNumbers, runningSeries, sortSummary, type LiveLineInput } from './live.ts';

const QUARTER = 15 * 60 * 1000;
const atSlot = (slot: number) => slot * QUARTER;
const update = (slot: number, headcount: number, runningVolume: number): Entry => ({ kind: 'interval', slot, headcount, runningVolume, totalHours: null });
const finalAt = (slot: number, runningVolume: number, totalHours: number | null = null): Entry => ({
  kind: 'final',
  slot: null,
  headcount: null,
  runningVolume,
  totalHours,
  atMs: atSlot(slot),
});
const line = (id: string, type: 'PS' | 'PD', expectedPph: number | null, entries: Entry[], assignedSlot: number | null = null): LiveLineInput => ({ id, type, expectedPph, entries, assignedSlot });

test('a line: worked numbers for PPH, effectiveness, plan hours and over/under', () => {
  // 6 x 0.25 x 2 = 3 hours; 2,400 / 3 = 800 PPH; 800 / 550 = 145.45%; plan 2,400 / 550 = 4.36 h; 3 - 4.36 = -1.36.
  const n = lineNumbers(line('PS1', 'PS', 550, [update(100, 6, 1200), update(101, 6, 2400)]), atSlot(101));
  assert.equal(n.hours, 3);
  assert.equal(n.volume, 2400);
  assert.equal(n.pph, 800);
  assert.equal(round(n.effectiveness, 2), 145.45);
  assert.equal(round(n.planHours, 2), 4.36);
  assert.equal(round(n.overUnder, 2), -1.36);
  assert.equal(n.onTime, 100);
  assert.equal(n.lastSlot, 101);
  assert.equal(n.late, false);
});

test('a window stays open for 7.5 minutes either side of its quarter hour', () => {
  const at1315 = atSlot(100);
  assert.equal(lastClosedSlot(at1315), 99);
  assert.equal(lastClosedSlot(at1315 + 7 * 60 * 1000), 99);
  assert.equal(lastClosedSlot(at1315 + 8 * 60 * 1000), 100);
});

test('a line is late only once a whole window has closed with no update', () => {
  const l = line('PS1', 'PS', 550, [update(100, 6, 1200)]);
  assert.equal(lineNumbers(l, atSlot(101)).late, false); // the 101 window is still open
  assert.equal(lineNumbers(l, atSlot(101) + 8 * 60 * 1000).late, true); // the 101 window has closed
});

test('a line someone picked but never updated goes late; a line nobody picked does not', () => {
  const picked = line('PS1', 'PS', 550, [], 100);
  assert.equal(lineNumbers(picked, atSlot(101)).late, false);
  assert.equal(lineNumbers(picked, atSlot(102)).late, true);
  const nobody = line('PS2', 'PS', 550, []);
  assert.equal(lineNumbers(nobody, atSlot(200)).late, false);
  assert.equal(lineNumbers(nobody, atSlot(200)).inPlay, false);
});

test('a line with its final is never late, and a finished sort has no late lines', () => {
  assert.equal(lineNumbers(line('PS1', 'PS', 550, [update(100, 6, 1200), finalAt(105, 5000)]), atSlot(200)).late, false);
  assert.equal(lineNumbers(line('PS1', 'PS', 550, [update(100, 6, 1200)]), atSlot(200), false).late, false);
});

test('on-time counts real updates: skipped quarter hours count against it even though their hours carry', () => {
  const entries = [update(100, 6, 100), update(103, 6, 400)];
  const n = lineNumbers(line('PS1', 'PS', 550, entries), atSlot(103));
  assert.equal(n.hours, 6); // 4 quarter hours x 6 x 0.25
  assert.equal(n.onTime, 50); // 2 updates in 4 quarter hours
});

test('on-time stops at the final, which covers its own quarter hour', () => {
  // Updates at 100 and 101, final at 104: 102 and 103 were missed, so 2 of 4.
  const n = lineNumbers(line('PS1', 'PS', 550, [update(100, 6, 100), update(101, 6, 200), finalAt(104, 500)]), atSlot(200));
  assert.equal(n.onTime, 50);
});

test('PS and PD totals: added up first, then the ratios, with PD expected weighted by volume (D105)', () => {
  // North 275 and Wings 350. 1,100 / 275 = 4 plan hours; 1,750 / 350 = 5 plan hours. Expected = 2,850 / 9 = 316.67.
  const lines = [
    line('PD1', 'PD', 275, [update(100, 20, 1100)]), // 5 hours
    line('PD6', 'PD', 350, [update(100, 20, 1750)]), // 5 hours
    line('PS1', 'PS', 550, [update(100, 8, 1100)]), // 2 hours, plan 2 hours
    line('PS2', 'PS', 550, [], 100),
    line('PS3', 'PS', 550, []),
  ];
  const s = sortSummary(lines, atSlot(100), true, atSlot(99), null);
  assert.equal(s.PD.hours, 10);
  assert.equal(s.PD.volume, 2850);
  assert.equal(s.PD.pph, 285);
  assert.equal(round(s.PD.expectedPph, 2), 316.67);
  assert.equal(s.PD.effectiveness, 90); // 9 plan hours / 10 hours
  assert.equal(s.PD.overUnder, 1); // 10 - 9: 1 hour over plan (D043)
  assert.equal(s.PS.pph, 550);
  assert.equal(s.PS.overUnder, 0);
  assert.equal(s.PS.linesInPlay, 2); // PS3 has nobody on it
  assert.equal(s.PD.linesInPlay, 2);
  assert.equal(s.linesInPlay, 4);
  assert.equal(s.volume, 3950);
  assert.equal(s.hours, 12);
  assert.equal(s.flowPerHour, 15800); // 3,950 pieces in the 15 minutes since the start
});

test('flow per hour runs to now while a sort is going and to its end once it is finished', () => {
  const lines = [line('PS1', 'PS', 550, [update(100, 8, 1000)])];
  assert.equal(sortSummary(lines, atSlot(104), true, atSlot(100), null).flowPerHour, 1000);
  assert.equal(sortSummary(lines, atSlot(900), false, atSlot(100), atSlot(102)).flowPerHour, 2000);
  assert.equal(sortSummary(lines, atSlot(104), true, null, null).flowPerHour, null);
});

test('no entries at all: no totals to show, and nothing crashes', () => {
  const s = sortSummary([line('PS1', 'PS', 550, []), line('PD1', 'PD', 275, [])], atSlot(100), true, null, null);
  assert.equal(s.PS.pph, null);
  assert.equal(s.PS.effectiveness, null);
  assert.equal(s.PS.expectedPph, null);
  assert.equal(s.volume, 0);
  assert.deepEqual(runningSeries([line('PS1', 'PS', 550, [])]), []);
});

test('the chart: each type at each quarter hour, with worked numbers', () => {
  const lines = [
    line('PS1', 'PS', 550, [update(100, 4, 500), update(101, 4, 1000)]), // 1 h 500, 2 h 1,000
    line('PS2', 'PS', 550, [update(101, 8, 1100)]), // 2 h 1,100 from 101
    line('PD1', 'PD', 275, [update(100, 2, 150)]), // 0.5 h 150
  ];
  assert.deepEqual(runningSeries(lines), [
    { slot: 100, ps: 500, psExpected: 550, pd: 300, pdExpected: 275 },
    { slot: 101, ps: 525, psExpected: 550, pd: 300, pdExpected: 275 }, // 2,100 / 4 hours; PD1 stays as of its last report
  ]);
});

test('the chart: a skipped update does not spike the line, because volume and hours stop together', () => {
  const lines = [line('PS1', 'PS', 550, [update(100, 8, 1000), update(103, 8, 4000)])];
  // 100: 1,000 / 2. 101 and 102 hold at the same report. 103: 4,000 / 8 hours, with the skipped hours carried.
  assert.deepEqual(runningSeries(lines).map((p) => p.ps), [500, 500, 500, 500]);
});

test('the chart: a final joins at its own quarter hour and extends the line to it', () => {
  const lines = [line('PS1', 'PS', 550, [update(100, 8, 1000), finalAt(103, 4000)])];
  // 8 x 0.25 x 4 quarter hours = 8 hours at the final; 4,000 / 8 = 500.
  assert.deepEqual(runningSeries(lines).map((p) => p.ps), [500, 500, 500, 500]);
});

test('the chart: admin totals with no updates appear as one point at the time they were saved', () => {
  const points = runningSeries([line('PS1', 'PS', 550, [finalAt(100, 5500, 10)]), line('PD1', 'PD', 275, [finalAt(100, 2750, 10)])]);
  assert.deepEqual(points, [{ slot: 100, ps: 550, psExpected: 550, pd: 275, pdExpected: 275 }]);
});
