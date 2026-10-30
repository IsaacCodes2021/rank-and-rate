// The sample pages (D121): the real screens with made-up numbers, to show people the site and to
// see how it behaves. Every page says the numbers are made up. Nothing here touches the database.
import { html, raw } from 'hono/html';
import { linePage } from '../dashboard/line-page.ts';
import { livePage, livePanel } from '../dashboard/live-page.ts';
import { isRealDate } from '../data/night.ts';
import { inRange, isPeriodKey, periodRange, type DateRange, type PeriodKey } from '../scoring/periods.ts';
import { DEFAULT_MOMENT, SAMPLE_LINES, SAMPLE_MOMENTS, SAMPLE_SORTS, isSampleTime, sampleLineHistory, sampleWorld, type SampleSort } from './world.ts';

const BANNER = raw('<p class="sample-banner" role="note"><strong>Sample data.</strong> These numbers and names are made up, and nothing here is saved.</p>');

export const isSampleSort = (s: string): s is 'afternoon' | 'twilight' => s === 'afternoon' || s === 'twilight';
const SORT_OF: Record<'afternoon' | 'twilight', SampleSort> = { afternoon: 'Afternoon', twilight: 'Twilight' };

// /sample: all areas at a moment in the night, in the real live view.
export async function sampleOverview(today: string, atQuery: string | undefined, sortPath?: 'afternoon' | 'twilight'): Promise<string> {
  const at = atQuery && isSampleTime(atQuery) ? atQuery : DEFAULT_MOMENT;
  const world = sampleWorld(today, at, sortPath ? SORT_OF[sortPath] : undefined);
  const panel = String(
    await livePanel({
      sort: world.sort,
      open: world.open,
      latestFinished: world.latestFinished,
      following: false,
      now: world.now,
      sortHref: (s) => `/sample/sort/${s.sort.toLowerCase()}?at=${at}`,
      lineHref: (id) => `/sample/${id.toLowerCase()}?sort=${world.sort!.sort.toLowerCase()}`, // a line opens on the sort being looked at
      refreshes: false,
    }),
  );
  const moments = html`<nav class="moments" aria-label="Moment in the night"><span>See the night at:</span>${SAMPLE_MOMENTS.map(
    (m) => html`<a href="/sample?at=${m.at}"${m.at === at ? raw(' aria-current="page"') : ''}>${m.label}</a>`,
  )}</nav>`;
  return String(await livePage(panel, { above: html`${BANNER}${moments}`, topLink: { href: '/live', text: 'Real site' }, title: 'Sample data', eyebrow: 'Rank and Rate · Sample data' }));
}

// Which dates a line's history covers: a custom range if one is given, else a named period, else all time.
function readRange(today: string, query: { period?: string; from?: string; to?: string }): { period: PeriodKey | 'custom'; range: DateRange; filter: DateRange } {
  const from = query.from && isRealDate(query.from) ? query.from : null;
  const to = query.to && isRealDate(query.to) ? query.to : null;
  if (from || to) {
    const swapped = from && to && from > to;
    const range = { from: swapped ? to : from, to: swapped ? from : to };
    return { period: 'custom', range, filter: range };
  }
  const period: PeriodKey = query.period && isPeriodKey(query.period) ? query.period : 'all-time';
  const filter = periodRange(period, today);
  return { period, range: filter, filter };
}

// /sample/ps3: one line's history on one sort, Afternoon unless another is picked (D125). Null for anything that is not one of the 27 lines.
export async function sampleLine(today: string, path: string, query: { sort?: string; period?: string; from?: string; to?: string }): Promise<string | null> {
  const line = SAMPLE_LINES.find((l) => l.id === path.toUpperCase());
  if (!line) return null;
  const { period, range, filter } = readRange(today, query);
  const sort = SAMPLE_SORTS.find((s) => s.toLowerCase() === query.sort?.toLowerCase()) ?? SAMPLE_SORTS[0];
  const rows = sampleLineHistory(line.id, today).filter((r) => r.sort === sort && inRange(r.date, filter));
  return String(
    await linePage({
      line,
      rows,
      sort,
      sorts: SAMPLE_SORTS,
      period,
      range,
      today,
      basePath: `/sample/${line.id.toLowerCase()}`,
      backHref: '/sample',
      above: BANNER,
    }),
  );
}
