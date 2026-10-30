// A line chart as plain SVG, drawn by the Worker (D119). Text in SVG scales with the drawing, so a
// phone gets its own drawing rather than a shrunken one, and CSS shows whichever fits.
import { html, raw } from 'hono/html';
import { count } from '../format.ts';

export type ChartSeries = {
  name: string;
  swatch: string; // the CSS class that colors its key
  color: string;
  values: (number | null)[];
  expected?: (number | null)[]; // its own expected line, dashed in the same color
};

export type ChartInput = {
  xs: number[]; // where each point sits along the bottom, in any unit
  xMin: number;
  xMax: number;
  ticks: { x: number; label: string; phone: boolean }[];
  tips: string[]; // the heading of the readout for each point
  series: ChartSeries[];
  reference?: number | null; // one flat expected line shared by every series
  summary: string; // what a screen reader says for the whole chart
};

const SIZES = {
  desk: { w: 1200, h: 320, left: 44, right: 70, top: 14, bottom: 26, font: 13 },
  phone: { w: 360, h: 240, left: 36, right: 60, top: 12, bottom: 24, font: 11 },
};
type Size = (typeof SIZES)['desk'];

const round1 = (n: number) => Math.round(n * 10) / 10;

function niceMax(highest: number): { max: number; step: number } {
  for (const step of [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000]) {
    if (highest / step <= 5) return { max: Math.max(step, Math.ceil(highest / step) * step), step };
  }
  return { max: Math.ceil(highest / 20000) * 20000, step: 20000 };
}

function draw(input: ChartInput, base: Size, cls: string) {
  const { xs, xMin, xMax, series, reference } = input;
  const longest = Math.max(...series.map((s) => s.name.length)) + 6; // the name, a space and a number
  const size = { ...base, right: Math.max(base.right, Math.ceil(longest * (base.font + 1) * 0.6) + 12) };
  const span = xMax - xMin || 1;
  const every = series.flatMap((s) => [...s.values, ...(s.expected ?? [])]).filter((v): v is number => v !== null);
  const { max, step } = niceMax(Math.max(100, reference ?? 0, ...every));
  const plotW = size.w - size.left - size.right;
  const plotH = size.h - size.top - size.bottom;
  const x = (v: number) => size.left + ((v - xMin) / span) * plotW;
  const y = (v: number) => size.top + plotH - (v / max) * plotH;

  const pathOf = (values: (number | null)[]) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${round1(x(xs[i]))} ${round1(y(v))}`;
      pen = true;
    });
    return d;
  };

  const yTicks: number[] = [];
  for (let v = 0; v <= max; v += step) yTicks.push(v);
  const xTicks = cls === 'phone' ? input.ticks.filter((t) => t.phone) : input.ticks;

  const lastOf = (values: (number | null)[]) => {
    for (let i = values.length - 1; i >= 0; i -= 1) {
      const v = values[i];
      if (v !== null) return { at: xs[i], v };
    }
    return null;
  };
  const ends = series.map((s) => ({ s, end: lastOf(s.values) }));
  // With two series the upper is labelled above its dot and the lower below, so they never collide.
  const endLabel = (name: string, end: { at: number; v: number } | null, others: ({ at: number; v: number } | null)[]) => {
    if (!end) return '';
    const above = others.every((o) => !o || end.v >= o.v);
    const px = x(end.at);
    const nearRight = px > size.w - size.right - 20;
    const nearLeft = px < size.left + 30;
    return html`<text x="${round1(nearRight ? px + 8 : nearLeft ? px + 2 : px)}" y="${round1(y(end.v) + (above ? -9 : 17))}" text-anchor="${nearRight || nearLeft ? 'start' : 'middle'}" font-size="${size.font + 1}" font-weight="700" fill="#0b0b0b">${name} ${count(end.v)}</text>`;
  };

  const points = xs.map((at, i) => ({
    x: round1(x(at)),
    t: input.tips[i],
    r: series.flatMap((s) => {
      const v = s.values[i];
      if (v === null) return [];
      const expected = s.expected?.[i] ?? reference ?? null;
      return [[s.swatch, Math.round(v), `${s.name}${expected === null ? '' : `, expected ${count(expected)}`}`]];
    }),
  }));

  return html`<svg class="${cls}" viewBox="0 0 ${size.w} ${size.h}" role="img" aria-label="${input.summary}" tabindex="0" data-points="${JSON.stringify(points)}">
<g stroke="#e1e0d9" stroke-width="1">${yTicks.map((v) => html`<line x1="${size.left}" x2="${size.w - size.right}" y1="${round1(y(v))}" y2="${round1(y(v))}"></line>`)}</g>
<g font-size="${size.font}" fill="#52514e" text-anchor="end">${yTicks.map((v) => html`<text x="${size.left - 6}" y="${round1(y(v) + 4)}">${count(v)}</text>`)}</g>
<g font-size="${size.font}" fill="#52514e" text-anchor="middle">${xTicks.map((t) => html`<text x="${round1(x(t.x))}" y="${size.h - 6}">${t.label}</text>`)}</g>
${typeof reference === 'number' ? html`<path d="M${size.left} ${round1(y(reference))}L${size.w - size.right} ${round1(y(reference))}" fill="none" stroke="#52514e" stroke-width="1.5" stroke-dasharray="6 5"></path>` : ''}
${series.map((s) => (s.expected ? html`<path d="${pathOf(s.expected)}" fill="none" stroke="${s.color}" stroke-width="1.5" stroke-dasharray="6 5" opacity=".75"></path>` : ''))}
${series.map((s) => html`<path d="${pathOf(s.values)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>`)}
${ends.map(({ s, end }) => (end ? html`<circle cx="${round1(x(end.at))}" cy="${round1(y(end.v))}" r="4.5" fill="${s.color}" stroke="#fff" stroke-width="2"></circle>` : ''))}
${ends.map(({ s, end }) =>
  endLabel(
    s.name,
    end,
    ends.filter((o) => o.s !== s).map((o) => o.end),
  ),
)}
<line class="cross" x1="0" x2="0" y1="${size.top}" y2="${size.h - size.bottom}" stroke="#52514e" stroke-width="1" visibility="hidden"></line>
</svg>`;
}

export const chartPlot = (input: ChartInput) => html`<div class="plot">${draw(input, SIZES.desk, 'desk')}${draw(input, SIZES.phone, 'phone')}<div class="tip" id="tip" hidden></div></div>`;

export const chartLegend = (input: ChartInput) =>
  html`<div class="legend">${input.series.map((s) => html`<span><i class="swatch ${s.swatch}"></i>${s.name}</span>`)}${input.series.some((s) => s.expected) || typeof input.reference === 'number' ? html`<span><i class="swatch dash"></i>Expected</span>` : ''}</div>`;

// The hover: a crosshair and one readout for every series at the nearest point. The readout's
// text goes in as text, never as HTML.
export const CHART_SCRIPT = raw(`<script>
(function () {
  function pointsOf(svg) { return JSON.parse(svg.getAttribute('data-points')); }
  function showAt(svg, index) {
    var points = pointsOf(svg);
    var at = Math.max(0, Math.min(points.length - 1, index));
    var p = points[at];
    svg.dataset.at = at;
    var cross = svg.querySelector('.cross');
    cross.setAttribute('x1', p.x);
    cross.setAttribute('x2', p.x);
    cross.setAttribute('visibility', 'visible');
    var tip = document.getElementById('tip');
    tip.textContent = '';
    var title = document.createElement('b');
    title.textContent = p.t;
    tip.appendChild(title);
    p.r.forEach(function (r) {
      var div = document.createElement('div');
      var key = document.createElement('i');
      key.className = 'swatch ' + r[0];
      var strong = document.createElement('strong');
      strong.textContent = r[1].toLocaleString();
      div.appendChild(key);
      div.appendChild(strong);
      div.appendChild(document.createTextNode(' ' + r[2]));
      tip.appendChild(div);
    });
    tip.hidden = false;
    var box = svg.getBoundingClientRect();
    var left = (p.x / svg.viewBox.baseVal.width) * box.width;
    var width = tip.offsetWidth;
    tip.style.left = (left + 12 + width > box.width ? Math.max(0, left - width - 12) : left + 12) + 'px';
  }
  function hide(svg) {
    svg.querySelector('.cross').setAttribute('visibility', 'hidden');
    document.getElementById('tip').hidden = true;
    delete svg.dataset.at;
  }
  function nearest(svg, clientX) {
    var points = pointsOf(svg);
    var box = svg.getBoundingClientRect();
    var at = ((clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
    var best = 0;
    points.forEach(function (p, i) { if (Math.abs(p.x - at) < Math.abs(points[best].x - at)) best = i; });
    return best;
  }
  function chartOf(e) { return e.target.closest ? e.target.closest('.plot svg') : null; }
  document.addEventListener('pointermove', function (e) {
    var svg = chartOf(e);
    if (svg) showAt(svg, nearest(svg, e.clientX));
  });
  document.addEventListener('pointerout', function (e) {
    var svg = chartOf(e);
    if (svg && !svg.contains(e.relatedTarget)) hide(svg);
  });
  document.addEventListener('focusin', function (e) {
    var svg = chartOf(e);
    if (svg) showAt(svg, pointsOf(svg).length - 1);
  });
  document.addEventListener('focusout', function (e) {
    var svg = chartOf(e);
    if (svg) hide(svg);
  });
  document.addEventListener('keydown', function (e) {
    var svg = chartOf(e);
    if (!svg || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    showAt(svg, Number(svg.dataset.at || 0) + (e.key === 'ArrowLeft' ? -1 : 1));
  });
})();
</script>`);
