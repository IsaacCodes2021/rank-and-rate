// Saving a night's end-of-night totals (D052, D065, D073): one final entry per line with its
// total hours and volume. The admin's beta screen and the full-timer screen both save through here.
// Blank rows are skipped. If any row is wrong nothing is saved. A second save for the same
// night replaces the first, and the audit log keeps what was there before.
import { hours as hoursFromEntries, type Entry } from '../scoring/index.ts';

export const SORTS = ['Afternoon', 'Morning', 'Twilight'] as const;
export type Sort = (typeof SORTS)[number];

// Sanity limits that catch typos such as an extra zero. They are not business rules.
export const MAX_HOURS = 500;
export const MAX_VOLUME = 1_000_000;

export type NightRow = {
  lineId: string;
  hours: number | null; // null or undefined = left blank
  volume: number | null;
};

export type NightInput = {
  date: string; // local date of the sort, YYYY-MM-DD
  sort: string;
  rows: NightRow[];
  actor: string; // who is saving, for the audit log: "admin" or a supervisor's name
  supervisorId?: number | null; // set when a full-timer saves for themselves; empty for the admin
};

export type NightResult = {
  shiftId: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
};

export type FieldError = { lineId: string | null; message: string };

export class ValidationError extends Error {
  errors: FieldError[];
  constructor(errors: FieldError[]) {
    super(errors.map((e) => (e.lineId ? `${e.lineId}: ${e.message}` : e.message)).join('; '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

export const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const isSort = (s: string): s is Sort => (SORTS as readonly string[]).includes(s);

export type LineInfo = { id: string; type: string; number: number };

// Active lines in screen order: PS then PD, by number (D065).
export async function listActiveLines(db: D1Database): Promise<LineInfo[]> {
  const r = await db.prepare('SELECT id, type, number FROM line WHERE active = 1 ORDER BY type DESC, number').all<LineInfo>();
  return r.results;
}

export type SavedTotal = { lineId: string; hours: number; volume: number };

// What is already saved for a night, so the screen can show it for correcting. A final entry
// from the phone flow has no total_hours; its hours come from the quarter-hour entries.
export async function getNightTotals(db: D1Database, date: string, sort: string): Promise<SavedTotal[]> {
  const rows = await db
    .prepare(
      `SELECT e.line_id, e.slot, e.kind, e.headcount, e.running_volume, e.total_hours
         FROM entry e JOIN shift s ON s.id = e.shift_id
        WHERE s.date = ? AND s.sort = ?`,
    )
    .bind(date, sort)
    .all<{ line_id: string; slot: number | null; kind: Entry['kind']; headcount: number | null; running_volume: number | null; total_hours: number | null }>();
  const byLine = new Map<string, Entry[]>();
  for (const r of rows.results) {
    const list = byLine.get(r.line_id) ?? [];
    list.push({ kind: r.kind, slot: r.slot, headcount: r.headcount, runningVolume: r.running_volume, totalHours: r.total_hours });
    byLine.set(r.line_id, list);
  }
  const out: SavedTotal[] = [];
  for (const [lineId, entries] of byLine) {
    const final = entries.find((e) => e.kind === 'final');
    if (!final || final.runningVolume === null) continue;
    out.push({ lineId, hours: Math.round(hoursFromEntries(entries) * 100) / 100, volume: final.runningVolume });
  }
  return out.sort((a, b) => a.lineId.localeCompare(b.lineId));
}

type Existing = { line_id: string; running_volume: number | null; total_hours: number | null };

export async function saveNightTotals(db: D1Database, input: NightInput, now: Date = new Date()): Promise<NightResult> {
  const errors: FieldError[] = [];
  if (!isRealDate(input.date)) errors.push({ lineId: null, message: 'Pick a real date (YYYY-MM-DD).' });
  if (!isSort(input.sort)) errors.push({ lineId: null, message: 'Pick Afternoon, Morning or Twilight.' });

  const lines = await db.prepare('SELECT id FROM line WHERE active = 1').all<{ id: string }>();
  const activeLines = new Set(lines.results.map((l) => l.id));

  const toSave: { lineId: string; hours: number; volume: number }[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const row of input.rows) {
    if (seen.has(row.lineId)) {
      errors.push({ lineId: row.lineId, message: 'This line appears twice.' });
      continue;
    }
    seen.add(row.lineId);
    if (!activeLines.has(row.lineId)) {
      errors.push({ lineId: row.lineId, message: 'Unknown or inactive line.' });
      continue;
    }
    const blankHours = isBlank(row.hours);
    const blankVolume = isBlank(row.volume);
    if (blankHours && blankVolume) {
      skipped += 1;
      continue;
    }
    if (blankHours || blankVolume) {
      errors.push({ lineId: row.lineId, message: 'Enter both hours and volume, or leave both blank.' });
      continue;
    }
    const hours = Number(row.hours);
    const volume = Number(row.volume);
    if (!Number.isFinite(hours) || hours < 0 || hours > MAX_HOURS) {
      errors.push({ lineId: row.lineId, message: `Hours must be a number from 0 to ${MAX_HOURS}.` });
      continue;
    }
    if (!Number.isInteger(volume) || volume < 0 || volume > MAX_VOLUME) {
      errors.push({ lineId: row.lineId, message: `Volume must be a whole number from 0 to ${MAX_VOLUME}.` });
      continue;
    }
    toSave.push({ lineId: row.lineId, hours, volume });
  }
  if (errors.length === 0 && toSave.length === 0) errors.push({ lineId: null, message: 'Nothing to save: every row is blank.' });
  if (errors.length > 0) throw new ValidationError(errors);

  const existing = await db
    .prepare(
      `SELECT e.line_id, e.running_volume, e.total_hours
         FROM entry e JOIN shift s ON s.id = e.shift_id
        WHERE s.date = ? AND s.sort = ? AND e.kind = 'final'`,
    )
    .bind(input.date, input.sort)
    .all<Existing>();
  const before = new Map(existing.results.map((r) => [r.line_id, r]));

  const at = now.toISOString();
  const statements = [
    db
      .prepare("INSERT INTO shift (date, sort, status) VALUES (?, ?, 'final') ON CONFLICT (date, sort) DO UPDATE SET status = 'final'")
      .bind(input.date, input.sort),
  ];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const row of toSave) {
    const old = before.get(row.lineId);
    if (old && old.running_volume === row.volume && old.total_hours === row.hours) {
      unchanged += 1;
      continue;
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO entry (shift_id, line_id, supervisor_id, slot, kind, headcount, running_volume, total_hours, created_at)
           VALUES ((SELECT id FROM shift WHERE date = ? AND sort = ?), ?, ?, NULL, 'final', NULL, ?, ?, ?)
           ON CONFLICT (shift_id, line_id) WHERE kind = 'final'
           DO UPDATE SET running_volume = excluded.running_volume, total_hours = excluded.total_hours, created_at = excluded.created_at`,
        )
        .bind(input.date, input.sort, row.lineId, input.supervisorId ?? null, row.volume, row.hours, at),
      db
        .prepare('INSERT INTO audit_log (at, actor, action, before, after) VALUES (?, ?, ?, ?, ?)')
        .bind(
          at,
          input.actor,
          old ? 'night totals changed' : 'night totals saved',
          old ? JSON.stringify({ line: row.lineId, date: input.date, sort: input.sort, hours: old.total_hours, volume: old.running_volume }) : null,
          JSON.stringify({ line: row.lineId, date: input.date, sort: input.sort, hours: row.hours, volume: row.volume }),
        ),
    );
    if (old) updated += 1;
    else created += 1;
  }
  await db.batch(statements);

  const shift = await db.prepare('SELECT id FROM shift WHERE date = ? AND sort = ?').bind(input.date, input.sort).first<{ id: number }>();
  return { shiftId: shift!.id, created, updated, unchanged, skipped };
}
