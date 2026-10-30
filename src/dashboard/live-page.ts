// The live sort view (D043, D122): anyone with the link can watch a sort as it runs. The Worker
// renders it as plain HTML with a small script that swaps in a fresh copy every 30 seconds (D119).
// Everything sits inside #panel, so a refresh is one replacement.
import { html, raw } from 'hono/html';
import type { LiveLine, LiveSort, SortRef } from '../data/live.ts';
import { quarterHourSlot } from '../scoring/index.ts';
import { sortSummary, topLines, type LineNumbers, type TypeTotals } from '../scoring/live.ts';
import { layout } from '../entry/pages.ts';
import { clock, clockOf, count, longDay, oneDecimal } from '../format.ts';

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
  .wide [hidden] { display: none !important; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .tops { display: flex; flex-wrap: wrap; gap: 16px; }
  .top3 { flex: 1 1 400px; min-width: 0; }
  .top3 ol { list-style: none; margin: 8px 0 0; padding: 0; }
  .top3 li { display: grid; grid-template-columns: 24px 52px minmax(0, 1fr) 64px 84px; gap: 0 8px; align-items: baseline; padding: 10px 0; border-bottom: 1px solid var(--line-2); font-variant-numeric: tabular-nums; }
  .top3 li:last-child { border-bottom: 0; padding-bottom: 0; }
  .top3 .rank { font-weight: 700; color: var(--ink-2); }
  .top3 .top-line { font-weight: 700; }
  .top3 .top-line a { color: inherit; }
  .top3 .top-eff { font-size: 22px; font-weight: 700; text-align: right; }
  .top3 .top-pph { font-size: 14px; color: var(--ink-2); text-align: right; }
  .areas { margin-top: 16px; padding: 12px 16px; }
  .areas summary { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; min-height: 32px; font-size: 15px; font-weight: 600; cursor: pointer; }
  .areas summary::before { content: '▸'; color: var(--ink-2); }
  .areas[open] summary::before { content: '▾'; }
  .areas-count { font-weight: 400; color: var(--ink-2); }
  .areas-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .areas button { min-height: 40px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); color: var(--ink); font-size: 14px; font-weight: 600; }
  .areas label { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; margin: 0; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .areas input { flex: none; width: 18px; height: 18px; min-height: 0; margin: 0; padding: 0; }
  .lists { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 16px; align-items: flex-start; }
  #areas-none { margin: 16px 0 0; }
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
  @media (max-width: 720px) {
    .wide .hide-narrow { display: none; }
    .list table, .list thead, .list tbody { display: block; }
    .list tr { display: grid; grid-template-columns: 52px 56px 56px 1fr; gap: 0 6px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line-2); }
    .list tbody tr:last-child { border-bottom: 0; }
    .wide .list th, .wide .list td { padding: 0; border: 0; }
    .wide .list .more-cell { display: block; grid-column: 1 / -1; padding-top: 2px; font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; }
    .tiles { grid-template-columns: 1fr 1fr; }
    .tile:nth-child(3):last-child { grid-column: 1 / -1; }
    .tile .value { font-size: 26px; }
    .effbar { display: none; }
    .top3 li { grid-template-columns: 24px 52px minmax(0, 1fr) auto; }
    .top3 .who { grid-column: 2 / 4; grid-row: 2; font-size: 13px; }
    .top3 .top-eff { grid-column: 4; grid-row: 1; }
    .top3 .top-pph { grid-column: 4; grid-row: 2; font-size: 13px; }
  }
</style>`);

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
  if (n.late) return html`<span class="pill late"><span class="sr-only">Late, last update </span>${line.lastAt ? clockOf(line.lastAt) : 'No update yet'}</span>`;
  return line.lastAt ? clockOf(line.lastAt) : html`<span class="idle">No update yet</span>`;
}

function lineRow(line: LiveLine, n: LineNumbers, lineHref?: (id: string) => string) {
  const who = line.supervisors.join(', ');
  const width = n.effectiveness === null ? 0 : Math.min(100, (n.effectiveness / 130) * 100);
  const extra = [who, n.lastSlot === null && !n.hasFinal ? '' : `${oneDecimal(n.hours)} hrs`, n.volume ? `${count(n.volume)} pcs` : ''].filter(Boolean).join(' · ');
  return html`<tr data-line="${line.id}" data-type="${line.type}" data-group="${line.group}" class="${line.type}">
<td class="line">${lineHref ? html`<a href="${lineHref(line.id)}">${line.id}</a>` : line.id}</td>
<td class="who hide-narrow">${who || '-'}</td>
<td class="num hide-narrow">${n.hours ? oneDecimal(n.hours) : '-'}</td>
<td class="num hide-narrow">${n.volume ? count(n.volume) : '-'}</td>
<td class="num"><strong>${orDash(n.pph)}</strong></td>
<td><div class="eff"><div class="effbar"><i style="width:${width.toFixed(0)}%"></i></div><span>${n.effectiveness === null ? '-' : `${count(n.effectiveness)}%`}</span></div></td>
<td>${updatedCell(line, n)}</td>
<td class="more-cell">${extra}</td>
</tr>`;
}

function lineList(type: 'PS' | 'PD', title: string, lines: LiveLine[], numbers: Map<string, LineNumbers>, totals: TypeTotals, lineHref?: (id: string) => string) {
  return html`<section class="card list" aria-label="${title}">
<div class="list-head"><h2><i class="swatch ${type}"></i>${title}</h2><p class="sub">${totals.linesInPlay} running<span class="shown"></span></p></div>
<table>
<thead><tr><th>Line</th><th class="hide-narrow">Supervisor</th><th class="num hide-narrow">Hours</th><th class="num hide-narrow">Volume</th><th class="num">PPH</th><th>Effective</th><th>Last update</th></tr></thead>
<tbody>${lines.map((l) => lineRow(l, numbers.get(l.id)!, lineHref))}</tbody>
</table>
</section>`;
}

// The live ranking (D122): the whole sort, whatever the area filter is hiding below it.
function topCard(type: 'PS' | 'PD', lines: LiveLine[], numbers: Map<string, LineNumbers>, lineHref?: (id: string) => string) {
  const top = topLines(lines, numbers, type);
  return html`<section class="card top3" aria-label="Top 3 ${type} lines">
<div class="list-head"><h2><i class="swatch ${type}"></i>Top 3 ${type}</h2><p class="sub">By effectiveness</p></div>
${
  top.length === 0
    ? html`<p class="sub">No numbers yet.</p>`
    : html`<ol role="list">${top.map((l, i) => {
        const n = numbers.get(l.id)!;
        return html`<li data-top="${l.id}" class="${l.type}"><span class="rank">${i + 1}</span><span class="top-line">${lineHref ? html`<a href="${lineHref(l.id)}">${l.id}</a>` : l.id}</span><span class="who">${l.supervisors.join(', ') || '-'}</span><span class="top-eff">${count(n.effectiveness!)}%</span><span class="top-pph">${orDash(n.pph)} PPH</span></li>`;
      })}</ol>`
}
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
  const nextDue = clock((quarterHourSlot(nowMs) + 1) * QUARTER_MS);
  const psLines = sort.lines.filter((l) => l.type === 'PS');
  const pdLines = sort.lines.filter((l) => l.type === 'PD');
  const when = [longDay(sort.date), startMs === null ? 'no updates yet' : `started ${clock(startMs)}`, running ? `next update due ${nextDue}` : endMs === null ? 'finished' : `finished ${clock(endMs)}`];
  return html`<span data-stop="${!refreshes || (!running && !following) ? '1' : '0'}"></span>
<div class="heading"><h1>${sort.sort}</h1><p class="sub">${when.join(' · ')}</p></div>
${sortTabs(open, latestFinished, sort.id, following, sortHref)}
<section class="tiles" aria-label="Sort totals">
${typeTile('PS', 'PS (unload)', s.PS)}
${typeTile('PD', 'PD (load)', s.PD)}
<div class="card tile"><div class="label">Volume so far</div>
<div class="value">${count(s.volume)}</div>
<div class="detail">${oneDecimal(s.hours)} hours worked</div>
<div class="detail">${s.flowPerHour === null ? '' : `${count(s.flowPerHour)} pieces per hour of sort`}</div></div>
</section>
<div class="tops">
${topCard('PS', psLines, s.numbers, lineHref)}
${topCard('PD', pdLines, s.numbers, lineHref)}
</div>
<div id="areas-slot"></div>
<p id="areas-none" class="sub" hidden>No areas picked. Open Filter areas and pick at least one.</p>
<div class="lists">
${lineList('PS', 'PS lines', psLines, s.numbers, s.PS, lineHref)}
${lineList('PD', 'PD lines', pdLines, s.numbers, s.PD, lineHref)}
</div>
<p class="foot">${refreshes ? html`Updated ${clock(nowMs)}.${running || following ? ' Refreshes every 30 seconds.' : ''}` : html`As of ${clock(nowMs)}.`}</p>`;
}

// Named sets of lines for the area filter's quick picks (D126, D127). They are not groups in the data
// model, because expected PPH goes by group.
export const AREA_PICKS = [
  { name: 'W-UNL', type: 'PS', lines: ['PS1', 'PS3', 'PS5', 'PS7', 'PS9', 'PS11'] },
  { name: 'E-UNL', type: 'PS', lines: ['PS2', 'PS4', 'PS6', 'PS8', 'PS10', 'PS12', 'PS14'] },
  { name: 'West Wing', type: 'PD', lines: ['PD6', 'PD7', 'PD8', 'PD9'] },
  { name: 'East Wing', type: 'PD', lines: ['PD10', 'PD11', 'PD12', 'PD13'] },
];

const SCRIPT = raw(`<script>
(function () {
  var panel = document.getElementById('panel');
  var stale = document.getElementById('stale');
  var busy = false;

  // The area filter (D124): the script builds it from the rows, and it only hides rows, in this
  // browser. It stays in one piece across refreshes, so it keeps its picks and stays open.
  var KEY = 'rr_areas';
  var PICKS = ${JSON.stringify(AREA_PICKS)};
  var picked = null; // the lines to show, or null for all of them
  var filter = null;
  try {
    var saved = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(saved)) picked = saved;
  } catch (e) {}

  function save() {
    try {
      if (picked) localStorage.setItem(KEY, JSON.stringify(picked));
      else localStorage.removeItem(KEY);
    } catch (e) {}
  }
  function rows() { return Array.prototype.slice.call(panel.querySelectorAll('tr[data-line]')); }
  function make(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  }
  function build() {
    var all = rows();
    filter = make('details', 'card areas');
    var summary = make('summary');
    summary.appendChild(make('span', '', 'Filter areas'));
    summary.appendChild(make('span', 'areas-count'));
    filter.appendChild(summary);

    var linesOf = function (key, value) {
      return all.filter(function (r) { return r.dataset[key] === value; }).map(function (r) { return r.dataset.line; });
    };
    var seen = {};
    var choices = [['All', null]];
    all.forEach(function (r) {
      var type = r.dataset.type;
      if (seen[type]) return;
      seen[type] = true;
      choices.push([type, linesOf('type', type)]);
      // A type's parts follow it: any group that is only part of it, then its named picks.
      all.forEach(function (g) {
        if (g.dataset.type !== type || seen[g.dataset.group]) return;
        seen[g.dataset.group] = true;
        var lines = linesOf('group', g.dataset.group);
        if (lines.length < linesOf('type', type).length) choices.push([g.dataset.group, lines]);
      });
      PICKS.forEach(function (pick) {
        if (pick.type === type) choices.push([pick.name, pick.lines]);
      });
    });
    choices.push(['None', []]);
    var quick = make('div', 'areas-row');
    choices.forEach(function (choice) {
      var button = make('button', '', choice[0]);
      button.type = 'button';
      button.addEventListener('click', function () {
        picked = choice[1];
        save();
        apply();
      });
      quick.appendChild(button);
    });
    filter.appendChild(quick);

    var rowFor = {};
    all.forEach(function (r) {
      if (!rowFor[r.dataset.type]) {
        rowFor[r.dataset.type] = make('div', 'areas-row');
        filter.appendChild(rowFor[r.dataset.type]);
      }
      var label = make('label');
      var box = make('input');
      box.type = 'checkbox';
      box.value = r.dataset.line;
      label.appendChild(box);
      label.appendChild(document.createTextNode(r.dataset.line));
      rowFor[r.dataset.type].appendChild(label);
    });
    filter.addEventListener('change', function () {
      var boxes = Array.prototype.slice.call(filter.querySelectorAll('input'));
      var on = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
      picked = on.length === boxes.length ? null : on;
      save();
      apply();
    });
  }
  function apply() {
    var slot = document.getElementById('areas-slot');
    if (!slot) return;
    if (!filter) build();
    if (filter.parentNode !== slot) slot.appendChild(filter);
    var all = rows();
    var isShown = function (id) { return !picked || picked.indexOf(id) >= 0; };
    all.forEach(function (r) { r.hidden = !isShown(r.dataset.line); });
    Array.prototype.slice.call(filter.querySelectorAll('input')).forEach(function (b) { b.checked = isShown(b.value); });
    Array.prototype.slice.call(panel.querySelectorAll('.list')).forEach(function (list) {
      var shown = list.querySelectorAll('tr[data-line]:not([hidden])').length;
      list.hidden = shown === 0;
      list.querySelector('.shown').textContent = picked ? ' · ' + shown + ' shown' : '';
    });
    var shownCount = all.filter(function (r) { return !r.hidden; }).length;
    filter.querySelector('.areas-count').textContent = picked ? shownCount + ' of ' + all.length + ' showing' : 'All ' + all.length + ' showing';
    document.getElementById('areas-none').hidden = shownCount > 0;
  }

  function refresh() {
    var stop = panel.querySelector('[data-stop="1"]');
    if (document.hidden || busy || stop) return;
    busy = true;
    fetch(location.pathname + '?panel=1', { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('refresh failed'); return res.text(); })
      .then(function (text) {
        var focused = document.activeElement;
        panel.innerHTML = text;
        apply();
        if (filter && filter.contains(focused)) focused.focus();
        stale.hidden = true;
      })
      .catch(function () { stale.hidden = false; })
      .then(function () { busy = false; });
  }
  apply();
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
${SCRIPT}`,
  );
}
