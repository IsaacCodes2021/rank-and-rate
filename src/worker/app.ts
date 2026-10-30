import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { FAILURE_DELAY_MS, isLocked, recordFailure } from '../auth/limits.ts';
import { SESSION_SECONDS, readSession, sameSecret, signSession } from '../auth/session.ts';
import { ValidationError, saveNightTotals, type NightRow } from '../data/night.ts';

export type Env = {
  DB: D1Database;
  ADMIN_CODE?: string; // Cloudflare secret (D058, D108)
  SESSION_SECRET?: string; // Cloudflare secret that signs the session cookie
};

export type AppOptions = {
  now?: () => Date;
  failureDelayMs?: number;
};

export const ADMIN_COOKIE = 'rr_admin';
const MIN_ADMIN_CODE = 8;
const MIN_SESSION_SECRET = 32;

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

  // Every POST must be JSON. With the SameSite=Strict cookie this stops other sites from
  // submitting forms on the admin's behalf.
  app.use('/api/*', async (c, next) => {
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (c.req.method === 'POST' && !type.startsWith('application/json')) {
      return c.json({ ok: false, error: 'Send JSON.' }, 415);
    }
    await next();
  });

  const requireAdmin = createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const secret = c.env.SESSION_SECRET;
    const token = getCookie(c, ADMIN_COOKIE);
    const session = secret && token ? await readSession(token, secret, now().getTime()) : null;
    if (!session) return c.json({ ok: false, error: 'Sign in as admin first.' }, 401);
    await next();
  });

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

  return app;
}


