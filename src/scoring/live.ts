// The numbers on the live sort view (D027, D043, D019). Plain functions, like the rest of scoring:
// no database and no clock. Everything works on one sort's lines only, so sorts cannot mix (D115).
import { flowPerHour, hours, onTimeParts, overUnder, planHours, pph, effectiveness, quarterHourSlot, summarize, volume, type Entry, type Summary } from './index.ts';

export type LineType = 'PS' | 'PD';

export type LiveLineInput = {
  id: string;
  type: LineType;
  expectedPph: number | null;
  entries: Entry[];
  assignedSlot: number | null; // when a supervisor first picked this line, if anyone has
};

export type LineNumbers = {
  hours: number;
  volume: number;
  pph: number | null;
  effectiveness: number | null;
  planHours: number | null;
  overUnder: number | null;
  onTime: number | null;
  onTimeParts: { hit: number; due: number } | null;
  lastSlot: number | null;
  inPlay: boolean; // someone has picked this line or entered numbers on it
  hasFinal: boolean;
  late: boolean;
};

const finalOf = (entries: Entry[]) => entries.find((e) => e.kind === 'final');
const updateSlots = (entries: Entry[]) => entries.flatMap((e) => (e.kind === 'interval' && e.slot !== null ? [e.slot] : []));
const finalSlotOf = (final: Entry | undefined) => (final && typeof final.atMs === 'number' ? quarterHourSlot(final.atMs) : null);

// An update counts for the nearest quarter hour, so a quarter hour's window closes 7.5 minutes after
// it. A line is late once a window has closed with no update, not the moment a new one opens.
export const lastClosedSlot = (nowMs: number) => quarterHourSlot(nowMs) - 1;

export function lineNumbers(line: LiveLineInput, nowMs: number, running = true): LineNumbers {
  const hrs = hours(line.entries);
  const vol = volume(line.entries);
  const actual = pph(vol, hrs);
  const plan = planHours(vol, line.expectedPph);
  const final = finalOf(line.entries);
  const slots = updateSlots(line.entries);
  const lastSlot = slots.length ? Math.max(...slots) : null;
  const closed = lastClosedSlot(nowMs);
  const inPlay = line.entries.length > 0 || line.assignedSlot !== null;
  const since = lastSlot ?? line.assignedSlot;
  // A final covers its own quarter hour, so only the ones before it can be missed.
  const finalSlot = finalSlotOf(final);
  const through = final ? Math.max(lastSlot ?? 0, (finalSlot ?? 0) - 1) : Math.max(lastSlot ?? 0, closed);
  const parts = onTimeParts(line.entries, through);
  return {
    hours: hrs,
    volume: vol,
    pph: actual,
    effectiveness: effectiveness(actual, line.expectedPph),
    planHours: plan,
    overUnder: line.entries.length ? overUnder(hrs, plan) : null,
    onTime: parts && (parts.hit / parts.due) * 100,
    onTimeParts: parts,
    lastSlot,
    inPlay,
    hasFinal: final !== undefined,
    late: running && inPlay && !final && since !== null && since < closed,
  };
}

export type TypeTotals = Summary & {
  expectedPph: number | null; // weighted by volume, because PD lines have different expectations
  linesInPlay: number;
  linesLate: number;
};

function totalsFor(lines: LiveLineInput[], numbers: Map<string, LineNumbers>): TypeTotals {
  const reporting = lines.filter((l) => l.entries.length > 0);
  const summary = summarize(reporting.map((l) => ({ hours: numbers.get(l.id)!.hours, volume: numbers.get(l.id)!.volume, expectedPph: l.expectedPph })));
  const inPlay = lines.filter((l) => numbers.get(l.id)!.inPlay);
  return {
    ...summary,
    expectedPph: summary.planHours !== null && summary.planHours > 0 ? summary.volume / summary.planHours : null,
    linesInPlay: inPlay.length,
    linesLate: inPlay.filter((l) => numbers.get(l.id)!.late).length,
  };
}

export type SortSummary = {
  numbers: Map<string, LineNumbers>;
  PS: TypeTotals;
  PD: TypeTotals;
  linesInPlay: number;
  linesLate: number;
  volume: number;
  hours: number;
  flowPerHour: number | null;
};

// startMs and endMs bound the sort for flow per hour (D048). A running sort has no end yet, so its span runs to now.
export function sortSummary(lines: LiveLineInput[], nowMs: number, running: boolean, startMs: number | null, endMs: number | null): SortSummary {
  const numbers = new Map(lines.map((l) => [l.id, lineNumbers(l, nowMs, running)]));
  const PS = totalsFor(lines.filter((l) => l.type === 'PS'), numbers);
  const PD = totalsFor(lines.filter((l) => l.type === 'PD'), numbers);
  const totalVolume = PS.volume + PD.volume;
  const spanEnd = running ? nowMs : (endMs ?? nowMs);
  const spanHours = startMs === null ? null : (spanEnd - startMs) / (60 * 60 * 1000);
  return {
    numbers,
    PS,
    PD,
    linesInPlay: PS.linesInPlay + PD.linesInPlay,
    linesLate: PS.linesLate + PD.linesLate,
    volume: totalVolume,
    hours: PS.hours + PD.hours,
    flowPerHour: flowPerHour(totalVolume, spanHours),
  };
}

// What a line had reported by the end of a quarter hour.
function entriesThrough(entries: Entry[], slot: number): Entry[] {
  return entries.filter((e) => {
    if (e.kind === 'interval') return e.slot !== null && e.slot <= slot;
    const finalSlot = finalSlotOf(e);
    return finalSlot === null || finalSlot <= slot;
  });
}

export type RunningPoint = {
  slot: number;
  ps: number | null;
  psExpected: number | null;
  pd: number | null;
  pdExpected: number | null;
};

// The chart: each type's PPH and expected PPH as they stood at each quarter hour of the sort. Each
// line counts as of its own latest report, so a line that skipped an update stays in step with itself.
export function runningSeries(lines: LiveLineInput[]): RunningPoint[] {
  const slots = lines.flatMap((l) => {
    const finalSlot = finalSlotOf(finalOf(l.entries));
    return finalSlot === null ? updateSlots(l.entries) : [...updateSlots(l.entries), finalSlot];
  });
  if (slots.length === 0) return [];
  const first = Math.min(...slots);
  const last = Math.max(...slots);
  const at = (type: LineType, slot: number) => {
    const rows = lines
      .filter((l) => l.type === type)
      .map((l) => ({ line: l, entries: entriesThrough(l.entries, slot) }))
      .filter((r) => r.entries.length > 0)
      .map((r) => ({ hours: hours(r.entries), volume: volume(r.entries), expectedPph: r.line.expectedPph }));
    const s = summarize(rows);
    return { pph: s.pph, expected: s.planHours !== null && s.planHours > 0 ? s.volume / s.planHours : null };
  };
  const points: RunningPoint[] = [];
  for (let slot = first; slot <= last; slot += 1) {
    const ps = at('PS', slot);
    const pd = at('PD', slot);
    points.push({ slot, ps: ps.pph, psExpected: ps.expected, pd: pd.pph, pdExpected: pd.expected });
  }
  return points;
}
