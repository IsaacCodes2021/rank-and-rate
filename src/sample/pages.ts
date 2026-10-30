// The sample pages (D121): the real screens with made-up numbers, to show people the site and to
// see how it behaves. Every page says the numbers are made up. Nothing here touches the database.
import { html, raw } from 'hono/html';
import { pickSort, readPeriod, type FilterQuery } from '../dashboard/filters.ts';
import { linePage } from '../dashboard/line-page.ts';
import { livePage, livePanel } from '../dashboard/live-page.ts';
import { resultsPage } from '../dashboard/results-page.ts';
import { inRange } from '../scoring/periods.ts';
import { DEFAULT_MOMENT, SAMPLE_LINES, SAMPLE_MOMENTS, SAMPLE_SORTS, isSampleTime, sampleLatestNight, sampleLineHistory, sampleNightLines, sampleWorld, type SampleSort } from './world.ts';

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
      finished: world.finished,
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
  return String(await livePage(panel, { above: html`${BANNER}${moments}`, links: [{ href: '/sample/results', text: 'Results' }, { href: '/live', text: 'Real site' }], title: 'Sample data', eyebrow: 'Rank and Rate · Sample data' }));
}

// /sample/results: the results page with made-up numbers, opening on the latest finished night.
export async function sampleResults(today: string, query: FilterQuery): Promise<string> {
  const sort = pickSort(SAMPLE_SORTS, query.sort) as SampleSort;
  const { period, range } = readPeriod(today, query, sampleLatestNight(today));
  return String(
    await resultsPage({
      rows: sampleNightLines(today, sort, range),
      activeLines: SAMPLE_LINES.length,
      sorts: SAMPLE_SORTS,
      sort,
      period,
      range,
      basePath: '/sample/results',
      lineHref: (id) => `/sample/${id.toLowerCase()}?sort=${sort.toLowerCase()}`,
      links: [{ href: '/sample', text: 'All areas' }, { href: '/live', text: 'Real site' }],
      above: BANNER,
    }),
  );
}

// /sample/ps3: one line's history on one sort, Afternoon unless another is picked (D125). Null for anything that is not one of the 27 lines.
export async function sampleLine(today: string, path: string, query: FilterQuery): Promise<string | null> {
  const line = SAMPLE_LINES.find((l) => l.id === path.toUpperCase());
  if (!line) return null;
  const { period, range } = readPeriod(today, query);
  const sort = pickSort(SAMPLE_SORTS, query.sort) as SampleSort;
  const rows = sampleLineHistory(line.id, today).filter((r) => r.sort === sort && inRange(r.date, range));
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
