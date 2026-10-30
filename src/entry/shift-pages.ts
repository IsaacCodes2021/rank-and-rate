// A supervisor's phone screens for the night (D029, D032): start shift, the 15-minute update and
// the final update. Plain server-rendered HTML with a small script, like the other entry screens (D110).
// Every screen names its sort in the heading and sends that sort with each save, so numbers can
// only ever go to the sort on the screen (D115).
import { html, raw } from 'hono/html';
import { SORTS, type LineInfo } from '../data/night.ts';
import type { MyShift, ShiftLine } from '../data/shift.ts';
import { quarterHourSlot } from '../scoring/index.ts';
import { clock, clockOf, count } from '../format.ts';
import { layout } from './pages.ts';

const oneDecimal = (n: number) => String(Math.round(n * 10) / 10);

function soFar(line: ShiftLine) {
  if (line.lastAt === null) return 'No updates yet';
  const parts = [];
  if (line.lastHeadcount !== null) parts.push(`${line.lastHeadcount} people`);
  parts.push(`${count(line.volume)} pieces at ${clockOf(line.lastAt)}`);
  parts.push(line.pph === null ? 'no PPH yet' : `${count(Math.round(line.pph))} PPH`);
  return `Last: ${parts.join(' · ')}`;
}

// Shared by every screen here. "bad" rows come from the server's answer, so the browser never
// needs its own copy of the rules.
const COMMON_SCRIPT = raw(`<script>
var msg = document.getElementById('msg');
function show(kind, text) { if (!msg) return; msg.className = text ? 'msg ' + kind : ''; msg.textContent = text; }
function post(url, body, button, done) {
  button.disabled = true;
  show('info', 'Saving...');
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (res) {
      if (res.status === 401) { show('err', 'Your sign-in ran out. Nothing was saved. Open the sign-in page in a new tab, then come back and save again.'); return; }
      return res.json().then(function (data) {
        if (res.ok) { done(data); return; }
        var errors = data.errors || [{ lineId: null, message: data.error || 'Could not save.' }];
        errors.forEach(function (er) {
          var tr = document.querySelector('tr[data-line="' + er.lineId + '"]');
          if (tr) tr.classList.add('bad');
        });
        show('err', 'Nothing was saved. ' + errors.map(function (er) { return (er.lineId ? er.lineId + ': ' : '') + er.message; }).join(' '));
        var first = document.querySelector('tr.bad input');
        if (first) first.focus();
      });
    })
    .catch(function () { show('err', 'No connection. Nothing was saved; try again.'); })
    .then(function () { button.disabled = false; });
}
// The keypad's Next moves on, and its Done on the last box saves, so there is no extra tap to find Save.
function nextOnEnter(inputs, save) {
  inputs.forEach(function (el, i) {
    el.addEventListener('input', function () { el.closest('tr').classList.remove('bad'); });
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (inputs[i + 1]) inputs[i + 1].focus(); else save.click();
    });
  });
}
function focusFirstBlank(inputs) {
  var blank = inputs.filter(function (el) { return el.value === ''; })[0];
  if (blank) blank.focus();
}
function lowerThanLast(lineId, typed, lastVolume) {
  return typed !== '' && lastVolume !== '' && Number(typed) < Number(lastVolume)
    ? lineId + ' (last ' + Number(lastVolume).toLocaleString() + ')' : null;
}
['sign-out', 'looks-right'].forEach(function (id) {
  var button = document.getElementById(id);
  if (button) button.addEventListener('click', function () {
    fetch('/api/supervisor/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function () { location.href = '/sign-in'; });
  });
});
</script>`);

const header = (title: string, name: string) => html`<div class="top"><h1>${title}</h1><button type="button" class="link" id="sign-out">Sign out</button></div>
<p class="sub">Signed in as <strong>${name}</strong></p>`;

// Links to this supervisor's other open sorts, so the next sort is one tap away.
const otherSorts = (others: MyShift[]) =>
  others.length ? html`<p class="sub">Also open: ${others.map((s, i) => html`${i ? ', ' : ''}<a class="link" href="/shift/${s.id}">${s.sort}</a>`)}</p>` : '';

const START_SCRIPT = raw(`<script>
(function () {
  var form = document.getElementById('start-shift');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var lines = Array.prototype.map.call(form.querySelectorAll('input[name=line]:checked'), function (el) { return el.value; });
    var button = form.querySelector('button[type=submit]');
    if (form.dataset.shift) {
      post('/api/supervisor/shift/lines', { shiftId: Number(form.dataset.shift), lines: lines }, button, function () { location.href = '/shift'; });
      return;
    }
    var sort = form.querySelector('input[name=sort]:checked');
    if (!sort) { show('err', 'Choose the sort first.'); return; }
    if (lines.length === 0) { show('err', 'Pick at least one line.'); return; }
    post('/api/supervisor/shift', { sort: sort.value, lines: lines }, button, function (data) { location.href = '/shift/' + data.shiftId; });
  });
})();
</script>`);

export type StartPageInput = { name: string; lines: LineInfo[]; current?: MyShift | null; ticked?: string[]; finished?: MyShift[]; canGoBack?: boolean };

// With a current sort it changes that sort's lines; a line with this supervisor's entries stays.
// Otherwise the lines from last time start ticked. The sort is never picked for them: a wrong
// guess would put numbers in the wrong sort without anyone noticing (D115).
export function startShiftPage({ name, lines, current, ticked = [], finished = [], canGoBack }: StartPageInput) {
  const groups = ['PS', 'PD'].map((type) => ({ type, lines: lines.filter((l) => l.type === type) }));
  const onShift = (id: string) => current?.lines.find((l) => l.lineId === id);
  const pick = (l: LineInfo) => {
    const line = onShift(l.id);
    const checked = line || (!current && ticked.includes(l.id));
    return html`<label class="pick"><input type="checkbox" name="line" value="${l.id}"${checked ? raw(' checked') : ''}${line?.hasMyEntries ? raw(' disabled') : ''}><span>${l.id}</span></label>`;
  };
  const title = current ? `${current.sort} lines` : 'Start shift';
  return layout(
    title,
    html`<main>
${header(title, name)}
${finished.length ? html`<p class="sub" id="finished">Finished: ${finished.map((s, i) => html`${i ? ', ' : ''}<a class="link" href="/shift/${s.id}">${s.sort}</a>`)}</p>` : ''}
<form id="start-shift"${current ? html` data-shift="${current.id}"` : ''} novalidate>
${
  current
    ? html`<p class="sub">${current.sort}, ${current.date}. Untick every line to leave this sort. A line you have entered numbers on stays.</p>`
    : html`<label>Sort</label>
<div class="picks sorts">${SORTS.map((s) => html`<label class="pick"><input type="radio" name="sort" value="${s}"><span>${s}</span></label>`)}</div>`
}
${groups.map((g) => (g.lines.length ? html`<label>${g.type} lines</label><div class="picks">${g.lines.map(pick)}</div>` : ''))}
<div id="msg" role="alert"></div>
<p><button type="submit">${current ? 'Save my lines' : 'Start shift'}</button></p>
</form>
${canGoBack ? html`<div class="more"><a class="link" href="${current ? `/shift/${current.id}` : '/shift'}">Back</a></div>` : ''}
</main>
${COMMON_SCRIPT}
${START_SCRIPT}`,
  );
}

// When more than one sort is open, this is where a supervisor chooses which to work on.
export function sortsPage({ name, shifts }: { name: string; shifts: MyShift[] }) {
  return layout(
    'Your sorts',
    html`<main>
${header('Your sorts', name)}
<table>
<thead><tr><th>Sort</th><th>Lines</th><th>Finals</th></tr></thead>
<tbody>
${shifts.map((s) => {
  const done = s.lines.filter((l) => l.finalVolume !== null).length;
  return html`<tr data-sort="${s.id}"><td><a class="link" href="/shift/${s.id}">${s.sort}</a><div class="sub">${s.date}</div></td><td>${s.lines.map((l) => l.lineId).join(', ')}</td><td>${done} of ${s.lines.length}</td></tr>`;
})}
</tbody>
</table>
<div class="more"><a class="link" href="/shift/start">Start another sort</a></div>
</main>
${COMMON_SCRIPT}`,
  );
}

const UPDATE_SCRIPT = raw(`<script>
(function () {
  var form = document.getElementById('update');
  var save = document.getElementById('save');
  var rows = Array.prototype.slice.call(form.querySelectorAll('tr[data-line]'));
  var inputs = Array.prototype.slice.call(form.querySelectorAll('tbody input'));
  nextOnEnter(inputs, save);
  // Ready to type on arrival, but not straight after a save, when the supervisor is done for now.
  if (!/[?&]saved=/.test(location.search)) focusFirstBlank(inputs);
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var lower = [];
    var payload = rows.map(function (tr) {
      var f = tr.querySelectorAll('input'), head = f[0].value.trim(), volume = f[1].value.trim();
      // People starts filled in from the last update, so no volume and the same people means this row was not touched.
      if (volume === '' && head === tr.dataset.lastHead) head = '';
      var low = lowerThanLast(tr.dataset.line, volume, tr.dataset.lastVolume);
      if (low) lower.push(low);
      return { lineId: tr.dataset.line, headcount: head, volume: volume };
    });
    if (lower.length && !confirm('Running volume goes up through the night. This is lower than your last update: ' + lower.join(', ') + '. Save anyway?')) return;
    post('/api/supervisor/update', { shiftId: Number(form.dataset.shift), rows: payload }, save, function () { location.replace('/shift/' + form.dataset.shift + '?saved=1'); });
  });
})();
</script>`);

export type UpdatePageInput = { name: string; shift: MyShift; others: MyShift[]; now: Date; justSaved?: boolean };

export function updatePage({ name, shift, others, now, justSaved }: UpdatePageInput) {
  const open = shift.lines.filter((l) => l.finalVolume === null);
  const lastOpen = open.length ? open[open.length - 1].lineId : '';
  const closed = shift.lines.filter((l) => l.finalVolume !== null);
  // Says when to come back, so nobody has to keep the app open between updates.
  const next = clock((quarterHourSlot(now.getTime()) + 1) * 15 * 60 * 1000);
  const started = open.some((l) => l.lastAt !== null);
  return layout(
    `${shift.sort} update`,
    html`<main>
${header(`${shift.sort} update`, name)}
<p class="sub">${shift.date}</p>
${otherSorts(others)}
${
  justSaved
    ? html`<p class="msg ok" id="saved">Saved. Next update around ${next}.</p>`
    : started
      ? html`<p class="sub" id="next">Next update around ${next}</p>`
      : ''
}
<form id="update" data-shift="${shift.id}" novalidate>
<table>
<thead><tr><th>Line</th><th>People</th><th>Running volume</th></tr></thead>
<tbody>
${open.map(
  (l) => html`<tr data-line="${l.lineId}" data-last-head="${l.lastHeadcount ?? ''}" data-last-volume="${l.lastVolume ?? ''}">
<td class="line">${l.lineId}</td>
<td><input aria-label="${l.lineId} people" inputmode="numeric" pattern="[0-9]*" enterkeyhint="next" autocomplete="off" value="${l.lastHeadcount ?? ''}"></td>
<td><input aria-label="${l.lineId} running volume" inputmode="numeric" pattern="[0-9]*" enterkeyhint="${l.lineId === lastOpen ? 'done' : 'next'}" autocomplete="off"></td>
</tr>
<tr class="info"><td colspan="3">${soFar(l)}</td></tr>`,
)}
${closed.map((l) => html`<tr class="info"><td colspan="3"><strong>${l.lineId}</strong> final is in: ${count(l.finalVolume as number)} pieces</td></tr>`)}
</tbody>
</table>
<div class="bar">
<div id="msg" role="status" aria-live="polite"></div>
<div class="bar-row"><a class="link" href="/shift/${shift.id}/final">Final update</a><button type="submit" id="save">Save update</button></div>
</div>
</form>
<div class="more"><a class="link" href="/shift/${shift.id}/lines">Change my lines</a><a class="link" href="/shift/start">Start another sort</a></div>
</main>
${COMMON_SCRIPT}
${UPDATE_SCRIPT}`,
  );
}

const FINAL_SCRIPT = raw(`<script>
(function () {
  var form = document.getElementById('final');
  var save = document.getElementById('save');
  var rows = Array.prototype.slice.call(form.querySelectorAll('tr[data-line]'));
  var inputs = Array.prototype.slice.call(form.querySelectorAll('tbody input'));
  nextOnEnter(inputs, save);
  focusFirstBlank(inputs);
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var lower = [];
    var payload = rows.map(function (tr) {
      var volume = tr.querySelector('input').value.trim();
      var low = lowerThanLast(tr.dataset.line, volume, tr.dataset.lastVolume);
      if (low) lower.push(low);
      return { lineId: tr.dataset.line, volume: volume };
    });
    if (lower.length && !confirm('This is lower than your last update: ' + lower.join(', ') + '. Save anyway?')) return;
    post('/api/supervisor/final', { shiftId: Number(form.dataset.shift), rows: payload }, save, function () { location.href = '/shift/' + form.dataset.shift; });
  });
})();
</script>`);

export function finalPage({ name, shift }: { name: string; shift: MyShift }) {
  return layout(
    `${shift.sort} final`,
    html`<main>
${header(`${shift.sort} final`, name)}
<p class="sub">${shift.date}. A line you leave blank stays open.</p>
<form id="final" data-shift="${shift.id}" novalidate>
<table>
<thead><tr><th>Line</th><th>Final volume</th></tr></thead>
<tbody>
${shift.lines.map(
  (l, i) => html`<tr data-line="${l.lineId}" data-last-volume="${l.lastVolume ?? ''}">
<td class="line">${l.lineId}</td>
<td><input aria-label="${l.lineId} final volume" inputmode="numeric" pattern="[0-9]*" enterkeyhint="${i === shift.lines.length - 1 ? 'done' : 'next'}" autocomplete="off" value="${l.finalVolume ?? ''}"></td>
</tr>
<tr class="info"><td colspan="2">${soFar(l)}</td></tr>`,
)}
</tbody>
</table>
<div class="bar">
<div id="msg" role="status" aria-live="polite"></div>
<div class="bar-row"><a class="link" href="/shift/${shift.id}">Back</a><button type="submit" id="save">Save final</button></div>
</div>
</form>
</main>
${COMMON_SCRIPT}
${FINAL_SCRIPT}`,
  );
}

// The last step of a supervisor's night: check the numbers, then one tap and they are done.
// If another sort is open they go on to it, so they do not have to sign in again.
export function shiftDonePage({ name, shift, others }: { name: string; shift: MyShift; others: MyShift[] }) {
  const title = `${shift.sort}: check your numbers`;
  return layout(
    title,
    html`<main>
${header(title, name)}
<p class="sub">${shift.date}</p>
${otherSorts(others)}
<table>
<thead><tr><th>Line</th><th>Hours</th><th>Volume</th><th>PPH</th></tr></thead>
<tbody>
${shift.lines.map(
  (l) => html`<tr data-done><td class="line">${l.lineId}</td><td>${oneDecimal(l.hours)}</td><td>${count(l.volume)}</td><td>${l.pph === null ? '-' : count(Math.round(l.pph))}</td></tr>`,
)}
</tbody>
</table>
<p>${
      others.length
        ? html`<a class="button" id="go-on" href="/shift/${others[0].id}">Looks right, go to ${others[0].sort}</a>`
        : html`<button type="button" id="looks-right">Looks right, sign out</button>`
    }</p>
<div class="more"><a class="link" href="/shift/${shift.id}/final">Change a number</a><a class="link" href="/shift/start">Start another sort</a></div>
</main>
${COMMON_SCRIPT}`,
  );
}
