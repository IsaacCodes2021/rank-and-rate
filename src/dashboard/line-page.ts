// One line's history on one sort (D125): its totals for a period, its PPH night by night, and a row
// per night (D028, D072, D105). It takes its rows as plain data, so the same page can later show real nights.
import { html, raw } from 'hono/html';
import { summarize } from '../scoring/index.ts';
import type { DateRange } from '../scoring/periods.ts';
import type { LineNightRow } from '../scoring/results.ts';
import { layout } from '../entry/pages.ts';
import { count, longDay, oneDecimal, shortDay } from '../format.ts';
import { CHART_SCRIPT, chartLegend, chartPlot, type ChartInput } from './chart.ts';
import { filterBar, type PeriodChoice } from './filters.ts';
import { DASHBOARD_STYLE } from './live-page.ts';

const orDash = (n: number | null, show: (v: number) => string = count) => (n === null ? '-' : show(n));
export const overPlan = (hours: number | null) => {
  if (hours === null) return '-';
  return Math.abs(hours) < 0.05 ? 'on plan' : `${oneDecimal(Math.abs(hours))} ${hours > 0 ? 'over' : 'under'}`;
};

const STYLE = raw(`<style>
  .swatch.Afternoon { background: #1baf7a; }
  .swatch.Morning { background: #b45309; }
  .swatch.Twilight { background: #6250d6; }
  .swatch.dash { height: 0; border-radius: 0; background: none; border-top: 2px dashed var(--ink-2); }
  .chart-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 8px 16px; margin-bottom: 8px; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 14px; color: var(--ink-2); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .plot { position: relative; }
  .plot svg { display: block; width: 100%; height: auto; touch-action: pan-y; }
  .plot svg:focus { outline: 3px solid #0a58ca; outline-offset: 2px; }
  .plot .phone { display: none; max-width: 560px; margin: 0 auto; }
  .tip { position: absolute; top: 4px; z-index: 2; min-width: 160px; padding: 8px 10px; background: #fff; border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 2px 10px rgba(11,11,11,.12); font-size: 13px; pointer-events: none; }
  .tip b { display: block; margin-bottom: 4px; font-size: 13px; }
  .tip div { display: flex; align-items: center; gap: 6px; color: var(--ink-2); }
  .tip strong { color: var(--ink); font-variant-numeric: tabular-nums; }
  .history { margin-top: 16px; }
  .history .note { margin: 0 0 8px; font-size: 14px; color: var(--ink-2); }
  @media (max-width: 820px) {
    .plot .desk { display: none; }
    .plot .phone { display: block; }
  }
  @media (max-width: 720px) {
    .history tr { grid-template-columns: 64px 64px 1fr; }
  }
</style>`);

const SORT_COLORS: Record<string, string> = { Afternoon: '#1baf7a', Morning: '#b45309', Twilight: '#6250d6' };

function chartFor(rows: LineNightRow[], sort: string, expectedPph: number): ChartInput | null {
  if (rows.length === 0) return null;
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const valueOn = (date: string) => rows.find((r) => r.date === date)?.pph ?? null;
  const mondays = dates.map((d, i) => ({ d, i })).filter(({ d }) => new Date(`${d}T12:00:00Z`).getUTCDay() === 1);
  const ticks = mondays.map(({ d, i }, position) => ({ x: i, label: shortDay(d), phone: position % 2 === 0 }));
  return {
    xs: dates.map((_, i) => i),
    xMin: 0,
    xMax: Math.max(dates.length - 1, 1),
    ticks: ticks.length ? ticks : [{ x: 0, label: shortDay(dates[0]), phone: true }],
    tips: dates.map(longDay),
    series: [{ name: sort, swatch: sort, color: SORT_COLORS[sort], values: dates.map(valueOn) }],
    reference: expectedPph,
    summary: `Line chart of ${sort} PPH each night from ${longDay(dates[0])} to ${longDay(dates[dates.length - 1])}, against an expected ${count(expectedPph)}.`,
  };
}

export type LinePageInput = {
  line: { id: string; type: string; group: string; expectedPph: number };
  rows: LineNightRow[]; // already limited to the sort and the period, newest first
  sort: string;
  sorts: readonly string[];
  period: PeriodChoice;
  range: DateRange;
  today: string;
  basePath: string; // where this line's page lives, for the filters
  backHref: string;
  backText?: string;
  above?: unknown;
};

export function linePage({ line, rows, sort, sorts, period, range, basePath, backHref, backText = 'All areas', above = '' }: LinePageInput) {
  const totals = summarize(rows.map((r) => ({ hours: r.hours, volume: r.volume, expectedPph: line.expectedPph })));
  const input = chartFor(rows, sort, line.expectedPph);
  const kind = line.type === 'PS' ? 'Unload' : `Load, ${line.group}`;
  const title = `${line.id} history`;

  return layout(
    title,
    html`${DASHBOARD_STYLE}${STYLE}<main class="wide">
<div class="top"><p class="eyebrow">Rank and Rate · Line history</p><div class="links"><a class="link" href="${backHref}">${backText}</a></div></div>
${above}
<div class="heading"><h1>${line.id}</h1><p class="sub">${kind} · expected ${count(line.expectedPph)} PPH</p></div>
${filterBar({ basePath, sorts, sort, period, range })}
${
  rows.length === 0
    ? html`<div class="card" style="margin-top:16px"><h2>No ${sort} sorts in this period</h2><p class="sub">Try a longer period.</p></div>`
    : html`<section class="tiles" aria-label="Totals for this period">
<div class="card tile"><div class="label">PPH</div><div class="value">${orDash(totals.pph)}</div><div class="detail">Expected ${count(line.expectedPph)}${totals.effectiveness === null ? '' : html` · <strong>${count(totals.effectiveness)}% effective</strong>`}</div></div>
<div class="card tile"><div class="label">Volume</div><div class="value">${count(totals.volume)}</div><div class="detail">${rows.length} ${rows.length === 1 ? 'night' : 'nights'}</div></div>
<div class="card tile"><div class="label">Hours</div><div class="value">${oneDecimal(totals.hours)}</div><div class="detail">${totals.overUnder === null ? '' : Math.abs(totals.overUnder) < 0.05 ? 'On plan' : `${oneDecimal(Math.abs(totals.overUnder))} hrs ${totals.overUnder > 0 ? 'over' : 'under'} plan`}</div></div>
</section>
${
  input
    ? html`<section class="card" aria-label="PPH each night">
<div class="chart-head"><h2>PPH each night</h2>${chartLegend(input)}</div>
${chartPlot(input)}
</section>`
    : ''
}
<section class="card list history" aria-label="Each night">
<div class="list-head"><h2>Each night</h2><p class="sub">Newest first</p></div>
<table>
<thead><tr><th>Date</th><th class="hide-narrow">Supervisor</th><th class="num hide-narrow">Hours</th><th class="num hide-narrow">Volume</th><th class="num">PPH</th><th>Effective</th><th class="num hide-narrow">Over / under</th></tr></thead>
<tbody>${rows.map((r) => {
        const who = r.supervisors.join(', ');
        const extra = [who, `${oneDecimal(r.hours)} hrs`, `${count(r.volume)} pcs`, overPlan(r.overUnder) === 'on plan' ? 'on plan' : `${overPlan(r.overUnder)} plan`].filter(Boolean).join(' · ');
        return html`<tr data-night="${r.date}|${r.sort}">
<td class="line">${shortDay(r.date)}</td>
<td class="who hide-narrow">${who || '-'}</td>
<td class="num hide-narrow">${oneDecimal(r.hours)}</td>
<td class="num hide-narrow">${count(r.volume)}</td>
<td class="num"><strong>${orDash(r.pph)}</strong></td>
<td>${r.effectiveness === null ? '-' : `${count(r.effectiveness)}%`}</td>
<td class="num hide-narrow">${overPlan(r.overUnder)}</td>
<td class="more-cell">${extra}</td>
</tr>`;
      })}</tbody>
</table>
</section>`
}
</main>
${CHART_SCRIPT}`,
  );
}
