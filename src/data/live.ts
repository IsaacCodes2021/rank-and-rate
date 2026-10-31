// What the live sort view reads (D035, D122): open to anyone with the link, so it reads only what
// the screens show, and never a PIN hash. One sort at a time, so sorts cannot mix (D115).
import { expectedPph, quarterHourSlot, type Entry } from '../scoring/index.ts';
import type { LineType, LiveLineInput } from '../scoring/live.ts';

export type SortRef = { id: number; date: string; sort: string; status: 'open' | 'final' };

export type LiveLine = LiveLineInput & { group: string; supervisors: string[]; lastAt: string | null };

export type LiveSort = SortRef & {
  startsAt: string | null;
  endsAt: string | null;
  lines: LiveLine[];
};

// Open sorts with something on them, newest first, then every finished sort on the latest day that
// has one, so a day's sorts are one tap apart (D128). A sort somebody forgot to close stops showing
// as running after two days.
export async function recentSorts(db: D1Database, today: string): Promise<{ open: SortRef[]; finished: SortRef[] }> {
  const since = new Date(Date.parse(`${today}T12:00:00Z`) - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const open = await db
    .prepare(
      `SELECT s.id, s.date, s.sort, s.status FROM shift s
        WHERE s.status = 'open' AND s.date >= ?
          AND (EXISTS (SELECT 1 FROM entry e WHERE e.shift_id = s.id) OR EXISTS (SELECT 1 FROM assignment a WHERE a.shift_id = s.id))
        ORDER BY s.date DESC, s.id DESC`,
    )
    .bind(since)
    .all<SortRef>();
  const finished = await db
    .prepare(
      `SELECT s.id, s.date, s.sort, s.status FROM shift s
        WHERE s.status = 'final' AND EXISTS (SELECT 1 FROM entry e WHERE e.shift_id = s.id)
          AND s.date = (SELECT max(d.date) FROM shift d WHERE d.status = 'final' AND EXISTS (SELECT 1 FROM entry e WHERE e.shift_id = d.id))
        ORDER BY s.ends_at DESC, s.id DESC`,
    )
    .all<SortRef>();
  return { open: open.results, finished: finished.results };
}

type LineRow = { id: string; type: LineType; grp: string; expected_pph_override: number | null };
type EntryRow = {
  line_id: string;
  slot: number | null;
  kind: Entry['kind'];
  headcount: number | null;
  running_volume: number | null;
  total_hours: number | null;
  created_at: string;
};
type AssignmentRow = { line_id: string; full_name: string; started_at: string };

// One sort with every active line, including lines nobody is on, plus any since taken off the list
// that have numbers on this sort.
export async function loadLiveSort(db: D1Database, shiftId: number): Promise<LiveSort | null> {
  if (!Number.isSafeInteger(shiftId)) return null;
  const [shiftResult, linesResult, settingsResult, entriesResult, assignmentsResult] = await db.batch<unknown>([
    db.prepare('SELECT id, date, sort, status, starts_at, ends_at FROM shift WHERE id = ?').bind(shiftId),
    db.prepare(
      `SELECT l.id, l.type, l.grp, l.expected_pph_override FROM line l
        WHERE l.active = 1 OR EXISTS (SELECT 1 FROM entry e WHERE e.line_id = l.id AND e.shift_id = ?)
        ORDER BY l.type DESC, l.number`,
    ).bind(shiftId),
    db.prepare("SELECT key, value FROM settings WHERE key LIKE 'expected_pph.%'"),
    db.prepare('SELECT line_id, slot, kind, headcount, running_volume, total_hours, created_at FROM entry WHERE shift_id = ?').bind(shiftId),
    db.prepare(
      `SELECT a.line_id, sup.full_name, a.started_at FROM assignment a JOIN supervisor sup ON sup.id = a.supervisor_id
        WHERE a.shift_id = ? ORDER BY a.started_at`,
    ).bind(shiftId),
  ]);
  const shift = (shiftResult.results as (SortRef & { starts_at: string | null; ends_at: string | null })[])[0];
  if (!shift) return null;

  const settings: Record<string, number> = {};
  for (const r of settingsResult.results as { key: string; value: string }[]) settings[r.key] = Number(r.value);

  const entriesByLine = new Map<string, EntryRow[]>();
  for (const r of entriesResult.results as EntryRow[]) entriesByLine.set(r.line_id, [...(entriesByLine.get(r.line_id) ?? []), r]);
  const assignmentsByLine = new Map<string, AssignmentRow[]>();
  for (const r of assignmentsResult.results as AssignmentRow[]) assignmentsByLine.set(r.line_id, [...(assignmentsByLine.get(r.line_id) ?? []), r]);

  const lines = (linesResult.results as LineRow[]).map((l): LiveLine => {
    const rows = entriesByLine.get(l.id) ?? [];
    const assignments = assignmentsByLine.get(l.id) ?? [];
    return {
      id: l.id,
      type: l.type,
      group: l.grp,
      expectedPph: expectedPph({ group: l.grp, expectedPphOverride: l.expected_pph_override }, settings, shift.sort),
      entries: rows.map((r) => ({
        kind: r.kind,
        slot: r.slot,
        headcount: r.headcount,
        runningVolume: r.running_volume,
        totalHours: r.total_hours,
        atMs: r.kind === 'final' ? Date.parse(r.created_at) : null,
      })),
      assignedSlot: assignments.length ? quarterHourSlot(Date.parse(assignments[0].started_at)) : null,
      supervisors: assignments.map((a) => a.full_name),
      lastAt: rows.map((r) => r.created_at).sort().pop() ?? null,
    };
  });
  return { id: shift.id, date: shift.date, sort: shift.sort, status: shift.status, startsAt: shift.starts_at, endsAt: shift.ends_at, lines };
}
