import { test } from 'node:test';
import assert from 'node:assert/strict';
import { round } from './index.ts';
import { lineResults, supervisorResults, nightRowOf, winners, type NightLine } from './results.ts';

const row = (date: string, lineId: string, expectedPph: number | null, hours: number, volume: number, supervisors: string[] = []): NightLine => ({
  date,
  sort: 'Afternoon',
  lineId,
  type: lineId.startsWith('PS') ? 'PS' : 'PD',
  group: lineId.startsWith('PS') ? 'Unload' : 'North',
  expectedPph,
  supervisors,
  hours,
  volume,
});

const NIGHTS = [
  row('2026-10-29', 'PS1', 550, 20, 11000, ['Pat']), // 550 PPH, 100%
  row('2026-10-28', 'PS1', 550, 10, 6600, ['Sam']), // 660 PPH, 120%
  row('2026-10-29', 'PD1', 275, 10, 3300, ['Pat']), // 330 PPH, 120%
  row('2026-10-29', 'PD6', 350, 10, 3500, ['Sam']), // 350 PPH, 100%
];

test('a line across nights: hours and volume added up first, then the ratios (D105)', () => {
  const ps1 = lineResults(NIGHTS).find((l) => l.id === 'PS1')!;
  // 30 hours, 17,600 pieces: 586.67 PPH. Plan 17,600 / 550 = 32 hours: 2 under, 106.67% effective.
  assert.equal(ps1.hours, 30);
  assert.equal(ps1.volume, 17600);
  assert.equal(round(ps1.pph), 586.67);
  assert.equal(ps1.planHours, 32);
  assert.equal(ps1.overUnder, -2);
  assert.equal(round(ps1.effectiveness), 106.67);
  assert.equal(ps1.nights, 2);
  assert.deepEqual(ps1.supervisors, ['Pat', 'Sam']);
});

test('the ranking goes by effectiveness, so North and Wings compare fairly (D010)', () => {
  assert.deepEqual(lineResults(NIGHTS).map((l) => l.id), ['PD1', 'PS1', 'PD6']);
});

test('a tie goes to the higher volume, and a line with no effectiveness goes last', () => {
  const lines = lineResults([
    row('2026-10-29', 'PS1', 550, 10, 5500), // 100%
    row('2026-10-29', 'PS2', 550, 20, 11000), // 100%, more volume
    row('2026-10-29', 'PS3', 550, 0, 500), // no hours, so no PPH
    row('2026-10-29', 'PS4', null, 10, 5500), // no expected PPH
  ]);
  assert.deepEqual(lines.map((l) => l.id), ['PS2', 'PS1', 'PS4', 'PS3']);
  assert.equal(lines[2].effectiveness, null);
  assert.equal(lines[3].pph, null);
});

test('nights first: the line that ranked first each night, by effectiveness', () => {
  const lines = lineResults(NIGHTS);
  assert.equal(lines.find((l) => l.id === 'PD1')!.wins, 1); // 120% on the 29th
  assert.equal(lines.find((l) => l.id === 'PS1')!.wins, 1); // alone on the 28th
  assert.equal(lines.find((l) => l.id === 'PD6')!.wins, 0);
});

test('winners: best PS and best PD by PPH, best overall by effectiveness (D028)', () => {
  const best = winners(lineResults(NIGHTS));
  assert.equal(best.ps?.id, 'PS1');
  assert.equal(best.pd?.id, 'PD6'); // 350 PPH beats 330, even at lower effectiveness
  assert.equal(best.overall?.id, 'PD1'); // 120% beats 106.67%
});

test('winners: a tie on PPH goes to the higher volume, and a missing type has no winner', () => {
  const best = winners(lineResults([row('2026-10-29', 'PS1', 550, 10, 5500), row('2026-10-29', 'PS2', 550, 20, 11000)]));
  assert.equal(best.ps?.id, 'PS2');
  assert.equal(best.pd, null);
  assert.deepEqual(winners([]), { ps: null, pd: null, overall: null });
  assert.equal(winners(lineResults([row('2026-10-29', 'PS1', null, 10, 5500)])).overall, null);
});

test("a supervisor's record follows them across lines (D012)", () => {
  const people = supervisorResults(NIGHTS);
  // Pat: PS1 20 hours and PD1 10 hours. Plan 11,000 / 550 + 3,300 / 275 = 32 hours; 30 hours worked: 106.67%.
  const pat = people.find((p) => p.name === 'Pat')!;
  assert.equal(pat.hours, 30);
  assert.equal(pat.volume, 14300);
  assert.equal(round(pat.effectiveness), 106.67);
  assert.deepEqual(pat.lines, ['PS1', 'PD1']);
  assert.equal(pat.nights, 1);
  // Sam: 6,600 / 550 + 3,500 / 350 = 22 plan hours in 20: 110%.
  const sam = people.find((p) => p.name === 'Sam')!;
  assert.equal(round(sam.effectiveness), 110);
  assert.equal(sam.nights, 2);
  assert.deepEqual(people.map((p) => p.name), ['Sam', 'Pat']);
});

test('a line two people shared counts for each of them, and a line with no name counts for nobody', () => {
  const people = supervisorResults([row('2026-10-29', 'PS1', 550, 20, 11000, ['Pat', 'Sam']), row('2026-10-29', 'PS2', 550, 20, 11000)]);
  assert.deepEqual(people.map((p) => [p.name, p.hours]).sort(), [['Pat', 20], ['Sam', 20]]);
  assert.deepEqual(supervisorResults([row('2026-10-29', 'PS2', 550, 20, 11000)]), []);
});

test('one line on one night, for its history', () => {
  const night = nightRowOf(row('2026-10-29', 'PS1', 550, 20, 9647, ['Pat']));
  assert.equal(round(night.pph), 482.35);
  assert.equal(round(night.effectiveness), 87.7);
  assert.equal(round(night.overUnder), 2.46); // 20 - 17.54 (D011)
  assert.deepEqual(night.supervisors, ['Pat']);
  assert.equal(nightRowOf(row('2026-10-29', 'PS1', 550, 0, 500)).pph, null);
});
