// The results page, the post-sort view (D028): who won, the full ranking of the lines, and the
// supervisors, for one sort at a time over a night or a period (D072, D125). It takes its rows as
// plain data, so the same page shows real nights and the sample's.
import { html, raw } from 'hono/html';
import { PERIODS, type DateRange } from '../scoring/periods.ts';
import { lineResults, supervisorResults, winners, type LineResult, type NightLine, type SupervisorResult } from '../scoring/results.ts';
import { layout } from '../entry/pages.ts';
import { count, longDay, oneDecimal, shortDay } from '../format.ts';
import { filterBar, type PeriodChoice } from './filters.ts';
import { overPlan } from './line-page.ts';
import { DASHBOARD_STYLE } from './live-page.ts';

const orDash = (n: number | null, show: (v: number) => string = count) => (n === null ? '-' : show(n));
const percent = (n: number | null) => (n === null ? '-' : `${count(n)}%`);

const STYLE = raw(`<style>
  .wins { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin: 16px 0; }
  .win { display: flex; flex-direction: column; gap: 4px; border-top: 4px solid var(--ink-2); }
  .win.PS { border-top-color: var(--ps); }
  .win.PD { border-top-color: var(--pd); }
  .win.overall { background: #12161c; border-color: #12161c; color: #fff; }
  .win .what { font-size: 13px; font-weight: 600; color: var(--ink-2); }
  .win .name { font-size: 26px; font-weight: 700; line-height: 1.2; }
  .win .name a { color: inherit; }
  .win .who { font-size: 14px; }
  .win .nums { display: flex; gap: 20px; margin-top: 6px; }
  .win .big { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .win .small { font-size: 12px; color: var(--ink-2); }
  .win.overall .what, .win.overall .who, .win.overall .small { color: #c9ced6; }
  .results { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .results .ranking { flex: 999 1 640px; min-width: 0; }
  .results .sups { flex: 1 1 340px; min-width: 0; }
  .results .note { margin: 10px 0 0; font-size: 13px; color: var(--ink-2); }
  .sups .person { font-weight: 600; overflow-wrap: anywhere; }
  .sups .about { font-size: 12px; font-weight: 400; color: var(--ink-2); }
  @media (max-width: 720px) {
    .ranking tr { grid-template-columns: 24px 56px 56px 1fr; }
  }
</style>`);

// A line's supervisors over the period: a few names, or how many once that stops being readable.
const whoOf = (supervisors: string[]) => (supervisors.length > 3 ? `${supervisors.length} supervisors` : supervisors.join(', ') || '-');

function winCard(what: string, cls: string, line: LineResult | null, lineHref: (id: string) => string, effectivenessFirst = false) {
  if (!line) return html`<div class="card win ${cls}"><div class="what">${what}</div><div class="who">No numbers yet</div></div>`;
  const pphNum = html`<div><div class="big">${orDash(line.pph)}</div><div class="small">PPH${effectivenessFirst && line.expectedPph !== null ? ` vs ${count(line.expectedPph)} expected` : ''}</div></div>`;
  const effNum = html`<div><div class="big">${percent(line.effectiveness)}</div><div class="small">effective</div></div>`;
  return html`<div class="card win ${cls}" data-win="${line.id}"><div class="what">${what}</div>
<div class="name"><a href="${lineHref(line.id)}">${line.id}</a></div>
<div class="who">${line.supervisors.length ? whoOf(line.supervisors) : ''}</div>
<div class="nums">${effectivenessFirst ? html`${effNum}${pphNum}` : html`${pphNum}${effNum}`}</div></div>`;
}

function rankingCard(lines: LineResult[], manyNights: boolean, lineHref: (id: string) => string) {
  return html`<section class="card list ranking" aria-label="Line ranking">
<div class="list-head"><h2>Line ranking</h2><p class="sub">By effectiveness</p></div>
<table>
<thead><tr><th>#</th><th>Line</th><th class="hide-narrow">Supervisor</th><th class="num hide-narrow">Hours</th><th class="num hide-narrow">Volume</th><th class="num">PPH</th><th>Effective</th><th class="num hide-narrow">Over / under</th>${manyNights ? html`<th class="num hide-narrow">Nights</th><th class="num hide-narrow">Nights #1</th>` : ''}</tr></thead>
<tbody>${lines.map((l, i) => {
    const who = whoOf(l.supervisors);
    const width = l.effectiveness === null ? 0 : Math.min(100, (l.effectiveness / 130) * 100);
    const over = overPlan(l.overUnder);
    const extra = [who === '-' ? '' : who, `${oneDecimal(l.hours)} hrs`, `${count(l.volume)} pcs`, over === 'on plan' || over === '-' ? over : `${over} plan`, manyNights ? `${l.nights} ${l.nights === 1 ? 'night' : 'nights'}, ${l.wins} at #1` : ''].filter((t) => t && t !== '-').join(' · ');
    return html`<tr data-rank="${l.id}" class="${l.type}">
<td class="rank-cell">${i + 1}</td>
<td class="line"><a href="${lineHref(l.id)}">${l.id}</a></td>
<td class="who hide-narrow">${who}</td>
<td class="num hide-narrow">${oneDecimal(l.hours)}</td>
<td class="num hide-narrow">${count(l.volume)}</td>
<td class="num"><strong>${orDash(l.pph)}</strong></td>
<td><div class="eff"><div class="effbar"><i style="width:${width.toFixed(0)}%"></i></div><span>${percent(l.effectiveness)}</span></div></td>
<td class="num hide-narrow">${over}</td>
${manyNights ? html`<td class="num hide-narrow">${l.nights}</td><td class="num hide-narrow">${l.wins}</td>` : ''}
<td class="more-cell">${extra}</td>
</tr>`;
  })}</tbody>
</table>
<p class="note">Effectiveness is actual PPH divided by expected PPH. Over / under is hours minus the hours to make plan, shown for staffing and not used to rank.</p>
</section>`;
}

// The lines a supervisor ran: a few, then how many more, so a long record stays one short line.
const linesOf = (lines: string[]) => (lines.length > 4 ? `${lines.slice(0, 4).join(', ')} and ${lines.length - 4} more` : lines.join(', '));

function supervisorsCard(people: SupervisorResult[], unnamed: number) {
  const noName = unnamed === 0 ? '' : html`<p class="note">${unnamed} ${unnamed === 1 ? 'line' : 'lines'} with no name, because totals typed on the admin screen do not say who ran the line.</p>`;
  return html`<section class="card sups" aria-label="Supervisors">
<div class="list-head"><h2>Supervisors</h2><p class="sub">Across every line they ran</p></div>
${
  people.length === 0
    ? html`<p class="sub">No names yet.</p>`
    : html`<table>
<thead><tr><th>#</th><th>Supervisor</th><th class="num">Nights</th><th class="num">PPH</th><th class="num">Effective</th></tr></thead>
<tbody>${people.map(
        (p, i) => html`<tr data-person>
<td>${i + 1}</td>
<td class="person">${p.name}<div class="about">${linesOf(p.lines)} · ${oneDecimal(p.hours)} hrs · ${count(p.volume)} pcs</div></td>
<td class="num">${p.nights}</td>
<td class="num"><strong>${orDash(p.pph)}</strong></td>
<td class="num">${percent(p.effectiveness)}</td>
</tr>`,
      )}</tbody>
</table>`
}
${noName}
</section>`;
}

function periodText(period: PeriodChoice, range: DateRange) {
  if (period === 'latest') return range.from ? longDay(range.from) : '';
  if (period === 'custom') return `${range.from ? shortDay(range.from) : 'The start'} to ${range.to ? shortDay(range.to) : 'today'}`;
  return PERIODS.find((p) => p.key === period)?.label ?? '';
}

export type ResultsInput = {
  rows: NightLine[]; // already limited to the sort and the period
  activeLines: number;
  sorts: readonly string[];
  sort: string;
  period: PeriodChoice;
  range: DateRange;
  basePath: string;
  lineHref: (id: string) => string;
  links: { href: string; text: string }[];
  above?: unknown;
};

export function resultsPage({ rows, activeLines, sorts, sort, period, range, basePath, lineHref, links, above = '' }: ResultsInput) {
  const lines = lineResults(rows);
  const best = winners(lines);
  const nights = new Set(rows.map((r) => r.date)).size;
  const manyNights = nights > 1;
  const unnamed = rows.filter((r) => r.supervisors.length === 0).length;
  const scope = period === 'latest' ? `${lines.length} of ${activeLines} lines` : `${nights} ${nights === 1 ? 'night' : 'nights'}`;
  const sub = [periodText(period, range), rows.length ? scope : ''].filter(Boolean).join(' · ');

  return layout(
    'Results',
    html`${DASHBOARD_STYLE}${STYLE}<main class="wide">
<div class="top"><p class="eyebrow">Rank and Rate · Results</p><div class="links">${links.map((l) => html`<a class="link" href="${l.href}">${l.text}</a>`)}</div></div>
${above}
<div class="heading"><h1>${sorts.length ? `${sort} results` : 'Results'}</h1><p class="sub">${sub}</p></div>
${
  sorts.length === 0
    ? html`<div class="card" style="margin-top:16px"><h2>No finished sorts yet</h2><p class="sub">Results show here once a sort has its final numbers.</p></div>`
    : html`${filterBar({ basePath, sorts, sort, period, range, withLatest: true })}
${
  rows.length === 0
    ? html`<div class="card" style="margin-top:16px"><h2>No ${sort} sorts in this period</h2><p class="sub">Try a longer period.</p></div>`
    : html`<section class="wins" aria-label="Winners">
${winCard('Best PS · by PPH', 'PS', best.ps, lineHref)}
${winCard('Best PD · by PPH', 'PD', best.pd, lineHref)}
${winCard('Best overall · by effectiveness', 'overall', best.overall, lineHref, true)}
</section>
<div class="results">
${rankingCard(lines, manyNights, lineHref)}
${supervisorsCard(supervisorResults(rows), unnamed)}
</div>`
}`
}
</main>`,
  );
}
