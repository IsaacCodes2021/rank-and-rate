// Fake running sorts for working on the live view on the local site: an Afternoon sort taking its
// finals while a Twilight sort takes its first updates, on some of the same lines. Everything it
// makes is obviously fake, and the numbers come from a seeded generator, so the same minute always
// gives the same night. It returns SQL, which package.json only ever runs with --local.
import { quarterHourSlot, sortStartMs } from '../src/scoring/index.ts';

const QUARTER_MS = 15 * 60 * 1000;
const EXPECTED: Record<string, number> = { PS: 550, North: 275, Wings: 350 };
const NORTH = new Set([1, 2, 3, 4, 5, 14]);
const PS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14];
const PD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function generator(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const quote = (s: string) => `'${s}'`;

export function fakeLiveSql(nowMs: number, today: string): string {
  const random = generator(Math.floor(nowMs / 60000));
  const out: string[] = [];
  const shiftId = (sort: string) => `(SELECT id FROM shift WHERE date = ${quote(today)} AND sort = ${quote(sort)})`;

  for (const sort of ['Afternoon', 'Twilight']) {
    out.push(`DELETE FROM entry WHERE shift_id = ${shiftId(sort)};`, `DELETE FROM assignment WHERE shift_id = ${shiftId(sort)};`, `DELETE FROM shift WHERE date = ${quote(today)} AND sort = ${quote(sort)};`);
  }
  for (let i = 1; i <= 16; i += 1) {
    const n = String(i).padStart(2, '0');
    out.push(`INSERT OR IGNORE INTO supervisor (full_name, pin_hash, role) VALUES ('Sample Live ${n}', 'fake-live-not-a-real-hash-${n}', 'part_time');`);
  }
  const supervisor = (i: number) => `(SELECT id FROM supervisor WHERE full_name = 'Sample Live ${String((i % 16) + 1).padStart(2, '0')}')`;

  const nowSlot = quarterHourSlot(nowMs);

  const runSort = (sort: string, firstSlot: number, lines: { id: string; expected: number }[], options: (index: number) => { lastSlot: number; final: boolean }) => {
    const startMs = sortStartMs(firstSlot * QUARTER_MS);
    out.push(`INSERT INTO shift (date, sort, starts_at, status) VALUES (${quote(today)}, ${quote(sort)}, ${quote(iso(startMs))}, 'open');`);
    lines.forEach((line, index) => {
      const sup = supervisor(index + (sort === 'Twilight' ? 8 : 0));
      out.push(`INSERT INTO assignment (shift_id, line_id, supervisor_id, started_at) VALUES (${shiftId(sort)}, ${quote(line.id)}, ${sup}, ${quote(iso(startMs))});`);
      const { lastSlot, final } = options(index);
      const target = line.expected * (0.82 + random() * 0.36);
      const crew = 4 + Math.floor(random() * 6);
      let running = 0;
      for (let slot = firstSlot; slot <= lastSlot; slot += 1) {
        running += Math.round(crew * 0.25 * target * (0.9 + random() * 0.2));
        if (slot !== firstSlot && slot !== lastSlot && random() < 0.08) continue; // a skipped update
        const at = iso(slot * QUARTER_MS + Math.floor(random() * 120) * 1000);
        out.push(
          `INSERT INTO entry (shift_id, line_id, supervisor_id, slot, kind, headcount, running_volume, created_at) VALUES (${shiftId(sort)}, ${quote(line.id)}, ${sup}, ${slot}, 'interval', ${crew}, ${running}, ${quote(at)});`,
        );
      }
      if (final) {
        const at = iso((lastSlot + 1) * QUARTER_MS);
        out.push(`INSERT INTO entry (shift_id, line_id, supervisor_id, kind, running_volume, created_at) VALUES (${shiftId(sort)}, ${quote(line.id)}, ${sup}, 'final', ${running + 150}, ${quote(at)});`);
      }
    });
  };

  const expectedOf = (type: 'PS' | 'PD', n: number) => (type === 'PS' ? EXPECTED.PS : NORTH.has(n) ? EXPECTED.North : EXPECTED.Wings);
  const all = [
    ...PS.filter((n) => n !== 14).map((n) => ({ id: `PS${n}`, expected: expectedOf('PS', n) })), // PS14 has nobody on it
    ...PD.filter((n) => n !== 13).map((n) => ({ id: `PD${n}`, expected: expectedOf('PD', n) })), // PD13 neither
  ];
  // Started about four hours ago. Some lines have their final, two have gone quiet, the rest are current.
  runSort('Afternoon', nowSlot - 16, all, (i) => {
    if (i % 3 === 0) return { lastSlot: nowSlot - 2, final: true };
    if (i === 4 || i === 16) return { lastSlot: nowSlot - 4, final: false };
    return { lastSlot: nowSlot, final: false };
  });
  // Started half an hour ago, overlapping it on some of the same lines.
  runSort('Twilight', nowSlot - 1, all.filter((_, i) => i % 4 === 0), () => ({ lastSlot: nowSlot, final: false }));
  return `${out.join('\n')}\n`;
}
