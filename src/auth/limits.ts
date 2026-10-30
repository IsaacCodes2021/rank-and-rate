// Slows down guessing of the admin code (and later the PINs): each wrong try waits a moment,
// and too many wrong tries in a short time lock that sign-in for a while (D107).

export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;
export const FAILURE_DELAY_MS = 1000;

const MINUTE = 60 * 1000;

export async function isLocked(db: D1Database, who: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - LOCK_MINUTES * MINUTE).toISOString();
  const row = await db
    .prepare('SELECT count(*) AS n FROM sign_in_failure WHERE who = ? AND at > ?')
    .bind(who, since)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_FAILURES;
}

export async function recordFailure(db: D1Database, who: string, now: Date): Promise<void> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * MINUTE).toISOString();
  await db.batch([
    db.prepare('INSERT INTO sign_in_failure (who, at) VALUES (?, ?)').bind(who, now.toISOString()),
    db.prepare('DELETE FROM sign_in_failure WHERE at < ?').bind(dayAgo),
  ]);
}
