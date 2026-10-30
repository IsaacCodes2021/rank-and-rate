// The live sort view (D027, D043): anyone with the link can watch a sort as it runs. The Worker
// renders it, chart included, as plain HTML and SVG with a small script that swaps in a fresh copy
// every 30 seconds (D119). Everything sits inside #panel, so a refresh is one replacement.
import { html, raw } from 'hono/html';
import type { LiveLine, LiveSort, SortRef } from '../data/live.ts';
import { quarterHourSlot } from '../scoring/index.ts';
import { runningSeries, sortSummary, type LineNumbers, type RunningPoint, type TypeTotals } from '../scoring/live.ts';
import { layout } from '../entry/pages.ts';
import { clock, clockOf, count, longDay, oneDecimal, shortClock } from '../format.ts';
import { CHART_SCRIPT, chartLegend, chartPlot, type ChartInput } from './chart.ts';

const QUARTER_MS = 15 * 60 * 1000;

const orDash = (n: number | null, show: (v: number) => string = count) => (n === null ? '-' : show(n));

export const DASHBOARD_STYLE = raw(`<style>
  :root { --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #6f6d68; --line: #e1e0d9; --line-2: #eeede8; --page: #f5f6f8; --card: #fff; --ps: #2a78d6; --pd: #eb6834; }
  body { background: var(--page); }
  main.wide { max-width: 1360px; padding: 20px 16px 40px; }
  .wide .top { align-items: flex-start; }
  .eyebrow { margin: 0 0 2px; font-size: 13px; font-weight: 600; color: var(--ink-2); }
  .wide h1 { margin: 0; font-size: 28px; }
  .wide h2 { margin: 0; font-size: 17px; }
  .wide .sub { margin: 4px 0 0; color: var(--ink-2); }
  .wide .link { font-size: 16px; }
  .sorts { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 0; }
  .sorts a { padding: 8px 14px; min-height: 40px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); color: var(--ink); font-size: 15px; font-weight: 600; text-decoration: none; }
  .sorts a[aria-current] { background: var(--ink); border-color: var(--ink); color: #fff; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin: 16px 0; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
  .tile { display: flex; flex-direction: column; gap: 4px; }
  .tile .label { font-size: 14px; font-weight: 600; color: var(--ink-2); display: flex; align-items: center; gap: 8px; }
  .tile .value { font-size: 32px; font-weight: 700; line-height: 1.15; }
  .tile .value small { font-size: 18px; font-weight: 500; color: var(--ink-2); }
  .tile .detail { font-size: 14px; color: var(--ink-2); }
  .tile .detail strong { color: var(--ink); }
  .swatch { display: inline-block; width: 18px; height: 3px; border-radius: 2px; flex: none; }
  .swatch.PS { background: var(--ps); }
  .swatch.PD { background: var(--pd); }
  .swatch.Afternoon { background: #1baf7a; }
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
  details { margin-top: 8px; font-size: 14px; }
  summary { min-height: 32px; color: #0a58ca; cursor: pointer; }
  .lists { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 16px; align-items: flex-start; }
  .list { flex: 1 1 560px; min-width: 0; }
  .list-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .list-head .sub { margin: 0; font-size: 14px; }
  .list-head h2 { display: flex; align-items: center; gap: 8px; }
  .wide table { margin-top: 8px; font-size: 14px; font-variant-numeric: tabular-nums; }
  .wide th { position: static; padding: 8px 6px; font-size: 12px; font-weight: 600; color: var(--ink-2); border-bottom: 1px solid var(--line); }
  .wide td { padding: 8px 6px; border-bottom: 1px solid var(--line-2); vertical-align: middle; }
  .wide tr:last-child td { border-bottom: 0; }
  .wide .num { text-align: right; }
  .wide td.line { width: auto; font-weight: 700; white-space: nowrap; }
  .who { color: var(--ink-2); overflow-wrap: anywhere; }
  .more-cell { display: none; }
  .eff { display: flex; align-items: center; gap: 8px; }
  .effbar { flex: none; width: 56px; height: 6px; border-radius: 3px; background: var(--line-2); overflow: hidden; }
  .effbar i { display: block; height: 100%; border-radius: 3px; }
  .PS .effbar i { background: var(--ps); }
  .PD .effbar i { background: var(--pd); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .pill.late { background: #fdecec; color: #a11616; }
  .pill.final { background: #eef0f3; color: var(--ink-2); }
  .idle { color: var(--ink-3); }
  .wide td.line a { color: inherit; }
  .sample-banner { margin: 0 0 12px; padding: 10px 14px; border: 2px solid #8a5a00; border-radius: 8px; background: #fff6e0; font-size: 15px; }
  .moments { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 12px; font-size: 14px; color: var(--ink-2); }
  .moments a { padding: 6px 12px; min-height: 36px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); color: var(--ink); font-weight: 600; text-decoration: none; }
  .moments a[aria-current] { background: var(--ink); border-color: var(--ink); color: #fff; }
  .range { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; margin: 0; }
  .range label { margin: 0; font-size: 13px; font-weight: 400; color: var(--ink-2); }
  .range input { width: auto; min-height: 40px; padding: 4px 8px; font-size: 15px; }
  .range button { min-height: 40px; padding: 0 14px; font-size: 15px; }
  .foot { margin: 16px 0 0; font-size: 13px; color: var(--ink-2); }
  .notice { margin: 12px 0 0; padding: 10px; border: 2px solid #b00020; border-radius: 6px; background: #fff5f5; font-size: 14px; }
  @media (max-width: 820px) {
    .plot .desk { display: none; }
    .plot .phone { display: block; }
  }
  @media (max-width: 720px) {
    .wide .hide-narrow { display: none; }
    .list table, .list thead, .list tbody { display: block; }
    .list tr { display: grid; grid-template-columns: 52px 56px 56px 1fr; gap: 0 6px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line-2); }
    .list tbody tr:last-child { border-bottom: 0; }
    .wide .list th, .wide .list td { padding: 0; border: 0; }
    .wide .list .more-cell { display: block; grid-column: 1 / -1; padding-top: 2px; font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; }
    .tiles { grid-template-columns: 1fr 1fr; }
    .tile .value { font-size: 26px; }
    .effbar { display: none; }
  }
</style>`);

function chartCard(points: RunningPoint[]) {
  if (points.length === 0) {
    return html`<section class="card" aria-label="PPH through the sort"><h2>PPH through the sort</h2><p class="sub">The chart starts with the first update.</p></section>`;
  }
  const first = points[0].slot;
  const last = points[points.length - 1].slot;
  const xMax = Math.max(last, first + 8); // at least 2 hours wide, so one update is not stretched across
  const ticks: ChartInput['ticks'] = [];
  for (let s = first; s <= xMax; s += 1) {
    if (s % 2 === 0) ticks.push({ x: s, label: shortClock(s * QUARTER_MS), phone: s % 4 === 0 });
  }
  const latest = (values: (number | null)[]) => [...values].reverse().find((v) => v !== null) ?? null;
  const ps = points.map((p) => p.ps);
  const pd = points.map((p) => p.pd);
  const psNow = latest(ps);
  const pdNow = latest(pd);
  const input: ChartInput = {
    xs: points.map((p) => p.slot),
    xMin: first,
    xMax,
    ticks,
    tips: points.map((p) => clock(p.slot * QUARTER_MS)),
    series: [
      { name: 'PS', swatch: 'PS', color: '#2a78d6', values: ps, expected: points.map((p) => p.psExpected) },
      { name: 'PD', swatch: 'PD', color: '#eb6834', values: pd, expected: points.map((p) => p.pdExpected) },
    ],
    summary: `Line chart of running PPH from ${clock(first * QUARTER_MS)} to ${clock(last * QUARTER_MS)}. ${psNow === null ? '' : `PS is at ${count(psNow)}. `}${pdNow === null ? '' : `PD is at ${count(pdNow)}.`}`,
  };
  return html`<section class="card" aria-label="PPH through the sort">
<div class="chart-head"><h2>PPH through the sort</h2>${chartLegend(input)}</div>
${chartPlot(input)}
<details id="chart-table"><summary>Show these numbers as a table</summary>
<table><thead><tr><th>Time</th><th class="num">PS PPH</th><th class="num">PS expected</th><th class="num">PD PPH</th><th class="num">PD expected</th></tr></thead>
<tbody>${points.map(
    (p) => html`<tr><td>${clock(p.slot * QUARTER_MS)}</td><td class="num">${orDash(p.ps)}</td><td class="num">${orDash(p.psExpected)}</td><td class="num">${orDash(p.pd)}</td><td class="num">${orDash(p.pdExpected)}</td></tr>`,
  )}</tbody></table></details>
</section>`;
}

const overPlan = (hours: number | null) => {
  if (hours === null) return '';
  const size = oneDecimal(Math.abs(hours));
  return Math.abs(hours) < 0.05 ? 'on plan' : `${size} hrs ${hours > 0 ? 'over' : 'under'} plan`;
};

function typeTile(type: 'PS' | 'PD', name: string, t: TypeTotals) {
  return html`<div class="card tile"><div class="label"><i class="swatch ${type}"></i>${name} PPH</div>
<div class="value">${orDash(t.pph)}</div>
<div class="detail">Expected ${orDash(t.expectedPph)}${t.effectiveness === null ? '' : html` · <strong>${count(t.effectiveness)}% effective</strong>`}</div>
<div class="detail">${overPlan(t.overUnder)}</div></div>`;
}

function updatedCell(line: LiveLine, n: LineNumbers) {
  if (!n.inPlay) return html`<span class="idle">No one on it</span>`;
  if (n.hasFinal) return html`<span class="pill final">Final${line.lastAt ? html` · ${clockOf(line.lastAt)}` : ''}</span>`;
  if (n.late) return html`<span class="pill late">Late${line.lastAt ? html` · ${clockOf(line.lastAt)}` : ''}</span>`;
  return line.lastAt ? clockOf(line.lastAt) : html`<span class="idle">No update yet</span>`;
}

function lineRow(line: LiveLine, n: LineNumbers, lineHref?: (id: string) => string) {
  const who = line.supervisors.join(', ');
  const width = n.effectiveness === null ? 0 : Math.min(100, (n.effectiveness / 130) * 100);
  const extra = [who, n.lastSlot === null && !n.hasFinal ? '' : `${oneDecimal(n.hours)} hrs`, n.volume ? `${count(n.volume)} pcs` : '', n.onTime === null ? '' : `${count(n.onTime)}% on time`].filter(Boolean).join(' · ');
  return html`<tr data-line="${line.id}" class="${line.type}">
<td class="line">${lineHref ? html`<a href="${lineHref(line.id)}">${line.id}</a>` : line.id}</td>
<td class="who hide-narrow">${who || '-'}</td>
<td class="num"><strong>${orDash(n.pph)}</strong></td>
<td><div class="eff"><div class="effbar"><i style="width:${width.toFixed(0)}%"></i></div><span>${n.effectiveness === null ? '-' : `${count(n.effectiveness)}%`}</span></div></td>
<td class="num hide-narrow">${n.hours ? oneDecimal(n.hours) : '-'}</td>
<td class="num hide-narrow">${n.volume ? count(n.volume) : '-'}</td>
<td class="num hide-narrow">${n.onTime === null ? '-' : `${count(n.onTime)}%`}</td>
<td>${updatedCell(line, n)}</td>
<td class="more-cell">${extra}</td>
</tr>`;
}

function lineList(type: 'PS' | 'PD', title: string, lines: LiveLine[], numbers: Map<string, LineNumbers>, totals: TypeTotals, lineHref?: (id: string) => string) {
  return html`<section class="card list" aria-label="${title}">
<div class="list-head"><h2><i class="swatch ${type}"></i>${title}</h2><p class="sub">${totals.linesInPlay} running${totals.linesLate ? html` · <strong>${totals.linesLate} late</strong>` : ''}</p></div>
<table>
<thead><tr><th>Line</th><th class="hide-narrow">Supervisor</th><th class="num">PPH</th><th>Effective</th><th class="num hide-narrow">Hours</th><th class="num hide-narrow">Volume</th><th class="num hide-narrow">On time</th><th>Updated</th></tr></thead>
<tbody>${lines.map((l) => lineRow(l, numbers.get(l.id)!, lineHref))}</tbody>
</table>
</section>`;
}

const sortTabs = (open: SortRef[], latestFinished: SortRef | null, currentId: number | null, followingCurrent: boolean, sortHref: (s: SortRef) => string) => {
  const shown = latestFinished && !open.some((s) => s.id === latestFinished.id) ? [...open, latestFinished] : open;
  if (shown.length < 2 && !(shown.length === 1 && shown[0].id !== currentId)) return '';
  return html`<nav class="sorts" aria-label="Sorts">${shown.map(
    (s) => html`<a href="${sortHref(s)}"${s.id === currentId && !followingCurrent ? raw(' aria-current="page"') : s.id === currentId ? raw(' aria-current="true"') : ''}>${s.sort}${s.status === 'final' ? ' (finished)' : ''}</a>`,
  )}</nav>`;
};

export type PanelInput = {
  sort: LiveSort | null;
  open: SortRef[];
  latestFinished: SortRef | null;
  following: boolean; // on /live, which moves on to the next sort by itself
  now: Date;
  sortHref?: (s: SortRef) => string;
  lineHref?: (id: string) => string; // when a line links to its history
  refreshes?: boolean; // false when the numbers cannot change, as on the sample pages
};

// Everything that refreshes. data-stop tells the script a finished sort has nothing more to fetch.
export function livePanel({ sort, open, latestFinished, following, now, sortHref = (s) => `/live/${s.id}`, lineHref, refreshes = true }: PanelInput) {
  const nowMs = now.getTime();
  if (!sort) {
    return html`<span data-stop="0"></span>
<div class="card" style="margin-top:16px"><h2>No sort is running</h2><p class="sub">This page picks up the next sort by itself as soon as a supervisor starts one.</p></div>
<p class="foot">Checked at ${clock(nowMs)}. Refreshes every 30 seconds.</p>`;
  }
  const running = sort.status === 'open';
  const startMs = sort.startsAt ? Date.parse(sort.startsAt) : null;
  const endMs = sort.endsAt ? Date.parse(sort.endsAt) : null;
  const s = sortSummary(sort.lines, nowMs, running, startMs, endMs);
  const points = runningSeries(sort.lines);
  const nextDue = clock((quarterHourSlot(nowMs) + 1) * QUARTER_MS);
  const psLines = sort.lines.filter((l) => l.type === 'PS');
  const pdLines = sort.lines.filter((l) => l.type === 'PD');
  const onTime = s.linesInPlay - s.linesLate;
  const when = [longDay(sort.date), startMs === null ? 'no updates yet' : `started ${clock(startMs)}`, running ? `next update due ${nextDue}` : endMs === null ? 'finished' : `finished ${clock(endMs)}`];
  return html`<span data-stop="${!refreshes || (!running && !following) ? '1' : '0'}"></span>
<div class="heading"><h1>${sort.sort}</h1><p class="sub">${when.join(' · ')}</p></div>
${sortTabs(open, latestFinished, sort.id, following, sortHref)}
<section class="tiles" aria-label="Sort totals">
${typeTile('PS', 'PS (unload)', s.PS)}
${typeTile('PD', 'PD (load)', s.PD)}
<div class="card tile"><div class="label">Lines updated on time</div>
<div class="value">${onTime}<small> / ${s.linesInPlay}</small></div>
<div class="detail">${s.linesLate ? html`<strong>${s.linesLate} ${s.linesLate === 1 ? 'line' : 'lines'} late</strong>` : s.linesInPlay ? 'None late' : 'No lines started yet'}</div></div>
<div class="card tile"><div class="label">Volume so far</div>
<div class="value">${count(s.volume)}</div>
<div class="detail">${oneDecimal(s.hours)} hours worked</div>
<div class="detail">${s.flowPerHour === null ? '' : `${count(s.flowPerHour)} pieces per hour of sort`}</div></div>
</section>
${chartCard(points)}
<div class="lists">
${lineList('PS', 'PS lines', psLines, s.numbers, s.PS, lineHref)}
${lineList('PD', 'PD lines', pdLines, s.numbers, s.PD, lineHref)}
</div>
<p class="foot">${refreshes ? html`Updated ${clock(nowMs)}.${running || following ? ' Refreshes every 30 seconds.' : ''}` : html`As of ${clock(nowMs)}.`}</p>`;
}

const SCRIPT = raw(`<script>
(function () {
  var panel = document.getElementById('panel');
  var stale = document.getElementById('stale');
  var busy = false;

  function refresh() {
    var stop = panel.querySelector('[data-stop="1"]');
    if (document.hidden || busy || stop) return;
    busy = true;
    var table = document.getElementById('chart-table');
    var tableOpen = table && table.open;
    fetch(location.pathname + '?panel=1', { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('refresh failed'); return res.text(); })
      .then(function (text) {
        panel.innerHTML = text;
        var again = document.getElementById('chart-table');
        if (again && tableOpen) again.open = true;
        stale.hidden = true;
      })
      .catch(function () { stale.hidden = false; })
      .then(function () { busy = false; });
  }
  setInterval(refresh, 30000);
  document.addEventListener('visibilitychange', refresh);
})();
</script>`);

export type LivePageOptions = {
  above?: unknown; // shown above the panel and left alone by a refresh
  topLink?: { href: string; text: string };
  title?: string;
  eyebrow?: string;
};

export function livePage(panel: string, { above = '', topLink = { href: '/shift', text: 'Start shift' }, title = 'Live sort', eyebrow = 'Rank and Rate · Live sort' }: LivePageOptions = {}) {
  return layout(
    title,
    html`${DASHBOARD_STYLE}<main class="wide">
<div class="top"><p class="eyebrow">${eyebrow}</p><div class="links"><a class="link" href="${topLink.href}">${topLink.text}</a></div></div>
${above}
<div id="stale" class="notice" role="status" hidden>Could not refresh. These numbers may be out of date; it will keep trying.</div>
<div id="panel">${raw(panel)}</div>
</main>
${SCRIPT}
${CHART_SCRIPT}`,
  );
}
