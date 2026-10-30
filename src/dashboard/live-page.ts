// The live sort view (D027, D043): anyone with the link can watch a sort as it runs. The Worker
// renders it, chart included, as plain HTML and SVG with a small script that swaps in a fresh copy
// every 30 seconds (D119). Everything sits inside #panel, so a refresh is one replacement.
import { html, raw } from 'hono/html';
import type { LiveLine, LiveSort, SortRef } from '../data/live.ts';
import { quarterHourSlot } from '../scoring/index.ts';
import { runningSeries, sortSummary, type LineNumbers, type RunningPoint, type TypeTotals } from '../scoring/live.ts';
import { layout } from '../entry/pages.ts';

const QUARTER_MS = 15 * 60 * 1000;
const TIME_ZONE = 'America/Los_Angeles';

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE });
const clockOf = (iso: string) => clock(Date.parse(iso));
const shortClock = (ms: number) => clock(ms).replace(/ [AP]M$/, '');
const count = (n: number) => Math.round(n).toLocaleString('en-US');
const oneDecimal = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const orDash = (n: number | null, show: (v: number) => string = count) => (n === null ? '-' : show(n));
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

const STYLE = raw(`<style>
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

// The chart, drawn for one size. Text in SVG scales with it, so the phone gets its own drawing.
const SIZES = { desk: { w: 1200, h: 320, left: 44, right: 70, top: 14, bottom: 26, font: 13, every: 2 }, phone: { w: 360, h: 240, left: 36, right: 60, top: 12, bottom: 24, font: 11, every: 4 } };
type Size = (typeof SIZES)['desk'];

function niceMax(highest: number): { max: number; step: number } {
  for (const step of [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000]) {
    if (highest / step <= 5) return { max: Math.max(step, Math.ceil(highest / step) * step), step };
  }
  return { max: Math.ceil(highest / 20000) * 20000, step: 20000 };
}

function drawChart(points: RunningPoint[], size: Size, cls: string) {
  const first = points[0].slot;
  const last = Math.max(points[points.length - 1].slot, first + 8); // at least 2 hours wide, so one update is not stretched across
  const values = points.flatMap((p) => [p.ps, p.psExpected, p.pd, p.pdExpected]).filter((v): v is number => v !== null);
  const { max, step } = niceMax(Math.max(100, ...values));
  const plotW = size.w - size.left - size.right;
  const plotH = size.h - size.top - size.bottom;
  const x = (slot: number) => size.left + ((slot - first) / (last - first)) * plotW;
  const y = (v: number) => size.top + plotH - (v / max) * plotH;
  const round1 = (n: number) => Math.round(n * 10) / 10;

  const pathOf = (pick: (p: RunningPoint) => number | null) => {
    let d = '';
    let pen = false;
    for (const p of points) {
      const v = pick(p);
      if (v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${round1(x(p.slot))} ${round1(y(v))}`;
      pen = true;
    }
    return d;
  };

  const yTicks: number[] = [];
  for (let v = 0; v <= max; v += step) yTicks.push(v);
  const xTicks: number[] = [];
  for (let s = first; s <= last; s += 1) if (s % size.every === 0) xTicks.push(s);

  const lastOf = (pick: (p: RunningPoint) => number | null) => {
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const v = pick(points[i]);
      if (v !== null) return { slot: points[i].slot, v };
    }
    return null;
  };
  const psEnd = lastOf((p) => p.ps);
  const pdEnd = lastOf((p) => p.pd);
  // The upper series is labelled above its dot and the lower below, so the two never collide.
  const endLabel = (name: string, end: { slot: number; v: number } | null, other: { slot: number; v: number } | null) => {
    if (!end) return '';
    const above = !other || end.v >= other.v;
    const px = x(end.slot);
    const nearRight = px > size.w - size.right - 20;
    return html`<text x="${round1(nearRight ? px + 8 : px)}" y="${round1(y(end.v) + (above ? -9 : 17))}" text-anchor="${nearRight ? 'start' : 'middle'}" font-size="${size.font + 1}" font-weight="700" fill="#0b0b0b">${name} ${count(end.v)}</text>`;
  };
  const dot = (end: { slot: number; v: number } | null, color: string) =>
    end ? html`<circle cx="${round1(x(end.slot))}" cy="${round1(y(end.v))}" r="4.5" fill="${color}" stroke="#fff" stroke-width="2"></circle>` : '';

  const data = points.map((p) => ({
    x: round1(x(p.slot)),
    t: clock(p.slot * QUARTER_MS),
    ps: p.ps === null ? null : Math.round(p.ps),
    pse: p.psExpected === null ? null : Math.round(p.psExpected),
    pd: p.pd === null ? null : Math.round(p.pd),
    pde: p.pdExpected === null ? null : Math.round(p.pdExpected),
  }));
  const summary = `Line chart of running PPH from ${clock(first * QUARTER_MS)} to ${clock(points[points.length - 1].slot * QUARTER_MS)}. ${psEnd ? `PS is at ${count(psEnd.v)}. ` : ''}${pdEnd ? `PD is at ${count(pdEnd.v)}.` : ''}`;

  return html`<svg class="${cls}" viewBox="0 0 ${size.w} ${size.h}" role="img" aria-label="${summary}" tabindex="0" data-points="${JSON.stringify(data)}" data-top="${size.top}" data-bottom="${size.h - size.bottom}">
<g stroke="#e1e0d9" stroke-width="1">${yTicks.map((v) => html`<line x1="${size.left}" x2="${size.w - size.right}" y1="${round1(y(v))}" y2="${round1(y(v))}"></line>`)}</g>
<g font-size="${size.font}" fill="#52514e" text-anchor="end">${yTicks.map((v) => html`<text x="${size.left - 6}" y="${round1(y(v) + 4)}">${count(v)}</text>`)}</g>
<g font-size="${size.font}" fill="#52514e" text-anchor="middle">${xTicks.map((s) => html`<text x="${round1(x(s))}" y="${size.h - 6}">${shortClock(s * QUARTER_MS)}</text>`)}</g>
<path d="${pathOf((p) => p.psExpected)}" fill="none" stroke="#2a78d6" stroke-width="1.5" stroke-dasharray="6 5" opacity=".75"></path>
<path d="${pathOf((p) => p.pdExpected)}" fill="none" stroke="#eb6834" stroke-width="1.5" stroke-dasharray="6 5" opacity=".75"></path>
<path d="${pathOf((p) => p.ps)}" fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
<path d="${pathOf((p) => p.pd)}" fill="none" stroke="#eb6834" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
${dot(psEnd, '#2a78d6')}${dot(pdEnd, '#eb6834')}
${endLabel('PS', psEnd, pdEnd)}${endLabel('PD', pdEnd, psEnd)}
<line class="cross" x1="0" x2="0" y1="${size.top}" y2="${size.h - size.bottom}" stroke="#52514e" stroke-width="1" visibility="hidden"></line>
</svg>`;
}

function chartCard(points: RunningPoint[]) {
  if (points.length === 0) {
    return html`<section class="card" aria-label="PPH through the sort"><h2>PPH through the sort</h2><p class="sub">The chart starts with the first update.</p></section>`;
  }
  return html`<section class="card" aria-label="PPH through the sort">
<div class="chart-head"><h2>PPH through the sort</h2>
<div class="legend"><span><i class="swatch PS"></i>PS lines</span><span><i class="swatch PD"></i>PD lines</span><span><i class="swatch dash"></i>Expected</span></div></div>
<div class="plot">${drawChart(points, SIZES.desk, 'desk')}${drawChart(points, SIZES.phone, 'phone')}<div class="tip" id="tip" hidden></div></div>
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

function lineRow(line: LiveLine, n: LineNumbers) {
  const who = line.supervisors.join(', ');
  const width = n.effectiveness === null ? 0 : Math.min(100, (n.effectiveness / 130) * 100);
  const extra = [who, n.lastSlot === null && !n.hasFinal ? '' : `${oneDecimal(n.hours)} hrs`, n.volume ? `${count(n.volume)} pcs` : '', n.onTime === null ? '' : `${count(n.onTime)}% on time`].filter(Boolean).join(' · ');
  return html`<tr data-line="${line.id}" class="${line.type}">
<td class="line">${line.id}</td>
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

function lineList(type: 'PS' | 'PD', title: string, lines: LiveLine[], numbers: Map<string, LineNumbers>, totals: TypeTotals) {
  return html`<section class="card list" aria-label="${title}">
<div class="list-head"><h2><i class="swatch ${type}"></i>${title}</h2><p class="sub">${totals.linesInPlay} running${totals.linesLate ? html` · <strong>${totals.linesLate} late</strong>` : ''}</p></div>
<table>
<thead><tr><th>Line</th><th class="hide-narrow">Supervisor</th><th class="num">PPH</th><th>Effective</th><th class="num hide-narrow">Hours</th><th class="num hide-narrow">Volume</th><th class="num hide-narrow">On time</th><th>Updated</th></tr></thead>
<tbody>${lines.map((l) => lineRow(l, numbers.get(l.id)!))}</tbody>
</table>
</section>`;
}

const sortTabs = (open: SortRef[], latestFinished: SortRef | null, currentId: number | null, followingCurrent: boolean) => {
  const shown = latestFinished && !open.some((s) => s.id === latestFinished.id) ? [...open, latestFinished] : open;
  if (shown.length < 2 && !(shown.length === 1 && shown[0].id !== currentId)) return '';
  return html`<nav class="sorts" aria-label="Sorts">${shown.map(
    (s) => html`<a href="/live/${s.id}"${s.id === currentId && !followingCurrent ? raw(' aria-current="page"') : s.id === currentId ? raw(' aria-current="true"') : ''}>${s.sort}${s.status === 'final' ? ' (finished)' : ''}</a>`,
  )}</nav>`;
};

export type PanelInput = {
  sort: LiveSort | null;
  open: SortRef[];
  latestFinished: SortRef | null;
  following: boolean; // on /live, which moves on to the next sort by itself
  now: Date;
};

// Everything that refreshes. data-stop tells the script a finished sort has nothing more to fetch.
export function livePanel({ sort, open, latestFinished, following, now }: PanelInput) {
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
  const when = [dayLabel(sort.date), startMs === null ? 'no updates yet' : `started ${clock(startMs)}`, running ? `next update due ${nextDue}` : endMs === null ? 'finished' : `finished ${clock(endMs)}`];
  return html`<span data-stop="${!running && !following ? '1' : '0'}"></span>
<div class="heading"><h1>${sort.sort}</h1><p class="sub">${when.join(' · ')}</p></div>
${sortTabs(open, latestFinished, sort.id, following)}
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
${lineList('PS', 'PS lines', psLines, s.numbers, s.PS)}
${lineList('PD', 'PD lines', pdLines, s.numbers, s.PD)}
</div>
<p class="foot">Updated ${clock(nowMs)}.${running || following ? ' Refreshes every 30 seconds.' : ''}</p>`;
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

  // The chart's hover: a crosshair and one readout for every series at the nearest quarter hour.
  function row(name, swatch, value, expected) {
    if (value === null) return null;
    var div = document.createElement('div');
    var key = document.createElement('i');
    key.className = 'swatch ' + swatch;
    var strong = document.createElement('strong');
    strong.textContent = value.toLocaleString();
    div.appendChild(key);
    div.appendChild(strong);
    div.appendChild(document.createTextNode(' ' + name + (expected === null ? '' : ', expected ' + expected.toLocaleString())));
    return div;
  }
  function showAt(svg, index) {
    var points = JSON.parse(svg.getAttribute('data-points'));
    var p = points[Math.max(0, Math.min(points.length - 1, index))];
    svg.dataset.at = points.indexOf(p);
    var cross = svg.querySelector('.cross');
    cross.setAttribute('x1', p.x);
    cross.setAttribute('x2', p.x);
    cross.setAttribute('visibility', 'visible');
    var tip = document.getElementById('tip');
    tip.textContent = '';
    var title = document.createElement('b');
    title.textContent = p.t;
    tip.appendChild(title);
    [row('PS', 'PS', p.ps, p.pse), row('PD', 'PD', p.pd, p.pde)].forEach(function (r) { if (r) tip.appendChild(r); });
    tip.hidden = false;
    var box = svg.getBoundingClientRect();
    var left = (p.x / svg.viewBox.baseVal.width) * box.width;
    var tipWidth = tip.offsetWidth;
    tip.style.left = (left + 12 + tipWidth > box.width ? Math.max(0, left - tipWidth - 12) : left + 12) + 'px';
  }
  function hide(svg) {
    svg.querySelector('.cross').setAttribute('visibility', 'hidden');
    document.getElementById('tip').hidden = true;
    delete svg.dataset.at;
  }
  function nearest(svg, clientX) {
    var points = JSON.parse(svg.getAttribute('data-points'));
    var box = svg.getBoundingClientRect();
    var at = ((clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
    var best = 0;
    points.forEach(function (p, i) { if (Math.abs(p.x - at) < Math.abs(points[best].x - at)) best = i; });
    return best;
  }
  panel.addEventListener('pointermove', function (e) {
    var svg = e.target.closest && e.target.closest('.plot svg');
    if (svg) showAt(svg, nearest(svg, e.clientX));
  });
  panel.addEventListener('pointerout', function (e) {
    var svg = e.target.closest && e.target.closest('.plot svg');
    if (svg && !svg.contains(e.relatedTarget)) hide(svg);
  });
  panel.addEventListener('focusin', function (e) {
    if (e.target.matches && e.target.matches('.plot svg')) showAt(e.target, JSON.parse(e.target.getAttribute('data-points')).length - 1);
  });
  panel.addEventListener('focusout', function (e) {
    if (e.target.matches && e.target.matches('.plot svg')) hide(e.target);
  });
  panel.addEventListener('keydown', function (e) {
    if (!(e.target.matches && e.target.matches('.plot svg'))) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    showAt(e.target, Number(e.target.dataset.at || 0) + (e.key === 'ArrowLeft' ? -1 : 1));
  });
})();
</script>`);

export function livePage(panel: string) {
  return layout(
    'Live sort',
    html`${STYLE}<main class="wide">
<div class="top"><p class="eyebrow">Rank and Rate · Live sort</p><div class="links"><a class="link" href="/shift">Start shift</a></div></div>
<div id="stale" class="notice" role="status" hidden>Could not refresh. These numbers may be out of date; it will keep trying.</div>
<div id="panel">${raw(panel)}</div>
</main>
${SCRIPT}`,
  );
}
