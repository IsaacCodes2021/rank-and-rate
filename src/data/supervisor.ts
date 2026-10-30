// Supervisors and their sign-in sessions (D053, D083, D111). Nothing here sees an ID number:
// it gets the keyed hash from src/auth/supervisor.ts, and the hash goes no further than the
// check at sign-in. Neither the number nor its hash is ever written to the audit log.
import { ValidationError } from './night.ts';

export const ROLES = ['part_time', 'full_time'] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (s: string): s is Role => (ROLES as readonly string[]).includes(s);

const MAX_NAME = 80;

export const normalizeName = (s: string) => s.trim().replace(/\s+/g, ' ');

export type SupervisorLogin = { id: number; full_name: string; pin_hash: string; role: Role };

// Names match whatever the capitals (the column is COLLATE NOCASE).
export async function findActiveSupervisor(db: D1Database, name: string): Promise<SupervisorLogin | null> {
  return db
    .prepare('SELECT id, full_name, pin_hash, role FROM supervisor WHERE full_name = ? AND active = 1')
    .bind(name)
    .first<SupervisorLogin>();
}

export type SupervisorInfo = { id: number; name: string; role: Role };

export async function listSupervisors(db: D1Database): Promise<SupervisorInfo[]> {
  const r = await db.prepare('SELECT id, full_name AS name, role FROM supervisor WHERE active = 1 ORDER BY full_name').all<SupervisorInfo>();
  return r.results;
}

export type NewSupervisor = { name: string; pinHash: string; role: string; actor: string };

export async function addSupervisor(db: D1Database, input: NewSupervisor, now: Date = new Date()): Promise<void> {
  const name = normalizeName(input.name);
  const errors: { lineId: null; message: string }[] = [];
  if (!name || name.length > MAX_NAME) errors.push({ lineId: null, message: `Enter a full name of up to ${MAX_NAME} characters.` });
  if (!isRole(input.role)) errors.push({ lineId: null, message: 'Pick part-time or full-time.' });
  // A removed supervisor keeps their name and number here, so neither can be reused by accident.
  if (await db.prepare('SELECT 1 FROM supervisor WHERE full_name = ?').bind(name).first()) {
    errors.push({ lineId: null, message: 'That name is already in use.' });
  }
  if (await db.prepare('SELECT 1 FROM supervisor WHERE pin_hash = ?').bind(input.pinHash).first()) {
    errors.push({ lineId: null, message: 'That ID number is already in use.' });
  }
  if (errors.length > 0) throw new ValidationError(errors);

  await db.batch([
    db.prepare('INSERT INTO supervisor (full_name, pin_hash, role) VALUES (?, ?, ?)').bind(name, input.pinHash, input.role),
    db
      .prepare('INSERT INTO audit_log (at, actor, action, after) VALUES (?, ?, ?, ?)')
      .bind(now.toISOString(), input.actor, 'added supervisor', JSON.stringify({ name, role: input.role })),
  ]);
}

// Starts a session and clears out expired ones while it is here.
export async function startSession(db: D1Database, sessionId: string, supervisor: SupervisorLogin, expiresAt: Date, now: Date): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM session WHERE expires_at <= ?').bind(now.toISOString()),
    db.prepare('INSERT INTO session (id, supervisor_id, expires_at) VALUES (?, ?, ?)').bind(sessionId, supervisor.id, expiresAt.toISOString()),
    db.prepare('INSERT INTO audit_log (at, actor, action) VALUES (?, ?, ?)').bind(now.toISOString(), supervisor.full_name, 'signed in'),
  ]);
}

// Who a session belongs to, if it has not expired and the supervisor is still active.
export async function getSessionSupervisor(db: D1Database, sessionId: string, now: Date): Promise<SupervisorInfo | null> {
  return db
    .prepare(
      `SELECT sup.id, sup.full_name AS name, sup.role
         FROM session s JOIN supervisor sup ON sup.id = s.supervisor_id
        WHERE s.id = ? AND s.expires_at > ? AND sup.active = 1`,
    )
    .bind(sessionId, now.toISOString())
    .first<SupervisorInfo>();
}

export async function endSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM session WHERE id = ?').bind(sessionId).run();
}
