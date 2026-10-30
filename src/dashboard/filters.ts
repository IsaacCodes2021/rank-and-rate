// The filters shared by the results page and a line's history: one sort at a time (D125) and a
// period or date range (D072). Each one keeps what the other has picked.
import { html, raw } from 'hono/html';
import { isRealDate } from '../data/night.ts';
import { PERIODS, isPeriodKey, periodRange, type DateRange, type PeriodKey } from '../scoring/periods.ts';

export type PeriodChoice = PeriodKey | 'latest' | 'custom';
export type FilterQuery = { sort?: string; period?: string; from?: string; to?: string };

export const pickSort = <T extends string>(sorts: readonly T[], wanted: string | undefined): T | undefined => sorts.find((s) => s.toLowerCase() === wanted?.toLowerCase()) ?? sorts[0];

// Which dates to show: a custom range if one is given, else a named period. Pages that pass `latest`
// open on the latest night; the rest open on all time.
export function readPeriod(today: string, query: FilterQuery, latest?: string | null): { period: PeriodChoice; range: DateRange } {
  const from = query.from && isRealDate(query.from) ? query.from : null;
  const to = query.to && isRealDate(query.to) ? query.to : null;
  if (from || to) {
    const swapped = from && to && from > to;
    return { period: 'custom', range: { from: swapped ? to : from, to: swapped ? from : to } };
  }
  if (query.period && isPeriodKey(query.period)) return { period: query.period, range: periodRange(query.period, today) };
  if (latest === undefined) return { period: 'all-time', range: periodRange('all-time', today) };
  return { period: 'latest', range: { from: latest, to: latest } };
}

export type FilterBarInput = {
  basePath: string;
  sorts: readonly string[];
  sort: string;
  period: PeriodChoice;
  range: DateRange;
  withLatest?: boolean;
};

export function filterBar({ basePath, sorts, sort, period, range, withLatest = false }: FilterBarInput) {
  const sortKey = sort.toLowerCase();
  const hrefFor = (query: Record<string, string>) => `${basePath}?${new URLSearchParams(query)}`;
  const periodQuery: Record<string, string> = period === 'custom' ? { ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) } : { period };
  const sortLink = (s: string) => html`<a href="${hrefFor({ sort: s.toLowerCase(), ...periodQuery })}"${s === sort ? raw(' aria-current="true"') : ''}>${s}</a>`;
  const periodLink = (key: PeriodChoice, label: string) => html`<a href="${hrefFor({ sort: sortKey, period: key })}"${period === key ? raw(' aria-current="page"') : ''}>${label}</a>`;
  return html`<nav class="sorts" aria-label="Sort">${sorts.map(sortLink)}</nav>
<div class="periods">
<nav class="sorts" aria-label="Period">${withLatest ? periodLink('latest', 'Latest night') : ''}${PERIODS.map((p) => periodLink(p.key, p.label))}</nav>
<form class="range" method="get" action="${basePath}">
<input type="hidden" name="sort" value="${sortKey}">
<div><label for="from">From</label><input id="from" name="from" type="date" value="${range.from ?? ''}"></div>
<div><label for="to">To</label><input id="to" name="to" type="date" value="${range.to ?? ''}"></div>
<button type="submit">Show</button>
</form>
</div>`;
}
