import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { secureHeaders } from 'hono/secure-headers';
import { FAILURE_DELAY_MS, isLocked, recordFailure } from '../auth/limits.ts';
import { SESSION_SECONDS, readSession, sameSecret, signSession } from '../auth/session.ts';
import { hashPin, isValidPin, newSessionToken, sessionIdOf } from '../auth/supervisor.ts';
import {
  ValidationError,
  getNightTotals,
  isRealDate,
  isSort,
  listActiveLines,
  saveNightTotals,
  type NightRow,
} from '../data/night.ts';
import {
  addSupervisor,
  endSession,
  findActiveSupervisor,
  getSessionSupervisor,
  listSupervisors,
  normalizeName,
  startSession,
} from '../data/supervisor.ts';
import { nightPage, signInPage, supervisorHomePage, supervisorSignInPage, supervisorsPage } from '../entry/pages.ts';

export type Env = {
  DB: D1Database;
  ADMIN_CODE?: string; // Cloudflare secret (D058, D109)
  SESSION_SECRET?: string; // Cloudflare secret that signs the session cookie
  PIN_SALT?: string; // Cloudflare secret that keys the hash of supervisor ID numbers (D058, D111)
};

export type AppOptions = {
  now?: () => Date;
  failureDelayMs?: number;
};

export const ADMIN_COOKIE = 'rr_admin';
export const SUPERVISOR_COOKIE = 'rr_supervisor';
const MIN_ADMIN_CODE = 4; // D109: short on purpose; the lockout in D107 limits guessing
const MIN_SESSION_SECRET = 32;
const MIN_PIN_SALT = 32;
const WRONG_SIGN_IN = 'That name and ID number do not match.'; // the same whichever one was wrong

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rank and Rate</title>
<style>
  body { margin: 0; padding: 24px 16px; font: 18px/1.5 system-ui, sans-serif; color: #111; background: #fff; }
  h1 { margin: 0 0 8px; font-size: 28px; }
  p { margin: 0; max-width: 32rem; }
</style>
</head>
<body>
<h1>Rank and Rate</h1>
<p>The site is being built. Dashboards and entry screens will appear here.</p>
</body>
</html>`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The building's local date (D049 sorts are local), as YYYY-MM-DD.
export const pacificDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

// A form row as sent by the browser; anything odd becomes a blank that saveNightTotals reports.
function toNightRow(raw: unknown): NightRow {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const field = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? (v as number) : null);
  return { lineId: typeof r.lineId === 'string' ? r.lineId : '', hours: field(r.hours), volume: field(r.volume) };
}

export function createApp(options: AppOptions = {}) {
  const now = options.now ?? (() => new Date());
  const failureDelayMs = options.failureDelayMs ?? FAILURE_DELAY_MS;
  const app = new Hono<{ Bindings: Env }>();

  app.onError((err, c) => {
    console.error(err);
    return c.json({ ok: false, error: 'Something went wrong.' }, 500);
  });

  // Stops other sites framing these pages, and similar browser protections.
  app.use('*', secureHeaders());

  // Every POST must be JSON. With the SameSite=Strict cookie this stops other sites from
  // submitting forms on the admin's behalf. Admin answers are never cached.
  app.use('/api/*', async (c, next) => {
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (c.req.method === 'POST' && !type.startsWith('application/json')) {
      return c.json({ ok: false, error: 'Send JSON.' }, 415);
    }
    await next();
  });
  const noStore = createMiddleware(async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('/api/admin/*', noStore);
  app.use('/api/supervisor/*', noStore);

  const isAdmin = async (c: Context<{ Bindings: Env }>) => {
    const secret = c.env.SESSION_SECRET;
    const token = getCookie(c, ADMIN_COOKIE);
    return Boolean(secret && token && (await readSession(token, secret, now().getTime())));
  };

  const requireAdmin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
    if (!(await isAdmin(c))) return c.json({ ok: false, error: 'Sign in as admin first.' }, 401);
    await next();
  });

  const supervisorOf = async (c: Context<{ Bindings: Env }>) => {
    const token = getCookie(c, SUPERVISOR_COOKIE);
    return token ? getSessionSupervisor(c.env.DB, await sessionIdOf(token), now()) : null;
  };

  app.get('/', (c) => c.html(PAGE));

  // Used by the uptime monitor (D098): 200 only when the database answers.
  app.get('/api/health', async (c) => {
    try {
      const row = await c.env.DB.prepare('SELECT count(*) AS lines FROM line').first<{ lines: number }>();
      return c.json({ ok: true, lines: row?.lines ?? 0 });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.post('/api/admin/sign-in', async (c) => {
    const { ADMIN_CODE, SESSION_SECRET } = c.env;
    if (!ADMIN_CODE || ADMIN_CODE.length < MIN_ADMIN_CODE || !SESSION_SECRET || SESSION_SECRET.length < MIN_SESSION_SECRET) {
      return c.json({ ok: false, error: 'Admin sign-in is not set up yet.' }, 503);
    }
    const body = await c.req.json<{ code?: unknown }>().catch(() => null);
    const code = typeof body?.code === 'string' ? body.code : '';
    const at = now();

    if (await isLocked(c.env.DB, 'admin', at)) {
      return c.json({ ok: false, error: 'Too many wrong codes. Try again in 15 minutes.' }, 429);
    }
    if (!(await sameSecret(code, ADMIN_CODE))) {
      await recordFailure(c.env.DB, 'admin', at);
      await sleep(failureDelayMs);
      return c.json({ ok: false, error: 'Wrong code.' }, 401);
    }

    const exp = Math.floor(at.getTime() / 1000) + SESSION_SECONDS;
    setCookie(c, ADMIN_COOKIE, await signSession({ role: 'admin', exp }, SESSION_SECRET), {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_SECONDS,
    });
    await c.env.DB.prepare('INSERT INTO audit_log (at, actor, action) VALUES (?, ?, ?)').bind(at.toISOString(), 'admin', 'signed in').run();
    return c.json({ ok: true, expiresAt: new Date(exp * 1000).toISOString() });
  });

  app.post('/api/admin/sign-out', (c) => {
    deleteCookie(c, ADMIN_COOKIE, { path: '/', secure: true });
    return c.json({ ok: true });
  });

  app.get('/api/admin/me', requireAdmin, (c) => c.json({ ok: true, role: 'admin' }));

  // The admin's phone screen: sign-in first, then the night totals (D056 key flow 2, D065).
  app.get('/admin', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!(await isAdmin(c))) return c.html(signInPage());
    return c.html(nightPage({ lines: await listActiveLines(c.env.DB), today: pacificDate(now()) }));
  });

  // What is already saved for a date and sort, so the screen can show it for correcting.
  app.get('/api/admin/night', requireAdmin, async (c) => {
    const date = c.req.query('date') ?? '';
    const sort = c.req.query('sort') ?? '';
    if (!isRealDate(date) || !isSort(sort)) {
      return c.json({ ok: false, errors: [{ lineId: null, message: 'Pick a real date and a sort.' }] }, 400);
    }
    return c.json({ ok: true, rows: await getNightTotals(c.env.DB, date, sort) });
  });

  // Isaac's end-of-night totals for the beta (D052, D065).
  app.post('/api/admin/night', requireAdmin, async (c) => {
    const body = await c.req.json<{ date?: unknown; sort?: unknown; rows?: unknown }>().catch(() => null);
    if (!body || !Array.isArray(body.rows)) {
      return c.json({ ok: false, errors: [{ lineId: null, message: 'Send a date, a sort and the rows.' }] }, 400);
    }
    try {
      const result = await saveNightTotals(
        c.env.DB,
        { date: String(body.date ?? ''), sort: String(body.sort ?? ''), rows: body.rows.map(toNightRow), actor: 'admin' },
        now(),
      );
      return c.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ ok: false, errors: err.errors }, 400);
      throw err;
    }
  });

  // The admin adds supervisors here. Changing or removing them comes with the admin screens (M4).
  app.get('/admin/supervisors', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!(await isAdmin(c))) return c.redirect('/admin');
    return c.html(supervisorsPage({ supervisors: await listSupervisors(c.env.DB) }));
  });

  app.post('/api/admin/supervisors', requireAdmin, async (c) => {
    const salt = c.env.PIN_SALT;
    if (!salt || salt.length < MIN_PIN_SALT) {
      return c.json({ ok: false, errors: [{ lineId: null, message: 'Supervisor sign-in is not set up yet.' }] }, 503);
    }
    const body = await c.req.json<{ name?: unknown; pin?: unknown; role?: unknown }>().catch(() => null);
    const pin = typeof body?.pin === 'string' ? body.pin.trim() : '';
    if (!isValidPin(pin)) {
      return c.json({ ok: false, errors: [{ lineId: null, message: 'The ID number must be 4 to 12 digits.' }] }, 400);
    }
    try {
      await addSupervisor(
        c.env.DB,
        {
          name: typeof body?.name === 'string' ? body.name : '',
          role: typeof body?.role === 'string' ? body.role : '',
          pinHash: await hashPin(pin, salt),
          actor: 'admin',
        },
        now(),
      );
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ ok: false, errors: err.errors }, 400);
      throw err;
    }
  });

  // Supervisor sign-in: full name and ID number once, then signed in for 12 hours (D083, D111).
  app.get('/sign-in', async (c) => {
    c.header('Cache-Control', 'no-store');
    const supervisor = await supervisorOf(c);
    return c.html(supervisor ? supervisorHomePage({ name: supervisor.name }) : supervisorSignInPage());
  });

  app.post('/api/supervisor/sign-in', async (c) => {
    const salt = c.env.PIN_SALT;
    if (!salt || salt.length < MIN_PIN_SALT) return c.json({ ok: false, error: 'Supervisor sign-in is not set up yet.' }, 503);
    const body = await c.req.json<{ name?: unknown; pin?: unknown }>().catch(() => null);
    const name = normalizeName(typeof body?.name === 'string' ? body.name : '');
    const pin = typeof body?.pin === 'string' ? body.pin.trim() : '';
    const at = now();

    // Failures count by the supervisor's row id, so a typed number is never stored (D111).
    const supervisor = await findActiveSupervisor(c.env.DB, name);
    const who = supervisor ? `supervisor:${supervisor.id}` : null;
    if (who && (await isLocked(c.env.DB, who, at))) {
      return c.json({ ok: false, error: 'Too many wrong tries. Try again in 15 minutes.' }, 429);
    }
    const right = supervisor !== null && isValidPin(pin) && (await sameSecret(await hashPin(pin, salt), supervisor.pin_hash));
    if (!right) {
      if (who) await recordFailure(c.env.DB, who, at);
      await sleep(failureDelayMs);
      return c.json({ ok: false, error: WRONG_SIGN_IN }, 401);
    }

    const token = newSessionToken();
    const expiresAt = new Date(at.getTime() + SESSION_SECONDS * 1000);
    await startSession(c.env.DB, await sessionIdOf(token), supervisor, expiresAt, at);
    setCookie(c, SUPERVISOR_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_SECONDS });
    return c.json({ ok: true, expiresAt: expiresAt.toISOString() });
  });

  app.post('/api/supervisor/sign-out', async (c) => {
    const token = getCookie(c, SUPERVISOR_COOKIE);
    if (token) await endSession(c.env.DB, await sessionIdOf(token));
    deleteCookie(c, SUPERVISOR_COOKIE, { path: '/', secure: true });
    return c.json({ ok: true });
  });

  app.get('/api/supervisor/me', async (c) => {
    const supervisor = await supervisorOf(c);
    if (!supervisor) return c.json({ ok: false, error: 'Sign in first.' }, 401);
    return c.json({ ok: true, name: supervisor.name, role: supervisor.role });
  });

  return app;
}


