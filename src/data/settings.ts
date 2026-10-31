// The expected PPH of each area group on each sort (D041, D134), which the admin can change on its
// own screen. Calculated numbers are worked out on load (D081), so a change applies to every saved
// night of that sort, past nights included. If any row is wrong nothing is saved, and the audit log
// keeps the old value. A sort with no number of its own uses the group's default in settings.
import { expectedPph, expectedPphKey } from '../scoring/index.ts';
import { SORTS, ValidationError, isSort, type FieldError, type Sort } from './night.ts';

// A sanity limit that catches typos such as an extra zero. It is not a business rule.
export const MAX_EXPECTED_PPH = 2000;

export type ExpectedGroup = { group: string; lines: string[]; bySort: Record<Sort, number | null> };

export type ExpectedRow = { group: string; sort: string; expectedPph: number | string | null };

export type ExpectedResult = { changed: number; unchanged: number };

// Each group with its active lines, in screen order: PS then PD, by number, so Unload, North, Wings.
export async function listExpectedPph(db: D1Database): Promise<ExpectedGroup[]> {
  const [linesResult, settingsResult] = await db.batch<unknown>([
    db.prepare('SELECT id, grp FROM line WHERE active = 1 ORDER BY type DESC, number'),
    db.prepare("SELECT key, value FROM settings WHERE key LIKE 'expected_pph.%'"),
  ]);
  const settings = Object.fromEntries((settingsResult.results as { key: string; value: string }[]).map((s) => [s.key, Number(s.value)]));
  const groups = new Map<string, ExpectedGroup>();
  for (const line of linesResult.results as { id: string; grp: string }[]) {
    const bySort = Object.fromEntries(SORTS.map((sort) => [sort, expectedPph({ group: line.grp, expectedPphOverride: null }, settings, sort)])) as Record<Sort, number | null>;
    const group = groups.get(line.grp) ?? { group: line.grp, lines: [], bySort };
    group.lines.push(line.id);
    groups.set(line.grp, group);
  }
  return [...groups.values()];
}

export async function saveExpectedPph(db: D1Database, input: { rows: ExpectedRow[]; actor: string }, now: Date = new Date()): Promise<ExpectedResult> {
  const saved = new Map((await listExpectedPph(db)).map((g) => [g.group, g.bySort]));
  const errors: FieldError[] = [];
  const toSave: { group: string; sort: Sort; expectedPph: number }[] = [];
  const seen = new Set<string>();
  for (const { group, sort, expectedPph: value } of input.rows) {
    if (!saved.has(group) || !isSort(sort)) {
      errors.push({ lineId: null, message: 'That area or sort does not exist.' });
      continue;
    }
    const name = `${sort} ${group}`;
    if (seen.has(name)) {
      errors.push({ lineId: null, message: `${name} appears twice.` });
      continue;
    }
    seen.add(name);
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > MAX_EXPECTED_PPH) {
      errors.push({ lineId: null, message: `${name}: expected PPH must be a whole number from 1 to ${MAX_EXPECTED_PPH}.` });
      continue;
    }
    toSave.push({ group, sort, expectedPph: number });
  }
  if (errors.length > 0) throw new ValidationError(errors);

  const at = now.toISOString();
  const statements = toSave
    .filter((row) => saved.get(row.group)![row.sort] !== row.expectedPph)
    .flatMap((row) => [
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(expectedPphKey(row.group, row.sort), String(row.expectedPph)),
      db
        .prepare('INSERT INTO audit_log (at, actor, action, before, after) VALUES (?, ?, ?, ?, ?)')
        .bind(at, input.actor, 'expected PPH changed', JSON.stringify({ group: row.group, sort: row.sort, expectedPph: saved.get(row.group)![row.sort] }), JSON.stringify(row)),
    ]);
  if (statements.length > 0) await db.batch(statements);
  const changed = statements.length / 2;
  return { changed, unchanged: toSave.length - changed };
}
