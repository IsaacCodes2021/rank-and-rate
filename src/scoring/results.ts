// The numbers on the results page (D028, D072). Plain functions, like the rest of scoring: no
// database and no clock. Everything comes from one row per line per finished sort, with hours and
// volume added up first and the ratios taken after (D105).
import { effectiveness, overUnder, planHours, pph, summarize, type Summary } from './index.ts';
import type { LineType } from './live.ts';

export type NightLine = {
  date: string;
  sort: string;
  lineId: string;
  type: LineType;
  group: string;
  expectedPph: number | null;
  supervisors: string[];
  hours: number;
  volume: number;
};

export type LineNightRow = {
  date: string;
  sort: string;
  supervisors: string[];
  hours: number;
  volume: number;
  pph: number | null;
  effectiveness: number | null;
  overUnder: number | null;
};

// One line on one night, for a line's history.
export function nightRowOf(n: NightLine): LineNightRow {
  const actual = pph(n.volume, n.hours);
  return {
    date: n.date,
    sort: n.sort,
    supervisors: n.supervisors,
    hours: n.hours,
    volume: n.volume,
    pph: actual,
    effectiveness: effectiveness(actual, n.expectedPph),
    overUnder: overUnder(n.hours, planHours(n.volume, n.expectedPph)),
  };
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  return groups;
}

const unique = (items: string[]) => [...new Set(items)];
const nightOf = (r: NightLine) => `${r.date}|${r.sort}`;

// Best effectiveness first, the ranking metric (D010). A tie goes to the higher volume, and anything
// with no effectiveness goes last.
const byEffectiveness = (a: Summary, b: Summary) => (b.effectiveness ?? -1) - (a.effectiveness ?? -1) || b.volume - a.volume;

export type LineResult = Summary & {
  id: string;
  type: LineType;
  expectedPph: number | null;
  supervisors: string[];
  nights: number;
  wins: number; // nights it ranked first
};

// Every line with numbers, ranked. Lines are compared on totals across the period (D105).
export function lineResults(rows: NightLine[]): LineResult[] {
  const wins = new Map<string, number>();
  for (const night of groupBy(rows, nightOf).values()) {
    const best = night.map((r) => ({ id: r.lineId, ...summarize([r]) })).sort(byEffectiveness)[0];
    if (best.effectiveness !== null) wins.set(best.id, (wins.get(best.id) ?? 0) + 1);
  }
  return [...groupBy(rows, (r) => r.lineId).entries()]
    .map(([id, own]) => ({
      ...summarize(own),
      id,
      type: own[0].type,
      expectedPph: own[0].expectedPph,
      supervisors: unique(own.flatMap((r) => r.supervisors)),
      nights: new Set(own.map(nightOf)).size,
      wins: wins.get(id) ?? 0,
    }))
    .sort(byEffectiveness);
}

export type SupervisorResult = Summary & {
  name: string;
  lines: string[];
  nights: number;
};

// A supervisor's record follows them across lines (D012). A line two people shared counts for each
// of them, and a line with no name, as typed totals have, counts for nobody.
export function supervisorResults(rows: NightLine[]): SupervisorResult[] {
  const named = rows.flatMap((r) => r.supervisors.map((name) => ({ name, row: r })));
  return [...groupBy(named, (n) => n.name).entries()]
    .map(([name, own]) => ({
      ...summarize(own.map((n) => n.row)),
      name,
      lines: unique(own.map((n) => n.row.lineId)),
      nights: new Set(own.map((n) => nightOf(n.row))).size,
    }))
    .sort(byEffectiveness);
}

export type Winners = { ps: LineResult | null; pd: LineResult | null; overall: LineResult | null };

// Best PS and best PD by PPH, best overall by effectiveness (D028). A tie goes to the higher volume.
export function winners(lines: LineResult[]): Winners {
  const bestOf = (type: LineType) =>
    lines
      .filter((l) => l.type === type && l.pph !== null)
      .sort((a, b) => b.pph! - a.pph! || b.volume - a.volume)[0] ?? null;
  const first = lines[0];
  return { ps: bestOf('PS'), pd: bestOf('PD'), overall: first && first.effectiveness !== null ? first : null };
}
