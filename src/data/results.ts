// What the results page and a line's history read (D028, D035): open to anyone with the link, so it
// reads only what the screens show, and never a PIN hash. Only finished sorts count, and one sort is
// read at a time, so sorts cannot mix (D115).
import { expectedPph, hours, volume, type Entry } from '../scoring/index.ts';
import type { LineType } from '../scoring/live.ts';
import type { DateRange } from '../scoring/periods.ts';
import type { NightLine } from '../scoring/results.ts';
import { SORTS } from './night.ts';

export type SortDays = { sort: string; latest: string };

// The sorts with a finished night, in the usual order, each with its latest date. Just one line's if one is named.
export async function finishedSortDays(db: D1Database, lineId: string | null = null): Promise<SortDays[]> {
  const rows = await db
    .prepare(
      `SELECT s.sort, max(s.date) AS latest FROM shift s
        WHERE s.status = 'final' AND EXISTS (SELECT 1 FROM entry e WHERE e.shift_id = s.id AND (? IS NULL OR e.line_id = ?))
        GROUP BY s.sort`,
    )
    .bind(lineId, lineId)
    .all<SortDays>();
  return SORTS.flatMap((sort) => rows.results.filter((r) => r.sort === sort));
}

export type LineInfo = { id: string; type: LineType; group: string; expectedPph: number };

type LineRow = { id: string; type: LineType; grp: string; expected_pph_override: number | null; active: number };

const expectedOf = (l: LineRow, settings: Record<string, number>) => expectedPph({ group: l.grp, expectedPphOverride: l.expected_pph_override }, settings);

const settingsFrom = (rows: { key: string; value: string }[]) => Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));

const LINE_COLUMNS = 'SELECT id, type, grp, expected_pph_override, active FROM line';
const EXPECTED_SETTINGS = "SELECT key, value FROM settings WHERE key LIKE 'expected_pph.%'";

// One line's details, or null if there is no such line.
export async function findLine(db: D1Database, id: string): Promise<LineInfo | null> {
  const [lineResult, settingsResult] = await db.batch<unknown>([db.prepare(`${LINE_COLUMNS} WHERE id = ?`).bind(id), db.prepare(EXPECTED_SETTINGS)]);
  const line = (lineResult.results as LineRow[])[0];
  if (!line) return null;
  return { id: line.id, type: line.type, group: line.grp, expectedPph: expectedOf(line, settingsFrom(settingsResult.results as { key: string; value: string }[])) ?? 0 };
}

type EntryRow = {
  date: string;
  line_id: string;
  slot: number | null;
  kind: Entry['kind'];
  headcount: number | null;
  running_volume: number | null;
  total_hours: number | null;
  created_at: string;
};
type AssignmentRow = { date: string; line_id: string; full_name: string };

export type NightLines = { rows: NightLine[]; activeLines: number };

// One row per line per finished night of a sort, newest first. Just one line's if one is named.
export async function loadNightLines(db: D1Database, { sort, range, lineId = null }: { sort: string; range: DateRange; lineId?: string | null }): Promise<NightLines> {
  const within = "s.status = 'final' AND s.sort = ? AND (? IS NULL OR s.date >= ?) AND (? IS NULL OR s.date <= ?)";
  const binds = [sort, range.from, range.from, range.to, range.to, lineId, lineId];
  const [linesResult, settingsResult, entriesResult, assignmentsResult] = await db.batch<unknown>([
    db.prepare(LINE_COLUMNS),
    db.prepare(EXPECTED_SETTINGS),
    db
      .prepare(
        `SELECT s.date, e.line_id, e.slot, e.kind, e.headcount, e.running_volume, e.total_hours, e.created_at
           FROM entry e JOIN shift s ON s.id = e.shift_id
          WHERE ${within} AND (? IS NULL OR e.line_id = ?)
          ORDER BY s.date DESC`,
      )
      .bind(...binds),
    db
      .prepare(
        `SELECT s.date, a.line_id, sup.full_name
           FROM assignment a JOIN shift s ON s.id = a.shift_id JOIN supervisor sup ON sup.id = a.supervisor_id
          WHERE ${within} AND (? IS NULL OR a.line_id = ?)
          ORDER BY a.started_at`,
      )
      .bind(...binds),
  ]);

  const lines = linesResult.results as LineRow[];
  const settings = settingsFrom(settingsResult.results as { key: string; value: string }[]);
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const entriesByNight = new Map<string, EntryRow[]>();
  for (const r of entriesResult.results as EntryRow[]) {
    const key = `${r.date}|${r.line_id}`;
    entriesByNight.set(key, [...(entriesByNight.get(key) ?? []), r]);
  }
  const namesByNight = new Map<string, string[]>();
  for (const a of assignmentsResult.results as AssignmentRow[]) {
    const key = `${a.date}|${a.line_id}`;
    namesByNight.set(key, [...(namesByNight.get(key) ?? []), a.full_name]);
  }

  const rows: NightLine[] = [];
  for (const [key, own] of entriesByNight) {
    const line = lineById.get(own[0].line_id);
    if (!line) continue;
    const entries: Entry[] = own.map((r) => ({
      kind: r.kind,
      slot: r.slot,
      headcount: r.headcount,
      runningVolume: r.running_volume,
      totalHours: r.total_hours,
      atMs: r.kind === 'final' ? Date.parse(r.created_at) : null,
    }));
    rows.push({
      date: own[0].date,
      sort,
      lineId: line.id,
      type: line.type,
      group: line.grp,
      expectedPph: expectedOf(line, settings),
      supervisors: namesByNight.get(key) ?? [],
      hours: hours(entries),
      volume: volume(entries),
    });
  }
  return { rows, activeLines: lines.filter((l) => l.active === 1).length };
}
