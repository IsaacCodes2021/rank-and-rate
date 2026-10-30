import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { secureHeaders } from 'hono/secure-headers';
import { FAILURE_DELAY_MS, isLocked, recordFailure } from '../auth/limits.ts';
import { SESSION_SECONDS, readSession, sameSecret, signSession } from '../auth/session.ts';
import { hashAddress, hashPin, isValidPin, newSessionToken, sessionIdOf } from '../auth/supervisor.ts';
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
  type SupervisorInfo,
  type SupervisorLogin,
} from '../data/supervisor.ts';
import { livePage, livePanel } from '../dashboard/live-page.ts';
import { loadLiveSort, recentSorts } from '../data/live.ts';
import { lastLines, myShift, myShifts, saveFinals, saveUpdates, setShiftLines, startShift } from '../data/shift.ts';
import { isSampleSort, sampleLine, sampleOverview } from '../sample/pages.ts';
import { nightPage, signInPage, supervisorSignInPage, supervisorSignUpPage, supervisorsPage } from '../entry/pages.ts';
import { finalPage, shiftDonePage, sortsPage, startShiftPage, updatePage } from '../entry/shift-pages.ts';

export type Env = {
  DB: D1Database;
  ADMIN_CODE?: string; // Cloudflare secret (D058, D109)
  SESSION_SECRET?: string; // Cloudflare secret that signs the session cookie
  PIN_SALT?: string; // Cloudflare secret that keys the hash of supervisor ID numbers (D058, D111)
  SIGNUP_CODE?: string; // Cloudflare secret the admin hands out; sign-up stays closed without it (D113)
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
const MIN_SIGNUP_CODE = 4;
const LIVE_CACHE_MS = 20_000;
const WRONG_SIGN_IN = 'That name and ID number do not match.'; // the same whichever one was wrong

// Sign-up is open only when both secrets are set and long enough.
function signUpSecrets(env: Env) {
  const { SIGNUP_CODE: code, PIN_SALT: salt } = env;
  return code && code.length >= MIN_SIGNUP_CODE && salt && salt.length >= MIN_PIN_SALT ? { code, salt } : null;
}

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

  // Signs a supervisor in on this phone for 12 hours (D083); answers with when that ends.
  const signInAs = async (c: Context<{ Bindings: Env }>, supervisor: SupervisorLogin, at: Date) => {
    const token = newSessionToken();
    const expiresAt = new Date(at.getTime() + SESSION_SECONDS * 1000);
    await startSession(c.env.DB, await sessionIdOf(token), supervisor, expiresAt, at);
    setCookie(c, SUPERVISOR_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_SECONDS });
    return expiresAt.toISOString();
  };

  app.get('/', (c) => c.redirect('/live'));

  // The live sort view, open to anyone with the link (D027, D035). Every viewer polls, so a copy
  // is kept in this Worker for LIVE_CACHE_MS and the database is read at most that often (D120).
  const liveCache = new Map<string, { at: number; panel: string }>();
  const livePanelFor = async (db: D1Database, id: number | null): Promise<string | null> => {
    const key = id === null ? 'current' : String(id);
    const at = now();
    const cached = liveCache.get(key);
    if (cached && at.getTime() - cached.at < LIVE_CACHE_MS) return cached.panel;
    const { open, latestFinished } = await recentSorts(db, pacificDate(at));
    const pickedId = id ?? open[0]?.id ?? latestFinished?.id ?? null;
    const sort = pickedId === null ? null : await loadLiveSort(db, pickedId);
    if (id !== null && !sort) return null;
    const panel = String(await livePanel({ sort, open, latestFinished, following: id === null, now: at }));
    if (liveCache.size > 50) liveCache.clear();
    liveCache.set(key, { at: at.getTime(), panel });
    return panel;
  };
  const liveResponse = async (c: Context<{ Bindings: Env }>, panel: string | null) => {
    c.header('Cache-Control', 'no-store');
    if (panel === null) return c.redirect('/live');
    return c.html(c.req.query('panel') === undefined ? livePage(panel) : panel);
  };
  app.get('/live', async (c) => liveResponse(c, await livePanelFor(c.env.DB, null)));
  app.get('/live/:id{[0-9]+}', async (c) => liveResponse(c, await livePanelFor(c.env.DB, Number(c.req.param('id')))));

  // Made-up numbers to show people the site, on the real screens (D121). None of this touches
  // the database. A page never changes during a day, so each is kept once made.
  const samplePages = new Map<string, string>();
  const sampleResponse = async (c: Context<{ Bindings: Env }>, today: string, make: () => Promise<string | null>) => {
    c.header('Cache-Control', 'no-store');
    const key = `${today}|${c.req.url}`;
    const page = samplePages.get(key) ?? (await make());
    if (page === null) return c.redirect('/sample');
    if (samplePages.size > 300) samplePages.clear();
    samplePages.set(key, page);
    return c.html(page);
  };
  app.get('/sample', (c) => {
    const today = pacificDate(now());
    return sampleResponse(c, today, () => sampleOverview(today, c.req.query('at')));
  });
  app.get('/sample/sort/:sort', (c) => {
    const sort = c.req.param('sort');
    const today = pacificDate(now());
    return sampleResponse(c, today, async () => (isSampleSort(sort) ? sampleOverview(today, c.req.query('at'), sort) : null));
  });
  app.get('/sample/:line', (c) => {
    const today = pacificDate(now());
    return sampleResponse(c, today, () => sampleLine(today, c.req.param('line'), { period: c.req.query('period'), from: c.req.query('from'), to: c.req.query('to') }));
  });

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
    if (await supervisorOf(c)) return c.redirect('/shift');
    return c.html(supervisorSignInPage());
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

    return c.json({ ok: true, expiresAt: await signInAs(c, supervisor, at) });
  });

  // A supervisor creates their own account (D112) with the code the admin hands out (D113).
  app.get('/sign-up', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (await supervisorOf(c)) return c.redirect('/sign-in');
    return c.html(supervisorSignUpPage({ open: signUpSecrets(c.env) !== null }));
  });

  app.post('/api/supervisor/sign-up', async (c) => {
    const secrets = signUpSecrets(c.env);
    if (!secrets) return c.json({ ok: false, errors: [{ lineId: null, message: 'Sign-up is not open yet.' }] }, 503);
    const body = await c.req.json<{ code?: unknown; name?: unknown; pin?: unknown; role?: unknown }>().catch(() => null);
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const at = now();

    // Wrong codes and refusals are slowed and limited, so nobody can guess the code or use the
    // form to test which ID numbers are in use.
    const who = `signup:${await hashAddress(c.req.header('cf-connecting-ip') ?? 'unknown', secrets.salt)}`;
    if (await isLocked(c.env.DB, who, at)) {
      return c.json({ ok: false, errors: [{ lineId: null, message: 'Too many tries. Try again in 15 minutes.' }] }, 429);
    }
    const refuse = async (status: 400 | 401, errors: { lineId: string | null; message: string }[]) => {
      await recordFailure(c.env.DB, who, at);
      await sleep(failureDelayMs);
      return c.json({ ok: false, errors }, status);
    };

    if (!(await sameSecret(text(body?.code), secrets.code))) return refuse(401, [{ lineId: null, message: 'Wrong sign-up code.' }]);
    const pin = text(body?.pin);
    if (!isValidPin(pin)) return refuse(400, [{ lineId: null, message: 'The ID number must be 4 to 12 digits.' }]);
    const name = normalizeName(text(body?.name));
    try {
      await addSupervisor(c.env.DB, { name, role: text(body?.role), pinHash: await hashPin(pin, secrets.salt), actor: name }, at);
    } catch (err) {
      if (err instanceof ValidationError) return refuse(400, err.errors);
      throw err;
    }
    const supervisor = await findActiveSupervisor(c.env.DB, name);
    return c.json({ ok: true, expiresAt: await signInAs(c, supervisor!, at) });
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

  // The supervisor's night (D032, D005): start shift, 15-minute updates, final update.
  // A supervisor can have several sorts open. Each has its own screens and they never mix (D115).
  app.get('/shift', async (c) => {
    c.header('Cache-Control', 'no-store');
    const who = await supervisorOf(c);
    if (!who) return c.redirect('/sign-in');
    const shifts = await myShifts(c.env.DB, who.id, now());
    const open = shifts.filter((s) => !s.finished);
    if (open.length > 1) return c.html(sortsPage({ name: who.name, shifts: open }));
    if (open.length === 1) return c.redirect(`/shift/${open[0].id}`);
    // Nothing open: they are here for their next sort, with any finished one a tap away.
    return c.html(startShiftPage({ name: who.name, lines: await listActiveLines(c.env.DB), ticked: await lastLines(c.env.DB, who.id), finished: shifts }));
  });

  app.get('/shift/start', async (c) => {
    c.header('Cache-Control', 'no-store');
    const who = await supervisorOf(c);
    if (!who) return c.redirect('/sign-in');
    return c.html(startShiftPage({ name: who.name, lines: await listActiveLines(c.env.DB), ticked: await lastLines(c.env.DB, who.id), canGoBack: true }));
  });

  app.get('/shift/:id{[0-9]+}', async (c) => {
    c.header('Cache-Control', 'no-store');
    const who = await supervisorOf(c);
    if (!who) return c.redirect('/sign-in');
    const at = now();
    const shifts = await myShifts(c.env.DB, who.id, at);
    const shift = shifts.find((s) => s.id === Number(c.req.param('id')));
    if (!shift) return c.redirect('/shift');
    const others = shifts.filter((s) => s.id !== shift.id && !s.finished);
    if (shift.finished) return c.html(shiftDonePage({ name: who.name, shift, others }));
    return c.html(updatePage({ name: who.name, shift, others, now: at, justSaved: c.req.query('saved') !== undefined }));
  });

  app.get('/shift/:id{[0-9]+}/lines', async (c) => {
    c.header('Cache-Control', 'no-store');
    const who = await supervisorOf(c);
    if (!who) return c.redirect('/sign-in');
    const shift = await myShift(c.env.DB, who.id, Number(c.req.param('id')), now());
    if (!shift) return c.redirect('/shift');
    return c.html(startShiftPage({ name: who.name, lines: await listActiveLines(c.env.DB), current: shift, canGoBack: true }));
  });

  app.get('/shift/:id{[0-9]+}/final', async (c) => {
    c.header('Cache-Control', 'no-store');
    const who = await supervisorOf(c);
    if (!who) return c.redirect('/sign-in');
    const shift = await myShift(c.env.DB, who.id, Number(c.req.param('id')), now());
    if (!shift) return c.redirect('/shift');
    return c.html(finalPage({ name: who.name, shift }));
  });

  // A supervisor's save: sign-in checked, JSON read, and a refused save answered with its errors.
  const supervisorPost = (path: string, save: (who: SupervisorInfo, body: Record<string, unknown>, at: Date, db: D1Database) => Promise<object | void>) =>
    app.post(path, async (c) => {
      const who = await supervisorOf(c);
      if (!who) return c.json({ ok: false, error: 'Sign in first.' }, 401);
      const parsed: unknown = await c.req.json().catch(() => null);
      const body = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
      try {
        return c.json({ ok: true, ...(await save(who, body, now(), c.env.DB)) });
      } catch (err) {
        if (err instanceof ValidationError) return c.json({ ok: false, errors: err.errors }, 400);
        throw err;
      }
    });

  // A form row as sent by the browser; anything odd becomes a blank or a value the save refuses.
  const rowsOf = (body: Record<string, unknown>) =>
    (Array.isArray(body.rows) ? body.rows : []).map((raw: unknown) => {
      const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const field = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? v : null);
      return { lineId: typeof r.lineId === 'string' ? r.lineId : '', headcount: field(r.headcount), volume: field(r.volume) };
    });

  // The sort a save is for is always the one on the screen it came from, never a guess (D115).
  const shiftIdOf = (body: Record<string, unknown>) => (typeof body.shiftId === 'number' ? body.shiftId : Number.NaN);

  supervisorPost('/api/supervisor/shift', (who, body, at, db) =>
    startShift(db, who, { sort: typeof body.sort === 'string' ? body.sort : '', lineIds: body.lines, today: pacificDate(at) }, at),
  );
  supervisorPost('/api/supervisor/shift/lines', (who, body, at, db) => setShiftLines(db, who, shiftIdOf(body), body.lines, at));
  supervisorPost('/api/supervisor/update', (who, body, at, db) => saveUpdates(db, who, shiftIdOf(body), rowsOf(body), at));
  supervisorPost('/api/supervisor/final', (who, body, at, db) => saveFinals(db, who, shiftIdOf(body), rowsOf(body), at));

  return app;
}


