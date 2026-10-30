// A supervisor's night on the phone (D005, D013, D016, D032, D066): start a sort on their lines,
// send headcount and running volume every 15 minutes, then a final volume per line.
//
// Sorts never mix (D115). A supervisor can have several open at once, and one sort can be taking
// its finals while the next takes its first updates, on the same lines. Every save names the sort
// on the screen it came from, and the save is checked against that supervisor's own lines on it.
import { hours, pph, quarterHourSlot, sortStartMs, volume as volumeSoFar, type Entry } from '../scoring/index.ts';
import { MAX_VOLUME, ValidationError, isBlank, isSort, listActiveLines, type FieldError } from './night.ts';
import type { SupervisorInfo } from './supervisor.ts';

// A typo check, like MAX_VOLUME. Not a business rule.
export const MAX_HEADCOUNT = 200;

// A sort stays open to a supervisor this long after they last picked lines on it, which is longer
// than any sort. A forgotten sort from yesterday then stops showing, and a phone left on an old
// screen cannot save into it.
const OPEN_HOURS = 16;

export type ShiftLine = {
  lineId: string;
  hours: number;
  volume: number;
  pph: number | null;
  lastHeadcount: number | null;
  lastVolume: number | null;
  lastAt: string | null;
  finalVolume: number | null;
  hasMyEntries: boolean; // a line can only be dropped while this is false
  entries: Entry[];
};

export type MyShift = {
  id: number;
  date: string;
  sort: string;
  lines: ShiftLine[];
  finished: boolean; // every one of this supervisor's lines on this sort has its final
};

type EntryRow = {
  line_id: string;
  supervisor_id: number | null;
  slot: number | null;
  kind: Entry['kind'] | null;
  headcount: number | null;
  running_volume: number | null;
  total_hours: number | null;
  created_at: string | null;
};

type ShiftRow = { id: number; date: string; sort: string };

const openSince = (now: Date) => new Date(now.getTime() - OPEN_HOURS * 60 * 60 * 1000).toISOString();

// This supervisor's lines on one sort, with what has come in so far on them on that sort only.
async function linesOf(db: D1Database, shiftId: number, supervisorId: number): Promise<ShiftLine[]> {
  const rows = await db
    .prepare(
      `SELECT a.line_id, e.supervisor_id, e.slot, e.kind, e.headcount, e.running_volume, e.total_hours, e.created_at
         FROM assignment a
         JOIN line l ON l.id = a.line_id
         LEFT JOIN entry e ON e.shift_id = a.shift_id AND e.line_id = a.line_id
        WHERE a.shift_id = ? AND a.supervisor_id = ?
        ORDER BY l.type DESC, l.number, e.slot`,
    )
    .bind(shiftId, supervisorId)
    .all<EntryRow>();

  const byLine = new Map<string, EntryRow[]>();
  for (const r of rows.results) byLine.set(r.line_id, [...(byLine.get(r.line_id) ?? []), r]);

  return [...byLine].map(([lineId, list]): ShiftLine => {
    const stored = list.filter((r) => r.kind !== null);
    const entries = stored.map((r): Entry => ({
      kind: r.kind as Entry['kind'],
      slot: r.slot,
      headcount: r.headcount,
      runningVolume: r.running_volume,
      totalHours: r.total_hours,
      atMs: r.kind === 'final' ? Date.parse(r.created_at as string) : null,
    }));
    const intervals = stored.filter((r) => r.kind === 'interval');
    const last = intervals[intervals.length - 1] ?? null; // sorted by slot above
    const final = stored.find((r) => r.kind === 'final') ?? null;
    const hrs = hours(entries);
    const vol = volumeSoFar(entries);
    return {
      lineId,
      hours: hrs,
      volume: vol,
      pph: pph(vol, hrs),
      lastHeadcount: last?.headcount ?? null,
      lastVolume: last?.running_volume ?? null,
      lastAt: stored.map((r) => r.created_at as string).sort().pop() ?? null,
      finalVolume: final?.running_volume ?? null,
      hasMyEntries: stored.some((r) => r.supervisor_id === supervisorId),
      entries,
    };
  });
}

const withLines = async (db: D1Database, row: ShiftRow, supervisorId: number): Promise<MyShift> => {
  const lines = await linesOf(db, row.id, supervisorId);
  return { ...row, lines, finished: lines.length > 0 && lines.every((l) => l.finalVolume !== null) };
};

// Every sort open to this supervisor, the one they most recently picked lines on first.
export async function myShifts(db: D1Database, supervisorId: number, now: Date = new Date()): Promise<MyShift[]> {
  const rows = await db
    .prepare(
      `SELECT s.id, s.date, s.sort FROM assignment a JOIN shift s ON s.id = a.shift_id
        WHERE a.supervisor_id = ?
        GROUP BY s.id HAVING max(a.started_at) > ?
        ORDER BY max(a.started_at) DESC, s.id DESC`,
    )
    .bind(supervisorId, openSince(now))
    .all<ShiftRow>();
  return Promise.all(rows.results.map((row) => withLines(db, row, supervisorId)));
}

// The lines this supervisor picked most recently, to start the next sort with them ticked.
export async function lastLines(db: D1Database, supervisorId: number): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT line_id FROM assignment
        WHERE supervisor_id = ?
          AND shift_id = (SELECT shift_id FROM assignment WHERE supervisor_id = ? ORDER BY started_at DESC, shift_id DESC LIMIT 1)`,
    )
    .bind(supervisorId, supervisorId)
    .all<{ line_id: string }>();
  return rows.results.map((r) => r.line_id);
}

// One sort, only if it is open to this supervisor.
export async function myShift(db: D1Database, supervisorId: number, shiftId: number, now: Date = new Date()): Promise<MyShift | null> {
  if (!Number.isSafeInteger(shiftId)) return null;
  const row = await db
    .prepare(
      `SELECT s.id, s.date, s.sort FROM assignment a JOIN shift s ON s.id = a.shift_id
        WHERE a.supervisor_id = ? AND s.id = ?
        GROUP BY s.id HAVING max(a.started_at) > ?`,
    )
    .bind(supervisorId, shiftId, openSince(now))
    .first<ShiftRow>();
  return row ? withLines(db, row, supervisorId) : null;
}

// A sort is closed once every line assigned to it has a final (D066). A new line reopens it.
const refreshStatus = (db: D1Database, shiftWhere: string, ...params: (string | number)[]) =>
  db
    .prepare(
      `UPDATE shift SET status = CASE WHEN EXISTS (
         SELECT 1 FROM assignment a
          WHERE a.shift_id = shift.id
            AND NOT EXISTS (SELECT 1 FROM entry e WHERE e.shift_id = a.shift_id AND e.line_id = a.line_id AND e.kind = 'final')
       ) THEN 'open' ELSE 'final' END
       WHERE ${shiftWhere}`,
    )
    .bind(...params);

const audit = (db: D1Database, at: string, actor: string, action: string, before: unknown, after: unknown) =>
  db
    .prepare('INSERT INTO audit_log (at, actor, action, before, after) VALUES (?, ?, ?, ?, ?)')
    .bind(at, actor, action, before === null ? null : JSON.stringify(before), JSON.stringify(after));

// The line ids in a pick, or errors for the ones that are not active lines.
async function readPick(db: D1Database, lineIds: unknown, errors: FieldError[]): Promise<Set<string>> {
  const active = new Set((await listActiveLines(db)).map((l) => l.id));
  const wanted = new Set<string>();
  for (const id of Array.isArray(lineIds) ? lineIds : []) {
    if (typeof id !== 'string' || !active.has(id)) errors.push({ lineId: typeof id === 'string' ? id : null, message: 'Unknown or inactive line.' });
    else wanted.add(id);
  }
  return wanted;
}

export type StartInput = { sort: string; lineIds: unknown; today: string };

// Starts a sort on the picked lines, leaving any other sort they have open as it is. Picking a
// sort they already have open adds to it, so one that runs past midnight keeps its date.
export async function startShift(db: D1Database, who: SupervisorInfo, input: StartInput, now: Date = new Date()): Promise<{ shiftId: number }> {
  const errors: FieldError[] = [];
  if (!isSort(input.sort)) errors.push({ lineId: null, message: 'Choose the sort first.' });
  const wanted = await readPick(db, input.lineIds, errors);
  if (errors.length === 0 && wanted.size === 0) errors.push({ lineId: null, message: 'Pick at least one line.' });
  if (errors.length > 0) throw new ValidationError(errors);

  const open = (await myShifts(db, who.id, now)).find((s) => s.sort === input.sort && !s.finished);
  const date = open ? open.date : input.today;
  const at = now.toISOString();
  const statements = [db.prepare('INSERT INTO shift (date, sort) VALUES (?, ?) ON CONFLICT (date, sort) DO NOTHING').bind(date, input.sort)];
  for (const lineId of wanted) {
    statements.push(
      db
        .prepare(
          `INSERT INTO assignment (shift_id, line_id, supervisor_id, started_at)
           VALUES ((SELECT id FROM shift WHERE date = ? AND sort = ?), ?, ?, ?)
           ON CONFLICT (shift_id, line_id, supervisor_id) DO UPDATE SET started_at = excluded.started_at`,
        )
        .bind(date, input.sort, lineId, who.id, at),
    );
  }
  statements.push(
    refreshStatus(db, 'date = ? AND sort = ?', date, input.sort),
    audit(db, at, who.name, 'started sort', null, { date, sort: input.sort, lines: [...wanted] }),
  );
  await db.batch(statements);
  const shift = await db.prepare('SELECT id FROM shift WHERE date = ? AND sort = ?').bind(date, input.sort).first<{ id: number }>();
  return { shiftId: shift!.id };
}

// Changes the lines on one sort. A line with this supervisor's entries on it stays theirs for the
// night; any other line they drop just goes, and a sort left empty by mistake leaves nothing behind.
export async function setShiftLines(db: D1Database, who: SupervisorInfo, shiftId: number, lineIds: unknown, now: Date = new Date()): Promise<void> {
  const shift = await requireShift(db, who, shiftId, now);
  const errors: FieldError[] = [];
  const wanted = await readPick(db, lineIds, errors);
  if (errors.length > 0) throw new ValidationError(errors);

  const at = now.toISOString();
  const statements = [];
  for (const lineId of wanted) {
    if (shift.lines.some((l) => l.lineId === lineId)) continue; // keeps when they started it
    statements.push(db.prepare('INSERT INTO assignment (shift_id, line_id, supervisor_id, started_at) VALUES (?, ?, ?, ?)').bind(shift.id, lineId, who.id, at));
  }
  for (const line of shift.lines) {
    if (line.hasMyEntries || wanted.has(line.lineId)) continue;
    statements.push(db.prepare('DELETE FROM assignment WHERE shift_id = ? AND line_id = ? AND supervisor_id = ?').bind(shift.id, line.lineId, who.id));
  }
  statements.push(
    db
      .prepare(
        `DELETE FROM shift WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM assignment WHERE shift_id = shift.id)
           AND NOT EXISTS (SELECT 1 FROM entry WHERE shift_id = shift.id)`,
      )
      .bind(shift.id),
    refreshStatus(db, 'id = ?', shift.id),
    audit(db, at, who.name, 'changed lines', { date: shift.date, sort: shift.sort, lines: shift.lines.map((l) => l.lineId) }, { date: shift.date, sort: shift.sort, lines: [...wanted] }),
  );
  await db.batch(statements);
}

export type UpdateRow = { lineId: string; headcount: unknown; volume: unknown };

const wholeNumber = (v: unknown, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};

async function requireShift(db: D1Database, who: SupervisorInfo, shiftId: number, now: Date): Promise<MyShift> {
  const shift = await myShift(db, who.id, shiftId, now);
  if (!shift) throw new ValidationError([{ lineId: null, message: 'That sort is not open for you. Go back to your sorts and try again.' }]);
  return shift;
}

// The sort's start comes from its first entry (D066).
const setStartOnce = (db: D1Database, shiftId: number, now: Date) =>
  db.prepare('UPDATE shift SET starts_at = ? WHERE id = ? AND starts_at IS NULL').bind(new Date(sortStartMs(now.getTime())).toISOString(), shiftId);

// One quarter hour's headcount and running volume, for this supervisor's lines on one sort.
// Blank rows are skipped. If any row is wrong nothing is saved.
export async function saveUpdates(db: D1Database, who: SupervisorInfo, shiftId: number, rows: UpdateRow[], now: Date = new Date()): Promise<{ saved: number; skipped: number }> {
  const shift = await requireShift(db, who, shiftId, now);
  const mine = new Map(shift.lines.map((l) => [l.lineId, l]));
  const errors: FieldError[] = [];
  const toSave: { line: ShiftLine; headcount: number; volume: number }[] = [];
  let skipped = 0;
  for (const row of rows) {
    const line = mine.get(row.lineId);
    if (!line) {
      errors.push({ lineId: row.lineId, message: 'That is not one of your lines on this sort.' });
      continue;
    }
    const blankHead = isBlank(row.headcount);
    const blankVolume = isBlank(row.volume);
    if (blankHead && blankVolume) {
      skipped += 1;
      continue;
    }
    if (line.finalVolume !== null) {
      errors.push({ lineId: row.lineId, message: 'This line already has its final update.' });
      continue;
    }
    if (blankHead || blankVolume) {
      errors.push({ lineId: row.lineId, message: 'Enter both people and volume, or leave both blank.' });
      continue;
    }
    const headcount = wholeNumber(row.headcount, MAX_HEADCOUNT);
    const volume = wholeNumber(row.volume, MAX_VOLUME);
    if (headcount === null) errors.push({ lineId: row.lineId, message: `People must be a whole number from 0 to ${MAX_HEADCOUNT}.` });
    if (volume === null) errors.push({ lineId: row.lineId, message: `Volume must be a whole number from 0 to ${MAX_VOLUME}.` });
    if (headcount !== null && volume !== null) toSave.push({ line, headcount, volume });
  }
  if (errors.length === 0 && toSave.length === 0) errors.push({ lineId: null, message: 'Nothing to save: every row is blank.' });
  if (errors.length > 0) throw new ValidationError(errors);

  const slot = quarterHourSlot(now.getTime());
  const at = now.toISOString();
  const statements = [setStartOnce(db, shift.id, now)];
  for (const { line, headcount, volume } of toSave) {
    const old = line.entries.find((e) => e.kind === 'interval' && e.slot === slot);
    statements.push(
      db
        .prepare(
          `INSERT INTO entry (shift_id, line_id, supervisor_id, slot, kind, headcount, running_volume, created_at)
           VALUES (?, ?, ?, ?, 'interval', ?, ?, ?)
           ON CONFLICT (shift_id, line_id, slot) WHERE kind = 'interval'
           DO UPDATE SET supervisor_id = excluded.supervisor_id, headcount = excluded.headcount,
                         running_volume = excluded.running_volume, created_at = excluded.created_at`,
        )
        .bind(shift.id, line.lineId, who.id, slot, headcount, volume, at),
      audit(
        db,
        at,
        who.name,
        old ? 'update changed' : 'update saved',
        old ? { line: line.lineId, date: shift.date, sort: shift.sort, slot, headcount: old.headcount, volume: old.runningVolume } : null,
        { line: line.lineId, date: shift.date, sort: shift.sort, slot, headcount, volume },
      ),
    );
  }
  await db.batch(statements);
  return { saved: toSave.length, skipped };
}

export type FinalRow = { lineId: string; volume: unknown };

// The end-of-night volume per line on one sort. Hours come from the quarter-hour updates, so a
// final here carries none; it replaces any total saved before for that line, and the audit log keeps it.
// Correcting a final keeps its first time, so fixing a typo later does not add hours (D117).
export async function saveFinals(db: D1Database, who: SupervisorInfo, shiftId: number, rows: FinalRow[], now: Date = new Date()): Promise<{ saved: number; skipped: number }> {
  const shift = await requireShift(db, who, shiftId, now);
  const mine = new Map(shift.lines.map((l) => [l.lineId, l]));
  const errors: FieldError[] = [];
  const toSave: { line: ShiftLine; volume: number }[] = [];
  let skipped = 0;
  for (const row of rows) {
    const line = mine.get(row.lineId);
    if (!line) {
      errors.push({ lineId: row.lineId, message: 'That is not one of your lines on this sort.' });
      continue;
    }
    if (isBlank(row.volume)) {
      skipped += 1;
      continue;
    }
    const volume = wholeNumber(row.volume, MAX_VOLUME);
    if (volume === null) errors.push({ lineId: row.lineId, message: `Volume must be a whole number from 0 to ${MAX_VOLUME}.` });
    else toSave.push({ line, volume });
  }
  if (errors.length === 0 && toSave.length === 0) errors.push({ lineId: null, message: 'Nothing to save: every row is blank.' });
  if (errors.length > 0) throw new ValidationError(errors);

  const at = now.toISOString();
  const statements = [setStartOnce(db, shift.id, now)];
  for (const { line, volume } of toSave) {
    statements.push(
      db
        .prepare(
          `INSERT INTO entry (shift_id, line_id, supervisor_id, slot, kind, running_volume, total_hours, created_at)
           VALUES (?, ?, ?, NULL, 'final', ?, NULL, ?)
           ON CONFLICT (shift_id, line_id) WHERE kind = 'final'
           DO UPDATE SET supervisor_id = excluded.supervisor_id, running_volume = excluded.running_volume,
                         total_hours = NULL,
                         created_at = CASE WHEN entry.total_hours IS NULL THEN entry.created_at ELSE excluded.created_at END`,
        )
        .bind(shift.id, line.lineId, who.id, volume, at),
      audit(
        db,
        at,
        who.name,
        line.finalVolume !== null ? 'final changed' : 'final saved',
        line.finalVolume !== null ? { line: line.lineId, date: shift.date, sort: shift.sort, volume: line.finalVolume } : null,
        { line: line.lineId, date: shift.date, sort: shift.sort, volume },
      ),
    );
  }
  statements.push(db.prepare('UPDATE shift SET ends_at = ? WHERE id = ?').bind(at, shift.id), refreshStatus(db, 'id = ?', shift.id));
  await db.batch(statements);
  return { saved: toSave.length, skipped };
}
