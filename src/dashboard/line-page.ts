// One line's history: its totals for a period, its PPH night by night, and a row per sort (D028,
// D072, D105). It takes its rows as plain data, so the same page can later show real nights.
import { html, raw } from 'hono/html';
import type { LineNightRow } from '../sample/world.ts';
import { summarize } from '../scoring/index.ts';
import { PERIODS, type DateRange, type PeriodKey } from '../scoring/periods.ts';
import { layout } from '../entry/pages.ts';
import { count, longDay, oneDecimal, shortDay } from '../format.ts';
import { CHART_SCRIPT, chartLegend, chartPlot, type ChartInput } from './chart.ts';
import { DASHBOARD_STYLE } from './live-page.ts';

const orDash = (n: number | null, show: (v: number) => string = count) => (n === null ? '-' : show(n));
const overPlan = (hours: number | null) => {
  if (hours === null) return '-';
  return Math.abs(hours) < 0.05 ? 'on plan' : `${oneDecimal(Math.abs(hours))} ${hours > 0 ? 'over' : 'under'}`;
};

const STYLE = raw(`<style>
  .periods { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 16px; margin: 14px 0 0; }
  .periods .sorts { margin: 0; }
  .history { margin-top: 16px; }
  .history .note { margin: 0 0 8px; font-size: 14px; color: var(--ink-2); }
  @media (max-width: 720px) {
    .history tr { grid-template-columns: 56px 76px 52px 1fr; }
  }
</style>`);

function chartFor(rows: LineNightRow[], expectedPph: number): ChartInput | null {
  if (rows.length === 0) return null;
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const valueOn = (date: string, sort: string) => rows.find((r) => r.date === date && r.sort === sort)?.pph ?? null;
  const mondays = dates.map((d, i) => ({ d, i })).filter(({ d }) => new Date(`${d}T12:00:00Z`).getUTCDay() === 1);
  const ticks = mondays.map(({ d, i }, position) => ({ x: i, label: shortDay(d), phone: position % 2 === 0 }));
  const sorts = [
    { name: 'Afternoon', color: '#1baf7a' },
    { name: 'Twilight', color: '#6250d6' },
  ];
  return {
    xs: dates.map((_, i) => i),
    xMin: 0,
    xMax: Math.max(dates.length - 1, 1),
    ticks: ticks.length ? ticks : [{ x: 0, label: shortDay(dates[0]), phone: true }],
    tips: dates.map(longDay),
    series: sorts.map((s) => ({ name: s.name, swatch: s.name, color: s.color, values: dates.map((d) => valueOn(d, s.name)) })),
    reference: expectedPph,
    summary: `Line chart of PPH each night from ${longDay(dates[0])} to ${longDay(dates[dates.length - 1])}, by sort, against an expected ${count(expectedPph)}.`,
  };
}

export type LinePageInput = {
  line: { id: string; type: string; group: string; expectedPph: number };
  rows: LineNightRow[]; // already limited to the period, newest first
  period: PeriodKey | 'custom';
  range: DateRange;
  today: string;
  basePath: string; // where this line's page lives, for the filters
  backHref: string;
  above?: unknown;
};

export function linePage({ line, rows, period, range, basePath, backHref, above = '' }: LinePageInput) {
  const totals = summarize(rows.map((r) => ({ hours: r.hours, volume: r.volume, expectedPph: line.expectedPph })));
  const parts = rows.flatMap((r) => (r.onTimeParts ? [r.onTimeParts] : []));
  const due = parts.reduce((sum, p) => sum + p.due, 0);
  const onTime = due ? (parts.reduce((sum, p) => sum + p.hit, 0) / due) * 100 : null;
  const input = chartFor(rows, line.expectedPph);
  const kind = line.type === 'PS' ? 'Unload' : `Load, ${line.group}`;
  const title = `${line.id} history`;

  const periodLink = (key: PeriodKey, label: string) => html`<a href="${basePath}?period=${key}"${period === key ? raw(' aria-current="page"') : ''}>${label}</a>`;

  return layout(
    title,
    html`${DASHBOARD_STYLE}${STYLE}<main class="wide">
<div class="top"><p class="eyebrow">Rank and Rate · Line history</p><div class="links"><a class="link" href="${backHref}">All areas</a></div></div>
${above}
<div class="heading"><h1>${line.id}</h1><p class="sub">${kind} · expected ${count(line.expectedPph)} PPH</p></div>
<div class="periods">
<nav class="sorts" aria-label="Period">${PERIODS.map((p) => periodLink(p.key, p.label))}</nav>
<form class="range" method="get" action="${basePath}">
<div><label for="from">From</label><input id="from" name="from" type="date" value="${range.from ?? ''}"></div>
<div><label for="to">To</label><input id="to" name="to" type="date" value="${range.to ?? ''}"></div>
<button type="submit">Show</button>
</form>
</div>
${
  rows.length === 0
    ? html`<div class="card" style="margin-top:16px"><h2>No sorts in this period</h2><p class="sub">Try a longer period.</p></div>`
    : html`<section class="tiles" aria-label="Totals for this period">
<div class="card tile"><div class="label">PPH</div><div class="value">${orDash(totals.pph)}</div><div class="detail">Expected ${count(line.expectedPph)}${totals.effectiveness === null ? '' : html` · <strong>${count(totals.effectiveness)}% effective</strong>`}</div></div>
<div class="card tile"><div class="label">Volume</div><div class="value">${count(totals.volume)}</div><div class="detail">${rows.length} ${rows.length === 1 ? 'sort' : 'sorts'}</div></div>
<div class="card tile"><div class="label">Hours</div><div class="value">${oneDecimal(totals.hours)}</div><div class="detail">${totals.overUnder === null ? '' : Math.abs(totals.overUnder) < 0.05 ? 'On plan' : `${oneDecimal(Math.abs(totals.overUnder))} hrs ${totals.overUnder > 0 ? 'over' : 'under'} plan`}</div></div>
<div class="card tile"><div class="label">Updates on time</div><div class="value">${orDash(onTime)}${onTime === null ? '' : '%'}</div><div class="detail">${due ? `${count(parts.reduce((sum, p) => sum + p.hit, 0))} of ${count(due)} quarter hours` : ''}</div></div>
</section>
${
  input
    ? html`<section class="card" aria-label="PPH each night">
<div class="chart-head"><h2>PPH each night</h2>${chartLegend(input)}</div>
${chartPlot(input)}
</section>`
    : ''
}
<section class="card list history" aria-label="Each sort">
<div class="list-head"><h2>Each sort</h2><p class="sub">Newest first</p></div>
<table>
<thead><tr><th>Date</th><th>Sort</th><th class="num">PPH</th><th>Effective</th><th class="hide-narrow">Supervisor</th><th class="num hide-narrow">Hours</th><th class="num hide-narrow">Volume</th><th class="num hide-narrow">Over / under</th><th class="num hide-narrow">On time</th></tr></thead>
<tbody>${rows.map((r) => {
        const who = r.supervisors.join(', ');
        const extra = [who, `${oneDecimal(r.hours)} hrs`, `${count(r.volume)} pcs`, overPlan(r.overUnder) === 'on plan' ? 'on plan' : `${overPlan(r.overUnder)} plan`, r.onTime === null ? '' : `${count(r.onTime)}% on time`].filter(Boolean).join(' · ');
        return html`<tr data-night="${r.date}|${r.sort}">
<td class="line">${shortDay(r.date)}</td>
<td>${r.sort}</td>
<td class="num"><strong>${orDash(r.pph)}</strong></td>
<td>${r.effectiveness === null ? '-' : `${count(r.effectiveness)}%`}</td>
<td class="who hide-narrow">${who || '-'}</td>
<td class="num hide-narrow">${oneDecimal(r.hours)}</td>
<td class="num hide-narrow">${count(r.volume)}</td>
<td class="num hide-narrow">${overPlan(r.overUnder)}</td>
<td class="num hide-narrow">${r.onTime === null ? '-' : `${count(r.onTime)}%`}</td>
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
