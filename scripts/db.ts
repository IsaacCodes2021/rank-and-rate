// Local database commands:
//   npm run db:init                         create the tables
//   npm run db:seed                         init + load the 27 lines and expected PPH (safe to repeat)
//   npm run db:fake -- --date=2026-10-26    seed + fill an Afternoon and a Twilight sort for every line
//                                           (--nights=5 makes five weekday nights counting back)
//   npm run db:reset                        delete the local database and seed it again
// The file lives in .local/ (not committed); set RANK_DB to use another path.
import { rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fakeNights } from '../db/fake-nights.ts';
import { migrate, openDb, seed } from '../db/lib.ts';

const [command, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
for (const arg of rest) {
  if (!arg.startsWith('--')) continue;
  const [key, value] = arg.slice(2).split('=');
  flags[key] = value ?? 'true';
}

const path = process.env.RANK_DB ?? '.local/rank-and-rate.db';

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function todayPacific(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function summary(db: DatabaseSync): string {
  return ['line', 'supervisor', 'shift', 'entry'].map((t) => `${t}: ${count(db, t)}`).join(', ');
}

if (command === 'reset') {
  if (!resolve(path).startsWith(resolve('.local') + sep)) {
    console.error(`Refusing to delete ${path}: reset only deletes files inside .local/`);
    process.exit(1);
  }
  rmSync(path, { force: true });
}

if (command === 'init' || command === 'seed' || command === 'fake' || command === 'reset') {
  const db = openDb(path);
  const applied = migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Tables already up to date');
  if (command !== 'init') {
    seed(db);
    console.log('Seed loaded');
  }
  if (command === 'fake') {
    const result = fakeNights(db, {
      endDate: flags.date ?? todayPacific(),
      nights: flags.nights ? Number(flags.nights) : 1,
      offset: flags.offset,
    });
    console.log(`Fake nights: ${result.shifts} sorts, ${result.entries} entries`);
  }
  console.log(`${path} -> ${summary(db)}`);
  db.close();
} else {
  console.error('Usage: node scripts/db.ts init | seed | fake [--date=YYYY-MM-DD] [--nights=N] | reset');
  process.exit(command ? 1 : 0);
}
