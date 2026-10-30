// Fake sorts for demos and dashboard work. Everything it makes is obviously fake:
// supervisors are "Sample Supervisor NN" with a placeholder PIN hash, and the numbers come
// from a seeded random generator, so the same date always gives the same night.
import type { DatabaseSync } from 'node:sqlite';

export type FakeOptions = {
  endDate: string; // YYYY-MM-DD, the latest night to make
  nights?: number; // weekday nights counting back from endDate (D049: Monday to Friday)
  offset?: string; // local UTC offset of the building, e.g. -07:00
};

const SORTS = [
  { sort: 'Afternoon', start: '13:00', slots: 18 },
  { sort: 'Twilight', start: '18:30', slots: 18 },
] as const;

const SAMPLE_SUPERVISORS = 12;
const QUARTER_HOUR_MS = 15 * 60 * 1000;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// Weekday dates (YYYY-MM-DD) counting back from endDate, newest first.
export function weekdaysBack(endDate: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${endDate}T12:00:00Z`);
  while (out.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

export function fakeNights(db: DatabaseSync, opts: FakeOptions): { shifts: number; entries: number } {
  const offset = opts.offset ?? '-07:00';
  const dates = weekdaysBack(opts.endDate, opts.nights ?? 1);

  const settings: Record<string, number> = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
    settings[r.key] = Number(r.value);
  }
  const lines = db
    .prepare('SELECT id, type, grp, expected_pph_override AS ov FROM line WHERE active = 1 ORDER BY type DESC, number')
    .all() as { id: string; type: string; grp: string; ov: number | null }[];
  if (lines.length === 0) throw new Error('No lines found. Run the seed first (npm run db:seed).');

  const insSup = db.prepare('INSERT OR IGNORE INTO supervisor (full_name, pin_hash, role) VALUES (?, ?, ?)');
  for (let i = 1; i <= SAMPLE_SUPERVISORS; i += 1) {
    insSup.run(`Sample Supervisor ${String(i).padStart(2, '0')}`, 'fake-not-a-real-hash', i <= 4 ? 'full_time' : 'part_time');
  }
  const sups = db
    .prepare("SELECT id FROM supervisor WHERE full_name LIKE 'Sample Supervisor %' ORDER BY full_name")
    .all() as { id: number }[];

  const delShift = db.prepare('DELETE FROM shift WHERE date = ? AND sort = ?');
  const insShift = db.prepare('INSERT INTO shift (date, sort, status) VALUES (?, ?, ?)');
  const insAssign = db.prepare('INSERT INTO assignment (shift_id, line_id, supervisor_id, started_at) VALUES (?, ?, ?, ?)');
  const insEntry = db.prepare(
    'INSERT INTO entry (shift_id, line_id, supervisor_id, slot, kind, headcount, running_volume, total_hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const closeShift = db.prepare('UPDATE shift SET starts_at = ?, ends_at = ?, status = ? WHERE id = ?');

  let shifts = 0;
  let entries = 0;

  db.exec('BEGIN');
  try {
    dates.forEach((date, nightIndex) => {
      SORTS.forEach((spec, sortIndex) => {
        const rng = mulberry32(hashString(`${date}|${spec.sort}`));
        const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
        const startMs = Date.parse(`${date}T${spec.start}:00${offset}`);

        delShift.run(date, spec.sort);
        const shiftId = Number(insShift.run(date, spec.sort, 'open').lastInsertRowid);
        let lastFinalMs = startMs;

        lines.forEach((line, lineIndex) => {
          const supId = sups[(lineIndex + sortIndex * 5 + nightIndex) % sups.length].id;
          const expected = line.ov ?? settings[`expected_pph.${line.grp}`];
          const targetPph = expected * clamp(0.95 + 0.15 * gauss(), 0.6, 1.3);
          const baseHead = line.type === 'PS' ? 6 + Math.floor(rng() * 7) : 3 + Math.floor(rng() * 7);

          insAssign.run(shiftId, line.id, supId, new Date(startMs + QUARTER_HOUR_MS).toISOString());

          let running = 0;
          let head = baseHead;
          for (let k = 1; k <= spec.slots; k += 1) {
            const at = startMs + k * QUARTER_HOUR_MS;
            head = Math.max(1, baseHead + Math.floor(rng() * 3) - 1);
            running += Math.round(head * 0.25 * targetPph * (0.85 + 0.3 * rng()));
            const missed = k !== 1 && k !== spec.slots && rng() < 0.08;
            if (missed) continue;
            const createdAt = new Date(at + Math.floor(rng() * 90) * 1000).toISOString();
            insEntry.run(shiftId, line.id, supId, Math.floor(at / QUARTER_HOUR_MS), 'interval', head, running, null, createdAt);
            entries += 1;
          }
          const finalMs = startMs + (spec.slots * 15 + 5 + Math.floor(rng() * 10)) * 60 * 1000;
          lastFinalMs = Math.max(lastFinalMs, finalMs);
          insEntry.run(shiftId, line.id, supId, null, 'final', head, running, null, new Date(finalMs).toISOString());
          entries += 1;
        });

        closeShift.run(new Date(startMs).toISOString(), new Date(lastFinalMs).toISOString(), 'final', shiftId);
        shifts += 1;
      });
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { shifts, entries };
}
