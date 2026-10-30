// The formulas from the data-model tab, as plain functions.
// No database and no clock in here. A missing or impossible input gives null,
// so a screen can show a dash instead of crashing (zero hours is the usual case).

export const BLOCK_HOURS = 0.25;

export type Entry = {
  kind: 'interval' | 'final';
  slot: number | null; // quarter hours since the Unix epoch; null on a final entry
  headcount: number | null;
  runningVolume: number | null;
  totalHours: number | null;
};

export type Line = {
  group: string;
  expectedPphOverride: number | null;
};

export type ShiftTotals = {
  hours: number;
  volume: number;
  expectedPph: number | null;
};

export type Summary = {
  hours: number;
  volume: number;
  pph: number | null;
  planHours: number | null;
  overUnder: number | null;
  effectiveness: number | null;
};

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// For display only. The calculators below return unrounded numbers.
export function round(n: number | null, places = 2): number | null {
  if (n === null) return null;
  const f = 10 ** places;
  return Math.round((n + Number.EPSILON) * f) / f;
}

// Sum of headcount x 0.25 per quarter hour, or total_hours when a final entry carries it (D013, D052).
export function hours(entries: Entry[]): number {
  const final = entries.find((e) => e.kind === 'final' && isNum(e.totalHours));
  if (final) return final.totalHours as number;
  let total = 0;
  for (const e of entries) {
    if (e.kind === 'interval' && isNum(e.headcount) && e.headcount > 0) total += e.headcount * BLOCK_HOURS;
  }
  return total;
}

// The final entry's volume if there is one, else the latest running volume (D016).
export function volume(entries: Entry[]): number {
  const final = entries.find((e) => e.kind === 'final' && isNum(e.runningVolume));
  if (final) return final.runningVolume as number;
  let latest: Entry | null = null;
  for (const e of entries) {
    if (e.kind !== 'interval' || !isNum(e.runningVolume) || !isNum(e.slot)) continue;
    if (latest === null || e.slot > (latest.slot as number)) latest = e;
  }
  return latest ? (latest.runningVolume as number) : 0;
}

// Volume / hours (D004).
export function pph(vol: number | null, hrs: number | null): number | null {
  if (!isNum(vol) || !isNum(hrs) || hrs <= 0) return null;
  return vol / hrs;
}

// Actual PPH / expected PPH x 100 (D010, D072).
export function effectiveness(actualPph: number | null, expected: number | null): number | null {
  if (!isNum(actualPph) || !isNum(expected) || expected <= 0) return null;
  return (actualPph / expected) * 100;
}

// Volume / expected PPH (D011). Staffing view only, never ranked.
export function planHours(vol: number | null, expected: number | null): number | null {
  if (!isNum(vol) || !isNum(expected) || expected <= 0) return null;
  return vol / expected;
}

// Hours - plan hours. Positive means over plan (D011).
export function overUnder(hrs: number | null, plan: number | null): number | null {
  if (!isNum(hrs) || !isNum(plan)) return null;
  return hrs - plan;
}

// Quarter hours with an entry / quarter hours elapsed, from the first interval entry to throughSlot (D019).
export function onTimePercent(entries: Entry[], throughSlot: number): number | null {
  const slots = new Set<number>();
  for (const e of entries) {
    if (e.kind === 'interval' && isNum(e.slot)) slots.add(e.slot);
  }
  if (slots.size === 0 || !isNum(throughSlot)) return null;
  const first = Math.min(...slots);
  if (throughSlot < first) return null;
  let hit = 0;
  for (const s of slots) if (s <= throughSlot) hit += 1;
  return (hit / (throughSlot - first + 1)) * 100;
}

// Flow per hour = total volume / sort span in hours (D048).
export function flowPerHour(totalVolume: number | null, spanHours: number | null): number | null {
  if (!isNum(totalVolume) || !isNum(spanHours) || spanHours <= 0) return null;
  return totalVolume / spanHours;
}

// Sort start = first entry - 15 minutes, rounded to the nearest 5 minutes (D066).
export function sortStartMs(firstEntryMs: number): number {
  const FIVE_MIN = 5 * 60 * 1000;
  return Math.round((firstEntryMs - 15 * 60 * 1000) / FIVE_MIN) * FIVE_MIN;
}

// A line's own override, else its group's expected PPH from settings (D041).
export function expectedPph(line: Line, settings: Record<string, number>): number | null {
  if (isNum(line.expectedPphOverride) && line.expectedPphOverride > 0) return line.expectedPphOverride;
  const fromGroup = settings[`expected_pph.${line.group}`];
  return isNum(fromGroup) && fromGroup > 0 ? fromGroup : null;
}

// Period and all-time numbers (D072, D105): add up hours, volume and plan hours across the
// shifts first, then take the ratios. A busy shift counts for more than a quiet one.
// Effectiveness comes out as total plan hours / total hours, which for a single shift
// equals actual PPH / expected PPH.
export function summarize(rows: ShiftTotals[]): Summary {
  let hrs = 0;
  let vol = 0;
  let plan = 0;
  let planKnown = rows.length > 0;
  for (const r of rows) {
    hrs += r.hours;
    vol += r.volume;
    const p = planHours(r.volume, r.expectedPph);
    if (p === null) planKnown = false;
    else plan += p;
  }
  const planTotal = planKnown ? plan : null;
  return {
    hours: hrs,
    volume: vol,
    pph: pph(vol, hrs),
    planHours: planTotal,
    overUnder: overUnder(hrs, planTotal),
    effectiveness: planTotal !== null && hrs > 0 ? (planTotal / hrs) * 100 : null,
  };
}
