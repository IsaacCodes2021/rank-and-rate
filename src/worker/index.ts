import { Hono } from 'hono';

export type Env = {
  DB: D1Database;
};

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

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

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

  return app;
}

export default createApp();
