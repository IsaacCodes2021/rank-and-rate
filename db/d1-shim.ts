// A stand-in for Cloudflare D1 backed by local SQLite, for tests and local scripts.
// It covers the part of the D1 API the app uses: prepare, bind, first, all, run and batch.
import type { DatabaseSync } from 'node:sqlite';

type Param = string | number | bigint | null;

function toParam(v: unknown): Param {
  if (v === undefined) throw new Error('D1 refuses undefined bind values');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as Param;
}

type ShimStatement = {
  sql: string;
  bind: (...values: unknown[]) => ShimStatement;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results: T[]; success: true; meta: object }>;
  run: () => Promise<{ success: true; meta: { changes: number; last_row_id: number } }>;
};

export function d1Shim(db: DatabaseSync): D1Database {
  const make = (sql: string, params: Param[] = []): ShimStatement => ({
    sql,
    bind: (...values) => make(sql, values.map(toParam)),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...params) as T[], success: true as const, meta: {} }),
    run: async () => {
      const r = db.prepare(sql).run(...params);
      return { success: true as const, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });

  const shim = {
    prepare: (sql: string) => make(sql),
    // D1 runs a batch as one transaction: all of it happens, or none of it.
    batch: async (statements: ShimStatement[]) => {
      db.exec('BEGIN');
      try {
        const out = [];
        // A read in a batch hands back its rows, as it does on D1.
        for (const s of statements) out.push(db.prepare(s.sql).columns().length > 0 ? await s.all() : await s.run());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return shim as unknown as D1Database;
}
