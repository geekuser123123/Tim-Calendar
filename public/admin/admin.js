// Calendar admin panel (vanilla JS, no build step).
const app = document.getElementById('app');
const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { tab: 'bookings', settings: null, eventTypes: [], overrides: [], ghlKeySet: false, baseUrl: location.origin, ghlLookup: null };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/admin/login') { showLogin(); throw new Error('Please log in.'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3200);
}

async function withBusy(btn, fn) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Working…'; }
  try { await fn(); } catch (e) { toast(e.message, true); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}

function fmtWhen(ms, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms));
}

// ---------- login ----------
function showLogin(msg = '') {
  app.innerHTML = `<div class="card login">
    <h2>Calendar admin</h2><p class="hint">Enter the admin password.</p>
    ${msg ? `<div class="error">${esc(msg)}</div>` : ''}
    <form class="row" style="margin-top:12px"><input class="field" type="password" name="password" autocomplete="current-password" required autofocus>
    <button class="btn">Log in</button></form></div>`;
  app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: new FormData(e.target).get('password') } });
      boot();
    } catch (err) { showLogin(err.message); }
  };
}

// ---------- shell ----------
const TABS = [['bookings', 'Bookings'], ['sessions', 'Sessions'], ['availability', 'Availability'], ['share', 'Share & embed'], ['settings', 'Settings']];
function shell() {
  app.innerHTML = `<header><div class="bar"><h1>${esc(state.settings.host.name)}'s Calendar</h1>
    <nav>${TABS.map(([k, l]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
    <button class="btn secondary small" id="logout">Log out</button></div></header><main id="view"></main>`;
  app.querySelector('nav').onclick = (e) => {
    const k = e.target.dataset.tab;
    if (!k) return;
    state.tab = k;
    location.hash = k;
    shell();
  };
  document.getElementById('logout').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }); showLogin(); };
  ({ bookings: viewBookings, sessions: viewSessions, availability: viewAvailability, share: viewShare, settings: viewSettings })[state.tab]();
}
const view = () => document.getElementById('view');

// ---------- bookings ----------
let bookingScope = 'upcoming';
let bookingQuery = '';
async function viewBookings() {
  const tz = state.settings.host.timezone;
  view().innerHTML = `<div class="card">
    <div class="row"><h2 style="margin-right:auto">Bookings</h2>
      <select class="field" id="scope" style="width:auto">${['upcoming', 'past', 'cancelled'].map((s) => `<option ${s === bookingScope ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <input class="field" id="q" placeholder="Search name, email, phone" style="width:240px" value="${esc(bookingQuery)}">
    </div>
    <p class="hint">Times shown in ${esc(tz)}.</p>
    <div id="list"><p class="muted">Loading…</p></div></div>`;
  document.getElementById('scope').onchange = (e) => { bookingScope = e.target.value; viewBookings(); };
  let deb;
  document.getElementById('q').oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => { bookingQuery = e.target.value; load(); }, 300); };

  async function load() {
    const list = document.getElementById('list');
    try {
      const { bookings } = await api(`/api/admin/bookings?scope=${bookingScope}&q=${encodeURIComponent(bookingQuery)}`);
      if (!bookings.length) { list.innerHTML = '<p class="muted">No bookings here yet.</p>'; return; }
      list.innerHTML = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Session</th><th>Guest</th><th>GoHighLevel</th><th></th></tr></thead><tbody>
        ${bookings.map((b) => `<tr>
          <td><strong>${esc(fmtWhen(b.start_ms, tz))}</strong>${b.timezone && b.timezone !== tz ? `<div class="muted">Guest: ${esc(fmtWhen(b.start_ms, b.timezone))}</div>` : ''}</td>
          <td>${esc(b.event_title)}${b.cancel_reason ? `<div class="muted">Reason: ${esc(b.cancel_reason)}</div>` : ''}</td>
          <td><strong>${esc(`${b.first_name} ${b.last_name}`)}</strong><div><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></div><div><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></div>
            <ul class="answers">${b.answers.filter((a) => a.value).map((a) => `<li><strong>${esc(a.label)}</strong> ${esc(a.value)}</li>`).join('')}</ul></td>
          <td>${b.ghl_sync_error ? `<span class="pill err" title="${esc(b.ghl_sync_error)}">Sync error</span><div class="muted" style="max-width:220px">${esc(b.ghl_sync_error)}</div>`
    : b.ghl_contact_id ? `<span class="pill ok">Synced</span>${b.ghl_appointment_id ? '' : '<div class="muted">contact only</div>'}`
      : '<span class="pill off">Not synced</span>'}</td>
          <td><div class="row">
            ${b.status === 'confirmed' && b.end_ms > Date.now() ? `<a class="btn secondary small" target="_blank" href="/manage/${esc(b.manage_token)}">Reschedule</a><button class="btn danger small" data-cancel="${b.id}">Cancel</button>` : ''}
            <button class="btn secondary small" data-resync="${b.id}">Re-sync</button></div></td>
        </tr>`).join('')}</tbody></table></div>`;
    } catch (e) { list.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  }
  document.getElementById('list').onclick = (e) => {
    const c = e.target.closest('[data-cancel]');
    const r = e.target.closest('[data-resync]');
    if (c) {
      const reason = prompt('Cancel this booking? Optional message/reason for the guest:', '');
      if (reason === null) return;
      withBusy(c, async () => { await api(`/api/admin/bookings/${c.dataset.cancel}/cancel`, { method: 'POST', body: { reason } }); toast('Booking cancelled'); load(); });
    }
    if (r) withBusy(r, async () => { const { booking } = await api(`/api/admin/bookings/${r.dataset.resync}/resync`, { method: 'POST' }); toast(booking.ghl_sync_error ? `Sync error: ${booking.ghl_sync_error}` : 'Synced to GoHighLevel', Boolean(booking.ghl_sync_error)); load(); });
  };
  load();
}

// ---------- weekly hours editor ----------
function scheduleEditor(container, schedule) {
  const s = JSON.parse(JSON.stringify(schedule || {}));
  function render() {
    container.innerHTML = DAYS.map(([k, label]) => {
      const ivs = s[k] || [];
      return `<div class="day-row"><label class="check"><input type="checkbox" data-day="${k}" ${ivs.length ? 'checked' : ''}> ${label}</label>
        <div class="ivs">${ivs.length ? ivs.map((iv, i) => `<div class="iv">
          <input class="field" type="time" data-k="${k}" data-i="${i}" data-f="start" value="${esc(iv.start)}"> –
          <input class="field" type="time" data-k="${k}" data-i="${i}" data-f="end" value="${esc(iv.end)}">
          <button class="x" title="Remove" data-rm="${k}:${i}">×</button>${i === ivs.length - 1 ? `<button class="btn secondary small" data-add="${k}">+ Add hours</button>` : ''}</div>`).join('')
    : '<span class="muted">Unavailable</span>'}</div></div>`;
    }).join('');
  }
  container.onchange = (e) => {
    const t = e.target;
    if (t.dataset.day) { s[t.dataset.day] = t.checked ? [{ start: '09:00', end: '17:00' }] : []; render(); }
    if (t.dataset.f) s[t.dataset.k][Number(t.dataset.i)][t.dataset.f] = t.value;
  };
  container.onclick = (e) => {
    const t = e.target;
    if (t.dataset.rm) { const [k, i] = t.dataset.rm.split(':'); s[k].splice(Number(i), 1); render(); }
    if (t.dataset.add) { const list = s[t.dataset.add]; const last = list[list.length - 1]; list.push({ start: last?.end || '13:00', end: '17:00' }); render(); }
  };
  render();
  return () => s;
}

// ---------- availability ----------
function viewAvailability() {
  view().innerHTML = `<div class="card"><h2>Weekly hours</h2>
    <p class="hint">When people can book you, in <strong>${esc(state.settings.host.timezone)}</strong>. Every session uses these hours unless it has its own custom hours. If GoHighLevel is connected, anything already on Tim's GHL calendar (including synced Google/Outlook events) is blocked automatically.</p>
    <div id="weekly"></div><div class="row" style="margin-top:14px"><button class="btn" id="saveWeekly">Save weekly hours</button></div></div>
    <div class="card"><h2>Days off &amp; special hours</h2>
    <p class="hint">Block a vacation day, or set different hours for one specific date.</p>
    <form class="row" id="ovForm">
      <input class="field" type="date" name="date" required style="width:auto">
      <select class="field" name="mode" style="width:auto"><option value="off">Day off</option><option value="custom">Custom hours</option></select>
      <span id="ovHours" hidden><input class="field" type="time" name="start" value="09:00" style="width:auto"> – <input class="field" type="time" name="end" value="12:00" style="width:auto"></span>
      <input class="field" name="note" placeholder="Note (optional)" style="width:200px">
      <button class="btn">Add</button>
    </form>
    <div id="ovList" style="margin-top:12px"></div></div>`;
  const getWeekly = scheduleEditor(document.getElementById('weekly'), state.settings.schedule);
  document.getElementById('saveWeekly').onclick = (e) => withBusy(e.target, async () => {
    const r = await api('/api/admin/settings', { method: 'PUT', body: { schedule: getWeekly() } });
    state.settings = r.settings;
    toast('Weekly hours saved');
  });
  const form = document.getElementById('ovForm');
  form.mode.onchange = () => { document.getElementById('ovHours').hidden = form.mode.value !== 'custom'; };
  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    withBusy(form.querySelector('button'), async () => {
      const intervals = fd.get('mode') === 'custom' ? [{ start: fd.get('start'), end: fd.get('end') }] : [];
      const r = await api('/api/admin/overrides', { method: 'PUT', body: { date: fd.get('date'), intervals, note: fd.get('note') } });
      state.overrides = r.overrides;
      renderOv();
      form.reset();
      document.getElementById('ovHours').hidden = true;
      toast('Saved');
    });
  };
  function renderOv() {
    const today = new Date().toISOString().slice(0, 10);
    const list = state.overrides.filter((o) => o.date >= today);
    document.getElementById('ovList').innerHTML = list.length ? `<table><tbody>${list.map((o) => `<tr>
      <td><strong>${esc(new Date(`${o.date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}</strong></td>
      <td>${o.intervals.length ? o.intervals.map((iv) => `${esc(iv.start)}–${esc(iv.end)}`).join(', ') : '<span class="pill off">Day off</span>'}</td>
      <td class="muted">${esc(o.note)}</td><td><button class="btn danger small" data-del="${o.date}">Remove</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No upcoming days off or special hours.</p>';
  }
  document.getElementById('ovList').onclick = (e) => {
    const d = e.target.dataset.del;
    if (d) withBusy(e.target, async () => { const r = await api(`/api/admin/overrides/${d}`, { method: 'DELETE' }); state.overrides = r.overrides; renderOv(); });
  };
  renderOv();
}

// ---------- sessions ----------
function linkFor(et) { return `${state.baseUrl}/${et.slug}`; }

function viewSessions() {
  view().innerHTML = `<div class="card"><div class="row"><h2 style="margin-right:auto">Sessions</h2><button class="btn" id="new">+ New session</button></div>
    <p class="hint">Each session is its own booking page. Turn one off to hide it without deleting it.</p>
    <div class="table-wrap"><table><thead><tr><th>Session</th><th>Length</th><th>Link</th><th>GHL calendar</th><th></th></tr></thead><tbody>
    ${state.eventTypes.map((et) => `<tr>
      <td><strong>${esc(et.title)}</strong> ${et.active ? '' : '<span class="pill off">Off</span>'}</td>
      <td>${et.duration_min} min</td>
      <td><a href="${esc(linkFor(et))}" target="_blank">/${esc(et.slug)}</a></td>
      <td>${et.ghl_calendar_id ? '<span class="pill ok">Linked</span>' : '<span class="pill off">None</span>'}</td>
      <td><button class="btn secondary small" data-edit="${et.id}">Edit</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  document.getElementById('new').onclick = () => editSession(null);
  view().querySelector('tbody').onclick = (e) => {
    const id = e.target.dataset.edit;
    if (id) editSession(state.eventTypes.find((x) => x.id === Number(id)));
  };
}

async function ensureGhlLookup() {
  if (state.ghlLookup || !state.ghlKeySet || !state.settings.ghl.locationId) return state.ghlLookup;
  try { state.ghlLookup = await api('/api/admin/ghl/lookup'); } catch (e) { toast(`GoHighLevel: ${e.message}`, true); }
  return state.ghlLookup;
}

async function editSession(et) {
  const isNew = !et;
  et = et || {
    slug: '', title: '', description: '', duration_min: 30, slot_interval_min: 30, buffer_before_min: 0, buffer_after_min: 15,
    min_notice_min: 720, max_days_ahead: 30, daily_limit: 0, schedule: null, location: '', questions: [], ghl_calendar_id: '',
    ghl_tags: '', ghl_webhook_url: '', redirect_url: '', color: '', active: true, sort_order: state.eventTypes.length + 1,
  };
  const questions = JSON.parse(JSON.stringify(et.questions || []));
  const lookup = await ensureGhlLookup();
  const calField = lookup?.calendars?.length
    ? `<select class="field" name="ghl_calendar_id"><option value="">— Don't create GHL appointments —</option>${lookup.calendars.map((c) => `<option value="${esc(c.id)}" ${c.id === et.ghl_calendar_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
    : `<input class="field" name="ghl_calendar_id" value="${esc(et.ghl_calendar_id)}" placeholder="GHL calendar ID">`;
  const hrs = (m) => (m % 60 === 0 ? m / 60 : (m / 60).toFixed(1));

  view().innerHTML = `<form id="etForm">
    <div class="card"><div class="row"><h2 style="margin-right:auto">${isNew ? 'New session' : `Edit: ${esc(et.title)}`}</h2>
      <button type="button" class="btn secondary" id="cancelEdit">Back</button><button class="btn">Save</button></div></div>
    <div class="card"><h2>Basics</h2><div class="grid2" style="margin-top:12px">
      <label>Title<input class="field" name="title" required value="${esc(et.title)}"></label>
      <label>Link name <small>${esc(state.baseUrl)}/<strong>this-part</strong></small><input class="field" name="slug" required value="${esc(et.slug)}" placeholder="private-strategy-session"></label>
      <label>Length (minutes)<input class="field" type="number" min="5" name="duration_min" value="${et.duration_min}"></label>
      <label>Location / meeting link <small>Zoom link, phone note, or address. Link is only shown after booking.</small><input class="field" name="location" value="${esc(et.location)}"></label>
    </div>
    <label style="margin-top:14px">Description<textarea class="field" name="description">${esc(et.description)}</textarea></label>
    <label class="check" style="margin-top:14px"><input type="checkbox" name="active" ${et.active ? 'checked' : ''}> Booking page is on</label></div>

    <div class="card"><h2>Scheduling rules</h2><div class="grid2" style="margin-top:12px">
      <label>Start times every (minutes)<input class="field" type="number" min="5" name="slot_interval_min" value="${et.slot_interval_min}"></label>
      <label>Break before (minutes)<input class="field" type="number" min="0" name="buffer_before_min" value="${et.buffer_before_min}"></label>
      <label>Break after (minutes)<input class="field" type="number" min="0" name="buffer_after_min" value="${et.buffer_after_min}"></label>
      <label>Minimum notice (hours)<input class="field" type="number" min="0" step="0.5" name="min_notice_h" value="${hrs(et.min_notice_min)}"></label>
      <label>Book up to (days ahead)<input class="field" type="number" min="1" name="max_days_ahead" value="${et.max_days_ahead}"></label>
      <label>Max bookings per day <small>0 = no limit</small><input class="field" type="number" min="0" name="daily_limit" value="${et.daily_limit}"></label>
    </div>
    <label class="check" style="margin-top:14px"><input type="checkbox" id="customHours" ${et.schedule ? 'checked' : ''}> Use custom hours for this session (instead of the default weekly hours)</label>
    <div id="sched" ${et.schedule ? '' : 'hidden'}></div></div>

    <div class="card"><h2>Questions</h2><p class="hint">Name, email and phone are always asked. Add any extra questions here — answers are saved to the GHL contact as a note.</p>
      <div id="qs" style="display:grid;gap:10px"></div><button type="button" class="btn secondary" id="addQ" style="margin-top:10px">+ Add question</button></div>

    <div class="card"><h2>GoHighLevel</h2><p class="hint">Every booking creates/updates the contact in GHL. Pick a GHL calendar to also create the appointment there (this is what triggers your GHL confirmation &amp; reminder workflows).</p>
      <div class="grid2">
        <label>GHL calendar ${state.ghlKeySet ? '' : '<small>(connect GHL in Settings first)</small>'}${calField}</label>
        <label>Tags to add <small>comma separated</small><input class="field" name="ghl_tags" value="${esc(et.ghl_tags)}"></label>
        <label>Workflow inbound webhook URL <small>optional — GHL Workflow → trigger "Inbound Webhook"</small><input class="field" name="ghl_webhook_url" value="${esc(et.ghl_webhook_url)}" placeholder="https://services.leadconnectorhq.com/hooks/…"></label>
        <label>Thank-you page URL <small>optional — send people here after booking</small><input class="field" name="redirect_url" value="${esc(et.redirect_url)}" placeholder="https://iraideas.com/thank-you"></label>
      </div></div>
    ${isNew ? '' : '<div class="card"><button type="button" class="btn danger" id="del">Delete session</button> <span class="muted">Only possible if it has never been booked. Otherwise turn it off.</span></div>'}
  </form>`;

  const form = document.getElementById('etForm');
  let getSched = scheduleEditor(document.getElementById('sched'), et.schedule || state.settings.schedule);
  document.getElementById('customHours').onchange = (e) => { document.getElementById('sched').hidden = !e.target.checked; };
  document.getElementById('cancelEdit').onclick = () => viewSessions();
  if (isNew) form.title.oninput = () => { form.slug.value = form.title.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); };

  const qsEl = document.getElementById('qs');
  function renderQs() {
    qsEl.innerHTML = questions.map((q, i) => `<div class="q" data-i="${i}">
      <div class="row"><input class="field" data-f="label" placeholder="Question" value="${esc(q.label)}" style="flex:1;min-width:200px">
      <select class="field" data-f="type" style="width:auto">${[['text', 'Short answer'], ['textarea', 'Paragraph'], ['select', 'Dropdown']].map(([v, l]) => `<option value="${v}" ${q.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" data-f="required" ${q.required ? 'checked' : ''}> Required</label>
      <button type="button" class="x" data-up="${i}" title="Move up">↑</button><button type="button" class="x" data-rmq="${i}" title="Remove">×</button></div>
      ${q.type === 'select' ? `<label>Options <small>one per line</small><textarea class="field" data-f="options">${esc((q.options || []).join('\n'))}</textarea></label>` : ''}
    </div>`).join('') || '<p class="muted">No extra questions.</p>';
  }
  qsEl.oninput = qsEl.onchange = (e) => {
    const box = e.target.closest('.q');
    const f = e.target.dataset.f;
    if (!box || !f) return;
    const q = questions[Number(box.dataset.i)];
    if (f === 'required') q.required = e.target.checked;
    else if (f === 'options') q.options = e.target.value.split('\n');
    else q[f] = e.target.value;
    if (f === 'type' && e.type === 'change') renderQs();
  };
  qsEl.onclick = (e) => {
    if (e.target.dataset.rmq) { questions.splice(Number(e.target.dataset.rmq), 1); renderQs(); }
    if (e.target.dataset.up) { const i = Number(e.target.dataset.up); if (i > 0) [questions[i - 1], questions[i]] = [questions[i], questions[i - 1]]; renderQs(); }
  };
  document.getElementById('addQ').onclick = () => { questions.push({ id: `q${Date.now().toString(36)}`, label: '', type: 'text', required: false }); renderQs(); };
  renderQs();

  document.getElementById('del')?.addEventListener('click', (e) => {
    if (!confirm(`Delete "${et.title}"?`)) return;
    withBusy(e.target, async () => { await api(`/api/admin/event-types/${et.id}`, { method: 'DELETE' }); await refresh(); toast('Deleted'); viewSessions(); });
  });

  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    body.active = form.active.checked;
    body.min_notice_min = Math.round(Number(fd.get('min_notice_h') || 0) * 60);
    body.schedule = document.getElementById('customHours').checked ? getSched() : null;
    body.questions = questions.map((q) => ({ ...q, options: q.type === 'select' ? (q.options || []).map((o) => o.trim()).filter(Boolean) : undefined }));
    body.color = et.color;
    body.sort_order = et.sort_order;
    withBusy(form.querySelector('button:not([type])'), async () => {
      const r = await api(isNew ? '/api/admin/event-types' : `/api/admin/event-types/${et.id}`, { method: isNew ? 'POST' : 'PUT', body });
      await refresh();
      toast('Session saved');
      editSession(r.eventType);
      getSched = null;
    });
  };
}

// ---------- share & embed ----------
function viewShare() {
  const base = state.baseUrl;
  view().innerHTML = `<div class="card"><h2>How to add the calendar to a page</h2>
    <p class="hint"><strong>WordPress (iraideas.com):</strong> add a "Custom HTML" block (or Elementor "HTML" widget) and paste the inline code.<br>
    <strong>GoHighLevel funnels / sites (therothacademy.com):</strong> add a "Custom JS/HTML" element and paste the inline code.<br>
    Contact info and UTM tags in the page URL (e.g. <code>?email=…&amp;first_name=…</code>) are pre-filled automatically.</p></div>
    ${state.eventTypes.filter((e) => e.active).map((et) => `<div class="card"><h2>${esc(et.title)}</h2>
      <p class="hint">Direct link: <a href="${esc(linkFor(et))}" target="_blank">${esc(linkFor(et))}</a> <button class="btn secondary small" data-copy="${esc(linkFor(et))}">Copy</button></p>
      <details open><summary>Inline calendar (embed on the page)</summary>
        <div class="code">${esc(`<div data-tim-calendar="${et.slug}"></div>\n<script src="${base}/embed.js" async></script>`)}</div>
        <button class="btn secondary small" style="margin-top:6px" data-copy="${esc(`<div data-tim-calendar="${et.slug}"></div>\n<script src="${base}/embed.js" async></script>`)}">Copy code</button></details>
      <details><summary>Popup button</summary>
        <div class="code">${esc(`<a href="#" data-tim-calendar-popup="${et.slug}">Book your session</a>\n<script src="${base}/embed.js" async></script>`)}</div>
        <button class="btn secondary small" style="margin-top:6px" data-copy="${esc(`<a href="#" data-tim-calendar-popup="${et.slug}">Book your session</a>\n<script src="${base}/embed.js" async></script>`)}">Copy code</button></details>
    </div>`).join('')}`;
  view().onclick = (e) => {
    const c = e.target.dataset.copy;
    if (c) navigator.clipboard.writeText(c).then(() => toast('Copied'), () => toast('Copy failed — select and copy manually', true));
  };
}

// ---------- settings ----------
function viewSettings() {
  const { host, branding, ghl } = state.settings;
  const lookup = state.ghlLookup;
  const userField = lookup?.users?.length
    ? `<select class="field" name="userId"><option value="">— Not set —</option>${lookup.users.map((u) => `<option value="${esc(u.id)}" ${u.id === ghl.userId ? 'selected' : ''}>${esc(u.name)} (${esc(u.email)})</option>`).join('')}</select>`
    : `<input class="field" name="userId" value="${esc(ghl.userId)}" placeholder="optional">`;
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = [host.timezone]; }
  view().innerHTML = `<form id="sForm">
    <div class="card"><h2>Profile</h2><div class="grid2" style="margin-top:12px">
      <label>Name shown to guests<input class="field" name="name" value="${esc(host.name)}"></label>
      <label>Title <small>e.g. "Founder, The Roth Academy"</small><input class="field" name="title" value="${esc(host.title)}"></label>
      <label>Photo URL<input class="field" name="photoUrl" value="${esc(host.photoUrl)}"></label>
      <label>Your time zone<select class="field" name="timezone">${zones.map((z) => `<option ${z === host.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
    </div></div>
    <div class="card"><h2>Branding</h2><div class="grid2" style="margin-top:12px">
      <label>Brand name<input class="field" name="brandName" value="${esc(branding.brandName)}"></label>
      <label>Logo URL<input class="field" name="logoUrl" value="${esc(branding.logoUrl)}"></label>
      <label>Main color<input class="field" type="color" name="primaryColor" value="${esc(branding.primaryColor)}"></label>
      <label>Accent color<input class="field" type="color" name="accentColor" value="${esc(branding.accentColor)}"></label>
    </div></div>
    <div class="card"><h2>GoHighLevel connection</h2>
      <p class="hint">API key: ${state.ghlKeySet ? '<span class="pill ok">Set</span>' : '<span class="pill err">Missing</span> — a developer needs to add the <code>GHL_API_KEY</code> secret (see README).'}</p>
      <div class="grid2">
        <label>Location ID <small>GHL → Settings → Business Profile</small><input class="field" name="locationId" value="${esc(ghl.locationId)}"></label>
        <label>Tim's GHL user <small>used to check his busy times &amp; assign appointments</small>${userField}</label>
        <label>Custom field key for reschedule link <small>optional, e.g. <code>contact.booking_manage_link</code></small><input class="field" name="manageLinkFieldKey" value="${esc(ghl.manageLinkFieldKey)}"></label>
      </div>
      <label class="check" style="margin-top:12px"><input type="checkbox" name="blockGhlBusyTimes" ${ghl.blockGhlBusyTimes ? 'checked' : ''}> Block times that are already busy on Tim's GHL calendar (incl. synced Google/Outlook)</label>
      <div class="row" style="margin-top:12px"><button type="button" class="btn secondary" id="testGhl">Test connection</button><span id="ghlStatus" class="muted"></span></div>
    </div>
    <div class="card"><button class="btn">Save settings</button></div></form>`;
  const form = document.getElementById('sForm');
  form.onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form).entries());
    withBusy(form.querySelector('button:not([type])'), async () => {
      const r = await api('/api/admin/settings', {
        method: 'PUT',
        body: {
          host: { name: f.name, title: f.title, photoUrl: f.photoUrl, timezone: f.timezone },
          branding: { brandName: f.brandName, logoUrl: f.logoUrl, primaryColor: f.primaryColor, accentColor: f.accentColor },
          ghl: { locationId: f.locationId, userId: f.userId, manageLinkFieldKey: f.manageLinkFieldKey, blockGhlBusyTimes: form.blockGhlBusyTimes.checked },
        },
      });
      state.settings = r.settings;
      state.ghlLookup = null;
      toast('Settings saved');
    });
  };
  document.getElementById('testGhl').onclick = (e) => withBusy(e.target, async () => {
    const out = document.getElementById('ghlStatus');
    state.ghlLookup = null;
    try {
      state.ghlLookup = await api('/api/admin/ghl/lookup');
      out.textContent = `Connected ✓ — found ${state.ghlLookup.calendars.length} calendars and ${state.ghlLookup.users.length} users. Save, then pick calendars on each session.`;
      viewSettings();
      document.getElementById('ghlStatus').textContent = out.textContent;
    } catch (err) { out.textContent = `Not connected: ${err.message}`; }
  });
}

// ---------- boot ----------
async function refresh() {
  const [s, e, o] = await Promise.all([api('/api/admin/settings'), api('/api/admin/event-types'), api('/api/admin/overrides')]);
  state.settings = s.settings;
  state.ghlKeySet = s.ghlKeySet;
  state.eventTypes = e.eventTypes;
  state.overrides = o.overrides;
}

async function boot() {
  try {
    const me = await api('/api/admin/me');
    state.baseUrl = me.baseUrl;
    await refresh();
  } catch { return; }
  const h = location.hash.slice(1);
  if (TABS.some(([k]) => k === h)) state.tab = h;
  shell();
}
boot();
