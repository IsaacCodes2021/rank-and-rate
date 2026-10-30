// The phone screens: admin sign-in, the end-of-night totals screen (D065), adding supervisors,
// and supervisor sign-in (D111). Plain server-rendered HTML with a small script, so the page
// stays tiny and needs no build step (D110). Large text and tap targets, number keypads, no
// sideways scrolling.
import { html, raw } from 'hono/html';
import { SORTS, type LineInfo } from '../data/night.ts';
import { ROLES, type Role, type SupervisorInfo } from '../data/supervisor.ts';

const STYLE = raw(`<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 18px/1.4 system-ui, sans-serif; color: #111; background: #fff; }
  main { max-width: 560px; margin: 0 auto; padding: 16px 16px 0; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  label { display: block; font-weight: 600; margin: 12px 0 4px; }
  input, select, button { font: inherit; font-size: 18px; }
  input, select { width: 100%; min-height: 48px; padding: 8px 10px; border: 2px solid #555; border-radius: 6px; background: #fff; color: #111; }
  input:focus, select:focus, button:focus { outline: 3px solid #0a58ca; outline-offset: 1px; }
  button { min-height: 48px; padding: 0 22px; border: 0; border-radius: 6px; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
  button:disabled { background: #777; }
  .top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { position: sticky; top: 0; background: #fff; text-align: left; font-size: 15px; padding: 6px 4px; border-bottom: 2px solid #111; }
  td { padding: 4px; }
  td.line { width: 64px; font-weight: 700; }
  tr.group td { padding-top: 16px; font-size: 15px; font-weight: 700; color: #444; }
  tr.bad input { border-color: #b00020; background: #fff5f5; }
  .bar { position: sticky; bottom: 0; background: #fff; border-top: 2px solid #111; padding: 10px 16px 12px; margin: 16px -16px 0; }
  .bar-row { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  .totals { font-size: 15px; }
  .msg { margin: 0 0 10px; padding: 10px; border-radius: 6px; font-size: 16px; }
  .msg.ok { background: #e7f6ec; border: 2px solid #1e7b34; }
  .msg.err { background: #fff5f5; border: 2px solid #b00020; }
  .msg.info { background: #eef3fb; border: 2px solid #0a58ca; }
  .link { background: none; color: #0a58ca; padding: 0 4px; min-height: 44px; text-decoration: underline; font-weight: 400; }
  .links { display: flex; gap: 8px; align-items: baseline; white-space: nowrap; }
</style>`);

function layout(title: string, body: unknown) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
${STYLE}
</head>
<body>
${body}
</body>
</html>`;
}

const SIGN_IN_SCRIPT = raw(`<script>
(function () {
  var form = document.getElementById('sign-in');
  var msg = document.getElementById('msg');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var button = form.querySelector('button');
    button.disabled = true;
    msg.className = 'msg info';
    msg.textContent = 'Checking...';
    fetch('/api/admin/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: document.getElementById('code').value })
    }).then(function (res) {
      if (res.ok) { location.reload(); return; }
      return res.json().then(function (body) {
        msg.className = 'msg err';
        msg.textContent = body.error || 'Could not sign in.';
        button.disabled = false;
      });
    }).catch(function () {
      msg.className = 'msg err';
      msg.textContent = 'No connection. Try again.';
      button.disabled = false;
    });
  });
})();
</script>`);

export function signInPage() {
  return layout(
    'Rank and Rate admin',
    html`<main>
<h1>Rank and Rate admin</h1>
<form id="sign-in">
<label for="code">Admin code</label>
<input id="code" name="code" type="password" autocomplete="current-password" required autofocus>
<div id="msg" role="alert"></div>
<p><button type="submit">Sign in</button></p>
</form>
</main>
${SIGN_IN_SCRIPT}`,
  );
}

const NIGHT_SCRIPT = raw(`<script>
(function () {
  var form = document.getElementById('night');
  var msg = document.getElementById('msg');
  var totals = document.getElementById('totals');
  var dateEl = document.getElementById('date');
  var sortEl = document.getElementById('sort');
  var saveBtn = document.getElementById('save');
  var rows = Array.prototype.slice.call(form.querySelectorAll('tr[data-line]'));
  var inputs = Array.prototype.slice.call(form.querySelectorAll('tbody input'));
  var current = { date: dateEl.value, sort: sortEl.value };

  function val(el) { return el.value.trim(); }
  function num(s) { return s === '' || !isFinite(Number(s)) ? null : Number(s); }
  function show(kind, text) { msg.className = text ? 'msg ' + kind : ''; msg.textContent = text; }
  function fieldsOf(tr) { return tr.querySelectorAll('input'); }
  function dirty() { return inputs.some(function (el) { return el.value !== el.dataset.saved; }); }

  function update() {
    var h = 0, v = 0, filled = 0;
    rows.forEach(function (tr) {
      var f = fieldsOf(tr), hh = num(val(f[0])), vv = num(val(f[1]));
      if (val(f[0]) !== '' || val(f[1]) !== '') filled++;
      if (hh !== null) h += hh;
      if (vv !== null) v += vv;
    });
    totals.textContent = filled + ' of ' + rows.length + ' lines \\u00b7 ' + (Math.round(h * 100) / 100) + ' hrs \\u00b7 ' + v.toLocaleString() + ' pieces';
  }

  inputs.forEach(function (el, i) {
    el.dataset.saved = '';
    el.addEventListener('input', function () { el.closest('tr').classList.remove('bad'); update(); });
    // The keypad's Next (or Enter) moves hours -> volume -> next line, so a whole night goes in
    // without leaving the keypad. On iPhone the arrows above the keypad do the same.
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var next = inputs[i + 1];
      if (next) next.focus(); else saveBtn.focus();
    });
  });

  function load() {
    if (!dateEl.value || !sortEl.value) { current = { date: dateEl.value, sort: sortEl.value }; return; }
    if (dirty() && !confirm('Show the saved numbers for ' + dateEl.value + ' ' + sortEl.value + '? Numbers you have not saved will be cleared.')) {
      dateEl.value = current.date; sortEl.value = current.sort; return;
    }
    current = { date: dateEl.value, sort: sortEl.value };
    show('info', 'Loading...');
    fetch('/api/admin/night?date=' + encodeURIComponent(dateEl.value) + '&sort=' + encodeURIComponent(sortEl.value))
      .then(function (res) {
        if (res.status === 401) { location.reload(); return; }
        return res.json().then(function (body) {
          if (!res.ok) { show('err', 'Could not load: ' + (body.errors || []).map(function (e) { return e.message; }).join(' ')); return; }
          var saved = {};
          body.rows.forEach(function (r) { saved[r.lineId] = r; });
          rows.forEach(function (tr) {
            var r = saved[tr.dataset.line], f = fieldsOf(tr);
            f[0].value = r ? String(r.hours) : '';
            f[1].value = r ? String(r.volume) : '';
            f[0].dataset.saved = f[0].value;
            f[1].dataset.saved = f[1].value;
            tr.classList.remove('bad');
          });
          update();
          show('info', body.rows.length ? body.rows.length + ' lines are already saved for this sort. Change any number and press Save.' : '');
        });
      })
      .catch(function () { show('err', 'No connection. Try again.'); });
  }
  dateEl.addEventListener('change', load);
  sortEl.addEventListener('change', load);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!sortEl.value) { show('err', 'Choose the sort first.'); sortEl.focus(); return; }
    var payload = {
      date: dateEl.value,
      sort: sortEl.value,
      rows: rows.map(function (tr) { var f = fieldsOf(tr); return { lineId: tr.dataset.line, hours: val(f[0]), volume: val(f[1]) }; })
    };
    saveBtn.disabled = true;
    show('info', 'Saving...');
    fetch('/api/admin/night', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (res) {
        if (res.status === 401) { show('err', 'Your sign-in ran out. Nothing was saved. Open this page in a new tab, sign in, then come back and press Save.'); return; }
        return res.json().then(function (body) {
          if (res.ok) {
            inputs.forEach(function (el) { el.dataset.saved = el.value; });
            var lines = body.created + body.updated + body.unchanged;
            show('ok', 'Saved ' + lines + ' lines for ' + payload.date + ' ' + payload.sort + ' (' + body.created + ' new, ' + body.updated + ' changed).');
            return;
          }
          var errors = body.errors || [{ lineId: null, message: body.error || 'Could not save.' }];
          errors.forEach(function (er) {
            rows.forEach(function (tr) { if (tr.dataset.line === er.lineId) tr.classList.add('bad'); });
          });
          show('err', 'Nothing was saved. ' + errors.map(function (er) { return (er.lineId ? er.lineId + ': ' : '') + er.message; }).join(' '));
          var first = form.querySelector('tr.bad input');
          if (first) first.focus();
        });
      })
      .catch(function () { show('err', 'No connection. Nothing was saved; try again.'); })
      .then(function () { saveBtn.disabled = false; });
  });

  document.getElementById('sign-out').addEventListener('click', function () {
    if (dirty() && !confirm('Sign out? Numbers you have not saved will be lost.')) return;
    fetch('/api/admin/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function () { location.reload(); });
  });

  update();
})();
</script>`);

export function nightPage({ lines, today }: { lines: LineInfo[]; today: string }) {
  const groups = ['PS', 'PD'].map((type) => ({ type, lines: lines.filter((l) => l.type === type) }));
  const lastId = lines.length ? lines[lines.length - 1].id : '';
  const lineRow = (l: LineInfo) => html`<tr data-line="${l.id}">
<td class="line">${l.id}</td>
<td><input aria-label="${l.id} total hours" inputmode="decimal" enterkeyhint="next" autocomplete="off"></td>
<td><input aria-label="${l.id} volume" inputmode="numeric" pattern="[0-9]*" enterkeyhint="${l.id === lastId ? 'done' : 'next'}" autocomplete="off"></td>
</tr>`;

  return layout(
    'Night totals',
    html`<main>
<div class="top"><h1>Night totals</h1><div class="links"><a class="link" href="/admin/supervisors">Supervisors</a><button type="button" class="link" id="sign-out">Sign out</button></div></div>
<form id="night" novalidate>
<div class="pair">
<div><label for="date">Date</label><input id="date" type="date" value="${today}" required></div>
<div><label for="sort">Sort</label><select id="sort" required><option value="">Choose</option>${SORTS.map((s) => html`<option>${s}</option>`)}</select></div>
</div>
<table>
<thead><tr><th>Line</th><th>Total hrs</th><th>Volume</th></tr></thead>
<tbody>
${groups.map((g) => (g.lines.length ? html`<tr class="group"><td colspan="3">${g.type} lines</td></tr>${g.lines.map(lineRow)}` : ''))}
</tbody>
</table>
<div class="bar">
<div id="msg" role="status" aria-live="polite"></div>
<div class="bar-row"><span class="totals" id="totals"></span><button type="submit" id="save">Save</button></div>
</div>
</form>
</main>
${NIGHT_SCRIPT}`,
  );
}

const ROLE_LABEL: Record<Role, string> = { part_time: 'Part-time', full_time: 'Full-time' };

const SUPERVISORS_SCRIPT = raw(`<script>
(function () {
  var form = document.getElementById('add-supervisor');
  var msg = document.getElementById('msg');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var button = form.querySelector('button');
    button.disabled = true;
    msg.className = 'msg info';
    msg.textContent = 'Adding...';
    fetch('/api/admin/supervisors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('name').value,
        pin: document.getElementById('pin').value,
        role: document.getElementById('role').value
      })
    }).then(function (res) {
      if (res.ok) { location.reload(); return; }
      if (res.status === 401) { location.href = '/admin'; return; }
      return res.json().then(function (body) {
        msg.className = 'msg err';
        msg.textContent = (body.errors || []).map(function (er) { return er.message; }).join(' ') || 'Could not add.';
        button.disabled = false;
      });
    }).catch(function () {
      msg.className = 'msg err';
      msg.textContent = 'No connection. Try again.';
      button.disabled = false;
    });
  });
})();
</script>`);

// The ID number is left visible here so the admin can see a typo before adding; it is never shown again.
export function supervisorsPage({ supervisors }: { supervisors: SupervisorInfo[] }) {
  return layout(
    'Supervisors',
    html`<main>
<div class="top"><h1>Supervisors</h1><a class="link" href="/admin">Night totals</a></div>
<form id="add-supervisor">
<label for="name">Full name</label>
<input id="name" autocapitalize="words" autocomplete="off" maxlength="80" required>
<label for="pin">ID number</label>
<input id="pin" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="12" required>
<label for="role">Role</label>
<select id="role">${ROLES.map((r) => html`<option value="${r}">${ROLE_LABEL[r]}</option>`)}</select>
<div id="msg" role="alert"></div>
<p><button type="submit">Add supervisor</button></p>
</form>
${
  supervisors.length
    ? html`<table>
<thead><tr><th>Name</th><th>Role</th></tr></thead>
<tbody>${supervisors.map((s) => html`<tr data-supervisor><td>${s.name}</td><td>${ROLE_LABEL[s.role]}</td></tr>`)}</tbody>
</table>`
    : html`<p>No supervisors yet.</p>`
}
</main>
${SUPERVISORS_SCRIPT}`,
  );
}

const SUPERVISOR_SIGN_IN_SCRIPT = raw(`<script>
(function () {
  var form = document.getElementById('supervisor-sign-in');
  var msg = document.getElementById('msg');
  var nameEl = document.getElementById('name');
  var pinEl = document.getElementById('pin');
  nameEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); pinEl.focus(); }
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var button = form.querySelector('button');
    button.disabled = true;
    msg.className = 'msg info';
    msg.textContent = 'Checking...';
    fetch('/api/supervisor/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: nameEl.value, pin: pinEl.value })
    }).then(function (res) {
      if (res.ok) { location.reload(); return; }
      return res.json().then(function (body) {
        msg.className = 'msg err';
        msg.textContent = body.error || 'Could not sign in.';
        pinEl.value = '';
        pinEl.focus();
        button.disabled = false;
      });
    }).catch(function () {
      msg.className = 'msg err';
      msg.textContent = 'No connection. Try again.';
      button.disabled = false;
    });
  });
})();
</script>`);

export function supervisorSignInPage() {
  return layout(
    'Supervisor sign-in',
    html`<main>
<h1>Supervisor sign-in</h1>
<form id="supervisor-sign-in">
<label for="name">Full name</label>
<input id="name" autocapitalize="words" autocomplete="name" enterkeyhint="next" required autofocus>
<label for="pin">ID number</label>
<input id="pin" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="off" enterkeyhint="go" required>
<div id="msg" role="alert"></div>
<p><button type="submit">Sign in</button></p>
</form>
</main>
${SUPERVISOR_SIGN_IN_SCRIPT}`,
  );
}

const SUPERVISOR_HOME_SCRIPT = raw(`<script>
document.getElementById('sign-out').addEventListener('click', function () {
  fetch('/api/supervisor/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(function () { location.reload(); });
});
</script>`);

// A stand-in until the start-shift screen exists.
export function supervisorHomePage({ name }: { name: string }) {
  return layout(
    'Signed in',
    html`<main>
<div class="top"><h1>Signed in</h1><button type="button" class="link" id="sign-out">Sign out</button></div>
<p>You are signed in as <strong id="who">${name}</strong> for 12 hours on this phone.</p>
<p>The shift screens are not built yet.</p>
</main>
${SUPERVISOR_HOME_SCRIPT}`,
  );
}
