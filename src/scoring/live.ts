// The numbers on the live sort view (D043, D122, D123). Plain functions, like the rest of scoring:
// no database and no clock. Everything works on one sort's lines only, so sorts cannot mix (D115).
import { flowPerHour, hours, overUnder, planHours, pph, effectiveness, quarterHourSlot, summarize, volume, type Entry, type Summary } from './index.ts';

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
  lastSlot: number | null;
  inPlay: boolean; // someone has picked this line or entered numbers on it
  hasFinal: boolean;
  late: boolean;
};

const finalOf = (entries: Entry[]) => entries.find((e) => e.kind === 'final');
const updateSlots = (entries: Entry[]) => entries.flatMap((e) => (e.kind === 'interval' && e.slot !== null ? [e.slot] : []));

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
  return {
    hours: hrs,
    volume: vol,
    pph: actual,
    effectiveness: effectiveness(actual, line.expectedPph),
    planHours: plan,
    overUnder: line.entries.length ? overUnder(hrs, plan) : null,
    lastSlot,
    inPlay,
    hasFinal: final !== undefined,
    late: running && inPlay && !final && since !== null && since < closed,
  };
}

export type TypeTotals = Summary & {
  expectedPph: number | null; // weighted by volume, because PD lines have different expectations
  linesInPlay: number;
};

function totalsFor(lines: LiveLineInput[], numbers: Map<string, LineNumbers>): TypeTotals {
  const reporting = lines.filter((l) => l.entries.length > 0);
  const summary = summarize(reporting.map((l) => ({ hours: numbers.get(l.id)!.hours, volume: numbers.get(l.id)!.volume, expectedPph: l.expectedPph })));
  return {
    ...summary,
    expectedPph: summary.planHours !== null && summary.planHours > 0 ? summary.volume / summary.planHours : null,
    linesInPlay: lines.filter((l) => numbers.get(l.id)!.inPlay).length,
  };
}

export type SortSummary = {
  numbers: Map<string, LineNumbers>;
  PS: TypeTotals;
  PD: TypeTotals;
  linesInPlay: number;
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
    volume: totalVolume,
    hours: PS.hours + PD.hours,
    flowPerHour: flowPerHour(totalVolume, spanHours),
  };
}

// The live ranking: best effectiveness first, because lines have different expected PPH (D010, D122).
// A tie goes to the higher volume.
export function topLines<T extends LiveLineInput>(lines: T[], numbers: Map<string, LineNumbers>, type: LineType, howMany = 3): T[] {
  return lines
    .filter((l) => l.type === type && numbers.get(l.id)!.effectiveness !== null)
    .sort((a, b) => {
      const x = numbers.get(a.id)!;
      const y = numbers.get(b.id)!;
      return y.effectiveness! - x.effectiveness! || y.volume - x.volume;
    })
    .slice(0, howMany);
}
