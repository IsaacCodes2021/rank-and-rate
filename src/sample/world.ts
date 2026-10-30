// Made-up numbers for the sample pages (D121). Nothing here reads or writes the database: every
// number comes from a seeded generator, so the same date always gives the same night and nothing
// is ever saved. The formulas and screens are the real ones, so a sample page shows what the
// real site would show.
import type { LiveLine, LiveSort, SortRef } from '../data/live.ts';
import { pacificOffsetHours } from '../format.ts';
import { quarterHourSlot, sortStartMs, type Entry } from '../scoring/index.ts';
import { lineNumbers, type LineType } from '../scoring/live.ts';

const QUARTER_MS = 15 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SampleLine = { id: string; type: LineType; group: string; expectedPph: number };

const PD_NORTH = new Set([1, 2, 3, 4, 5, 14]);

// The real 27 lines and expected PPH (D006, D041). A test checks these against the seed.
export const SAMPLE_LINES: SampleLine[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14].map((n): SampleLine => ({ id: `PS${n}`, type: 'PS', group: 'Unload', expectedPph: 550 })),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((n): SampleLine => (PD_NORTH.has(n) ? { id: `PD${n}`, type: 'PD', group: 'North', expectedPph: 275 } : { id: `PD${n}`, type: 'PD', group: 'Wings', expectedPph: 350 })),
];

export const SAMPLE_SORTS = ['Afternoon', 'Twilight'] as const;
export type SampleSort = (typeof SAMPLE_SORTS)[number];

// When the sample sorts run. Twilight starts before Afternoon has finished, so they overlap (D115).
const SCHEDULE: Record<SampleSort, { first: string; last: string; id: number }> = {
  Afternoon: { first: '13:15', last: '17:15', id: 1 },
  Twilight: { first: '17:30', last: '22:00', id: 2 },
};

// Points in the night to look at, so one page can show a sort from start to finish.
export const SAMPLE_MOMENTS = [
  { at: '13:45', label: 'Sort just started' },
  { at: '15:30', label: 'Mid-sort' },
  { at: '17:35', label: 'Two sorts overlap' },
  { at: '20:00', label: 'Next sort' },
  { at: '23:00', label: 'Night finished' },
] as const;
export const DEFAULT_MOMENT = '15:30';

export function isSampleTime(at: string): boolean {
  return /^(1[3-9]|2[0-3]):[0-5][0-9]$/.test(at);
}

function randomFor(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A building's local time as a moment.
export function pacificMs(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00Z`) - pacificOffsetHours(date) * 60 * MINUTE_MS;
}

type Night = {
  supervisor: string;
  assignedMs: number;
  updates: { slot: number; headcount: number; volume: number; atMs: number }[];
  final: { volume: number; atMs: number };
};

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / DAY_MS);

// One line on one sort, in full. `quiet` makes a line go silent for a stretch, to show what late looks like.
function fullNight(line: SampleLine, index: number, date: string, sort: SampleSort, quiet?: { from: number; to: number }): Night | null {
  const trait = randomFor(line.id);
  const usual = 0.94 + trait() * 0.26; // how this line usually does against expected, before the night's slow patches
  const phase = trait() * 40;
  const crew = line.type === 'PS' ? 7 + Math.floor(trait() * 5) : 4 + Math.floor(trait() * 5);

  const r = randomFor(`${date}|${sort}|${line.id}`);
  const rarelyRun = line.id === 'PS14' || line.id === 'PD13';
  if (r() < (rarelyRun ? 0.4 : 0.02)) return null; // nobody ran this line tonight

  const day = dayNumber(date);
  const effectiveness = usual + Math.sin((day + phase) / 9) * 0.05 + (r() - 0.5) * 0.14;
  const { first, last } = SCHEDULE[sort];
  const firstSlot = quarterHourSlot(pacificMs(date, first));
  const lastSlot = quarterHourSlot(pacificMs(date, last));

  // Supervisors move between lines from week to week (D012).
  const week = Math.floor(day / 7);
  const name = String(((index + week + (sort === 'Twilight' ? 7 : 0)) % 20) + 1).padStart(2, '0');
  const quietStart = r() < 0.15 ? firstSlot + 2 + Math.floor(r() * 10) : -1;
  const shape = randomFor(`${date}|${sort}`);
  const lullStart = firstSlot + 4 + Math.floor(shape() * (lastSlot - firstSlot - 7));
  const lullDepth = 0.62 + shape() * 0.2;
  const quietLength = 2 + Math.floor(r() * 3);

  const updates: Night['updates'] = [];
  let running = 0;
  for (let slot = firstSlot; slot <= lastSlot; slot += 1) {
    const change = r() < 0.2 ? (r() < 0.5 ? 1 : -1) : 0;
    const headcount = Math.max(1, crew + change);
    const rampUp = 0.8 + 0.2 * Math.min(1, (slot - firstSlot) / 4);
    const lull = slot >= lullStart && slot < lullStart + 3 ? lullDepth : 1;
    running += Math.round(headcount * 0.25 * line.expectedPph * effectiveness * rampUp * lull * (0.92 + r() * 0.16));
    const inQuiet = quiet ? slot >= quiet.from && slot <= quiet.to : slot >= quietStart && slot < quietStart + quietLength && quietStart > 0;
    const skipped = r() < 0.04;
    if (slot === firstSlot || slot === lastSlot || (!inQuiet && !skipped)) {
      updates.push({ slot, headcount, volume: running, atMs: slot * QUARTER_MS + Math.floor(r() * 100) * 1000 });
    }
  }
  const finalAt = lastSlot * QUARTER_MS + (5 + Math.floor(r() * 25)) * MINUTE_MS;
  return {
    supervisor: `Sample Supervisor ${name}`,
    assignedMs: firstSlot * QUARTER_MS - 10 * MINUTE_MS,
    updates,
    final: { volume: running + Math.round(crew * 0.1 * line.expectedPph), atMs: finalAt },
  };
}

// What a line looks like at a moment in the night, as the live view would read it.
function asOf(line: SampleLine, night: Night | null, throughMs: number): LiveLine {
  const empty: LiveLine = { id: line.id, type: line.type, group: line.group, expectedPph: line.expectedPph, entries: [], assignedSlot: null, supervisors: [], lastAt: null };
  if (!night || night.assignedMs > throughMs) return empty;
  const updates = night.updates.filter((u) => u.atMs <= throughMs);
  const entries: Entry[] = updates.map((u) => ({ kind: 'interval', slot: u.slot, headcount: u.headcount, runningVolume: u.volume, totalHours: null, atMs: null }));
  const times = updates.map((u) => u.atMs);
  if (night.final.atMs <= throughMs) {
    entries.push({ kind: 'final', slot: null, headcount: null, runningVolume: night.final.volume, totalHours: null, atMs: night.final.atMs });
    times.push(night.final.atMs);
  }
  return {
    ...empty,
    entries,
    assignedSlot: quarterHourSlot(night.assignedMs),
    supervisors: [night.supervisor],
    lastAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

// Tonight, a couple of lines go quiet in the middle of the sort, so Mid-sort has late lines to show.
function quietTonight(line: SampleLine, date: string, sort: SampleSort, today: string) {
  if (date !== today || sort !== 'Afternoon' || (line.id !== 'PS5' && line.id !== 'PD9')) return undefined;
  return { from: quarterHourSlot(pacificMs(date, '15:00')), to: quarterHourSlot(pacificMs(date, '16:00')) };
}

function sampleSort(date: string, sort: SampleSort, throughMs: number, today: string): LiveSort | null {
  const lines = SAMPLE_LINES.map((line, index) => asOf(line, fullNight(line, index, date, sort, quietTonight(line, date, sort, today)), throughMs));
  const inPlay = lines.filter((l) => l.assignedSlot !== null);
  if (inPlay.length === 0) return null;
  const finals = lines.flatMap((l) => l.entries.filter((e) => e.kind === 'final').map((e) => e.atMs as number));
  const updates = lines.flatMap((l) => l.entries.filter((e) => e.kind === 'interval').map((e) => (e.slot as number) * QUARTER_MS));
  const firstMs = updates.length ? Math.min(...updates) : null;
  const allFinal = inPlay.every((l) => l.entries.some((e) => e.kind === 'final'));
  return {
    id: SCHEDULE[sort].id,
    date,
    sort,
    status: allFinal ? 'final' : 'open',
    startsAt: firstMs === null ? null : new Date(sortStartMs(firstMs)).toISOString(),
    endsAt: finals.length ? new Date(Math.max(...finals)).toISOString() : null,
    lines,
  };
}

export type SampleWorld = {
  now: Date;
  sort: LiveSort | null;
  open: SortRef[];
  latestFinished: SortRef | null;
};

const refOf = (s: LiveSort): SortRef => ({ id: s.id, date: s.date, sort: s.sort, status: s.status });

// The site as it would look at a moment tonight. Without a pick it shows what /live would: the newest running sort.
export function sampleWorld(today: string, at: string, pick?: SampleSort): SampleWorld {
  const now = new Date(pacificMs(today, at));
  const sorts = SAMPLE_SORTS.map((s) => sampleSort(today, s, now.getTime(), today)).filter((s): s is LiveSort => s !== null);
  const open = sorts.filter((s) => s.status === 'open').reverse();
  const finished = sorts.filter((s) => s.status === 'final').reverse();
  const picked = sorts.find((s) => s.sort === pick);
  return {
    now,
    sort: picked ?? open[0] ?? finished[0] ?? null,
    open: open.map(refOf),
    latestFinished: finished.length ? refOf(finished[0]) : null,
  };
}

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

function weekdaysBefore(today: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${today}T12:00:00Z`);
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() - 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Eight weeks of finished sorts for one line, newest first. Tonight is left out: it is still running on /sample.
export function sampleLineHistory(lineId: string, today: string, nights = 40): LineNightRow[] {
  const index = SAMPLE_LINES.findIndex((l) => l.id === lineId);
  if (index < 0) return [];
  const line = SAMPLE_LINES[index];
  const rows: LineNightRow[] = [];
  for (const date of weekdaysBefore(today, nights)) {
    for (const sort of [...SAMPLE_SORTS].reverse()) {
      const night = fullNight(line, index, date, sort);
      if (!night) continue;
      const live = asOf(line, night, night.final.atMs);
      const n = lineNumbers(live, night.final.atMs, false);
      rows.push({
        date,
        sort,
        supervisors: live.supervisors,
        hours: n.hours,
        volume: n.volume,
        pph: n.pph,
        effectiveness: n.effectiveness,
        overUnder: n.overUnder,
      });
    }
  }
  return rows;
}
