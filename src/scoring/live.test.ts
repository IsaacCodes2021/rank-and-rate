import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round, type Entry } from './index.ts';
import { lastClosedSlot, lineNumbers, sortSummary, topLines, type LiveLineInput } from './live.ts';

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
});

const rankOf = (lines: LiveLineInput[], type: 'PS' | 'PD') => {
  const s = sortSummary(lines, atSlot(100), true, null, null);
  return topLines(lines, s.numbers, type).map((l) => l.id);
};

test('the ranking goes by effectiveness, not PPH, so North and Wings compare fairly (D010)', () => {
  const lines = [
    line('PD1', 'PD', 275, [update(100, 4, 300)]), // 1 hour: 300 PPH, 109% of 275
    line('PD6', 'PD', 350, [update(100, 4, 340)]), // 1 hour: 340 PPH, 97% of 350
  ];
  assert.deepEqual(rankOf(lines, 'PD'), ['PD1', 'PD6']);
});

test('the ranking keeps the top 3 of one type, leaves out lines with no numbers, and breaks a tie on volume', () => {
  const lines = [
    line('PS1', 'PS', 550, [update(100, 4, 400)]), // 400 PPH
    line('PS2', 'PS', 550, [update(100, 4, 600)]), // 600 PPH
    line('PS3', 'PS', 550, [update(100, 4, 500)]), // 500 PPH, tied with PS4 on a smaller volume
    line('PS4', 'PS', 550, [update(100, 8, 1000)]), // 500 PPH
    line('PS5', 'PS', 550, [], 100), // picked, with no numbers yet
    line('PD1', 'PD', 275, [update(100, 4, 900)]), // the other type, and higher than all of them
  ];
  assert.deepEqual(rankOf(lines, 'PS'), ['PS2', 'PS4', 'PS3']);
  assert.deepEqual(rankOf(lines, 'PD'), ['PD1']);
  assert.deepEqual(rankOf([line('PS5', 'PS', 550, [], 100)], 'PS'), []);
});

test('the ranking leaves the list it was given in order', () => {
  const lines = [line('PS1', 'PS', 550, [update(100, 4, 400)]), line('PS2', 'PS', 550, [update(100, 4, 600)])];
  rankOf(lines, 'PS');
  assert.deepEqual(lines.map((l) => l.id), ['PS1', 'PS2']);
});
