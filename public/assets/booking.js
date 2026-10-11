// Booking page: /<event-slug>, /manage/<token>, and / (list of sessions).
const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const EMBED = params.get('embed') === '1';
const FRAME_ID = params.get('frame') || '';
if (EMBED) document.body.classList.add('embed');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  left: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg>',
  check: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>',
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

function guessTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; } catch { return 'America/New_York'; }
}
function allTimeZones(extra) {
  let list = [];
  try { list = Intl.supportedValuesOf('timeZone'); } catch { list = []; }
  for (const z of extra) if (z && !list.includes(z)) list.push(z);
  return list.sort();
}
const fmtCache = new Map();
function fmt(tz, opts) {
  const key = tz + JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }));
  return fmtCache.get(key);
}
function dateKey(ms, tz) {
  const p = Object.fromEntries(fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const timeLabel = (ms, tz) => fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
const longDate = (ms, tz) => fmt(tz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(ms));
const keyLabel = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(Date.UTC(y, m - 1, d));
};
function rangeLabel(startMs, endMs, tz) {
  return `${timeLabel(startMs, tz)} – ${timeLabel(endMs, tz)}, ${longDate(startMs, tz)}`;
}
function tzLabel(tz) {
  try {
    const name = fmt(tz, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
    return `${tz.replace(/_/g, ' ')}${name ? ` (${name})` : ''}`;
  } catch { return tz; }
}

function applyBranding(branding) {
  const root = document.documentElement.style;
  if (branding?.primaryColor) root.setProperty('--primary', branding.primaryColor);
  if (branding?.accentColor) root.setProperty('--accent', branding.accentColor);
}

function post(type, data = {}) {
  if (window.parent !== window) window.parent.postMessage({ source: 'tim-calendar', type, frame: FRAME_ID, ...data }, '*');
}
if (EMBED && 'ResizeObserver' in window) {
  new ResizeObserver(() => post('height', { height: Math.ceil(document.documentElement.scrollHeight) })).observe(document.body);
}

function scrollTop() {
  if (EMBED) post('scroll'); else window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showError(msg) {
  app.innerHTML = `<div class="card"><div class="done"><h2>Hmm…</h2><p class="desc">${esc(msg)}</p></div></div>`;
}

// ---------- shared info panel ----------
function infoPanel(ctx, extra = '') {
  const { host, branding, eventType } = ctx;
  const initials = (host.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `
    <aside class="info">
      ${branding.logoUrl ? `<div class="brand"><img class="logo" src="${esc(branding.logoUrl)}" alt="${esc(branding.brandName)}"></div>` : ''}
      <div class="host">
        ${host.photoUrl ? `<img class="avatar" src="${esc(host.photoUrl)}" alt="">` : `<div class="avatar">${esc(initials)}</div>`}
        <div><div class="host-name">${esc(host.name)}</div>${host.title ? `<div class="host-title">${esc(host.title)}</div>` : ''}</div>
      </div>
      <h1>${esc(eventType.title)}</h1>
      <ul class="meta">
        <li>${icon.clock}<span>${eventType.duration_min} minutes</span></li>
        ${eventType.location ? `<li>${icon.pin}<span>${esc(locationText(eventType.location))}</span></li>` : ''}
      </ul>
      ${eventType.description ? `<div class="desc">${esc(eventType.description)}</div>` : ''}
      ${extra}
    </aside>`;
}
// Don't reveal meeting links before booking; show a friendly label instead.
function locationText(loc) {
  if (/zoom\.us/i.test(loc)) return 'Zoom video call (link sent after booking)';
  if (/meet\.google/i.test(loc)) return 'Google Meet (link sent after booking)';
  if (/teams\.microsoft/i.test(loc)) return 'Microsoft Teams (link sent after booking)';
  if (/^https?:\/\//i.test(loc)) return 'Online meeting (link sent after booking)';
  return loc;
}

// ---------- date/time picker ----------
/**
 * Renders a month calendar + time list into `el`. Calls onPick(ms) when a time is confirmed.
 */
function createPicker(el, ctx, { manageToken = '', onPick, onSelectionChange }) {
  const now = new Date();
  const st = {
    tz: ctx.tz,
    year: now.getFullYear(),
    month: now.getMonth(),
    slots: new Map(), // dateKey -> [ms]
    loaded: new Set(),
    selectedDate: '',
    chosen: 0,
    loading: false,
    autoAdvance: 2,
  };
  const maxMs = Date.now() + (ctx.eventType.max_days_ahead || 60) * 86_400_000;

  async function load() {
    const key = `${st.year}-${st.month}`;
    st.loading = true;
    render();
    try {
      const from = Date.UTC(st.year, st.month, 1) - 86_400_000;
      const to = Date.UTC(st.year, st.month + 1, 1) + 86_400_000;
      const qs = new URLSearchParams({ event: ctx.eventType.slug, start: new Date(from).toISOString(), end: new Date(to).toISOString() });
      if (manageToken) qs.set('manage', manageToken);
      const data = await api(`/api/slots?${qs}`);
      st.raw = (st.raw || []).concat(data.slots.map((s) => Date.parse(s)));
      st.loaded.add(key);
      regroup();
    } catch (e) {
      st.error = e.message;
    }
    st.loading = false;
    const monthPrefix = `${st.year}-${String(st.month + 1).padStart(2, '0')}`;
    const firstAvail = [...st.slots.keys()].filter((k) => k.startsWith(monthPrefix)).sort()[0];
    if (!st.selectedDate && firstAvail) st.selectedDate = firstAvail;
    if (!firstAvail && st.autoAdvance > 0 && Date.UTC(st.year, st.month + 1, 1) < maxMs) {
      st.autoAdvance -= 1;
      return go(1);
    }
    st.autoAdvance = 0;
    render();
  }
  function regroup() {
    st.slots = new Map();
    for (const ms of [...new Set(st.raw || [])].sort((a, b) => a - b)) {
      const k = dateKey(ms, st.tz);
      if (!st.slots.has(k)) st.slots.set(k, []);
      st.slots.get(k).push(ms);
    }
  }
  function go(delta) {
    const d = new Date(st.year, st.month + delta, 1);
    st.year = d.getFullYear();
    st.month = d.getMonth();
    if (!st.loaded.has(`${st.year}-${st.month}`)) return load();
    render();
  }

  function render() {
    const monthPrefix = `${st.year}-${String(st.month + 1).padStart(2, '0')}`;
    const first = new Date(Date.UTC(st.year, st.month, 1));
    const daysIn = new Date(Date.UTC(st.year, st.month + 1, 0)).getUTCDate();
    const todayKey = dateKey(Date.now(), st.tz);
    const canPrev = monthPrefix > todayKey.slice(0, 7);
    const canNext = Date.UTC(st.year, st.month + 1, 1) < maxMs;
    let cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow">${d}</div>`).join('');
    for (let i = 0; i < first.getUTCDay(); i++) cells += '<div></div>';
    for (let d = 1; d <= daysIn; d++) {
      const k = `${monthPrefix}-${String(d).padStart(2, '0')}`;
      const avail = st.slots.has(k);
      cells += `<button type="button" class="day${avail ? ' available' : ''}${k === st.selectedDate ? ' selected' : ''}${k === todayKey ? ' today' : ''}"
        data-date="${k}" ${avail ? '' : 'disabled'} aria-label="${keyLabel(k)}${avail ? ', times available' : ''}">${d}</button>`;
    }
    const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
    const daySlots = st.slots.get(st.selectedDate) || [];
    const zones = allTimeZones([st.tz, ctx.host.timezone]);

    let times;
    if (st.loading) times = '<div class="loading"><span class="spinner"></span></div>';
    else if (st.error) times = `<div class="error">${esc(st.error)}</div>`;
    else if (!st.selectedDate) times = `<p class="empty">${st.slots.size ? 'Pick a day to see open times.' : 'No open times this month — try the next month.'}</p>`;
    else {
      times = `<h3>${keyLabel(st.selectedDate)}</h3><div class="time-list">${daySlots.map((ms) => `
        <div class="slot${ms === st.chosen ? ' chosen' : ''}">
          <button type="button" class="pick" data-ms="${ms}">${timeLabel(ms, st.tz)}</button>
          ${ms === st.chosen ? `<button type="button" class="next" data-confirm="${ms}">Next</button>` : ''}
        </div>`).join('')}</div>`;
    }

    el.innerHTML = `
      <h2>Select a date &amp; time</h2>
      <div class="picker">
        <div>
          <div class="month-head">
            <button type="button" class="nav-btn" data-nav="-1" ${canPrev ? '' : 'disabled'} aria-label="Previous month">${icon.left}</button>
            <strong>${monthName}</strong>
            <button type="button" class="nav-btn" data-nav="1" ${canNext ? '' : 'disabled'} aria-label="Next month">${icon.right}</button>
          </div>
          <div class="grid">${cells}</div>
          <div class="tz">${icon.globe} Time zone
            <select class="tz-select" aria-label="Time zone">${zones.map((z) => `<option value="${esc(z)}" ${z === st.tz ? 'selected' : ''}>${esc(tzLabel(z))}</option>`).join('')}</select>
          </div>
        </div>
        <div class="times">${times}</div>
      </div>`;
  }

  el.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.nav) { st.selectedDate = ''; st.chosen = 0; go(Number(t.dataset.nav)); return; }
    if (t.dataset.date) { st.selectedDate = t.dataset.date; st.chosen = 0; render(); onSelectionChange?.(0); return; }
    if (t.dataset.confirm) { onPick(Number(t.dataset.confirm), st.tz); return; }
    if (t.dataset.ms) { st.chosen = Number(t.dataset.ms); render(); onSelectionChange?.(st.chosen, st.tz); }
  });
  el.addEventListener('change', (e) => {
    if (!e.target.classList.contains('tz-select')) return;
    st.tz = e.target.value;
    ctx.tz = st.tz;
    store.set('tc_tz', st.tz);
    st.chosen = 0;
    const prevSel = st.selectedDate;
    regroup();
    st.selectedDate = st.slots.has(prevSel) ? prevSel : '';
    render();
  });
  load();
}

// ---------- booking flow ----------
function utmFromUrl() {
  const utm = {};
  for (const [k, v] of params) if (/^utm_|^(gclid|fbclid)$/.test(k)) utm[k] = v;
  return utm;
}

async function bookingPage(slug) {
  let ctx;
  try {
    ctx = await api(`/api/event-types/${encodeURIComponent(slug)}`);
  } catch (e) { return showError(e.message); }
  applyBranding(ctx.branding);
  document.title = `${ctx.eventType.title} | ${ctx.host.name}`;
  ctx.tz = store.get('tc_tz') || guessTz();

  const prefill = {
    firstName: params.get('first_name') || (params.get('name') || '').split(' ')[0] || '',
    lastName: params.get('last_name') || (params.get('name') || '').split(' ').slice(1).join(' ') || '',
    email: params.get('email') || '',
    phone: params.get('phone') || '',
  };

  function showPicker() {
    app.innerHTML = `<div class="card"><div class="layout">${infoPanel(ctx, '<div id="sel"></div>')}<section class="main" id="pick"></section></div></div>`;
    createPicker(document.getElementById('pick'), ctx, {
      onSelectionChange: (ms, tz) => {
        document.getElementById('sel').innerHTML = ms ? `<div class="selected-time">${icon.cal} ${esc(rangeLabel(ms, ms + ctx.eventType.duration_min * 60000, tz))}</div>` : '';
      },
      onPick: (ms, tz) => showForm(ms, tz),
    });
  }

  function showForm(ms, tz, errorMsg = '') {
    const et = ctx.eventType;
    const q = et.questions.map((qq) => {
      const name = `q_${qq.id}`;
      const req = qq.required ? 'required' : '';
      const label = `${esc(qq.label)}${qq.required ? ' <span class="req">*</span>' : ''}`;
      if (qq.type === 'textarea') return `<label>${label}<textarea class="field" name="${name}" ${req}></textarea></label>`;
      if (qq.type === 'select') {
        return `<label>${label}<select class="field" name="${name}" ${req}><option value="">Choose…</option>${(qq.options || []).map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>`;
      }
      return `<label>${label}<input class="field" name="${name}" ${req}></label>`;
    }).join('');
    const sel = `<div class="selected-time">${icon.cal} ${esc(rangeLabel(ms, ms + et.duration_min * 60000, tz))}<br><small style="font-weight:400">${esc(tzLabel(tz))}</small></div>`;
    app.innerHTML = `<div class="card"><div class="layout">${infoPanel(ctx, sel)}
      <section class="main">
        <button type="button" class="link-btn back" id="back">${icon.left} Back</button>
        <h2>Enter your details</h2>
        <form class="details" novalidate>
          ${errorMsg ? `<div class="error">${esc(errorMsg)}</div>` : ''}
          <div class="row2">
            <label>First name <span class="req">*</span><input class="field" name="firstName" autocomplete="given-name" required value="${esc(prefill.firstName)}"></label>
            <label>Last name<input class="field" name="lastName" autocomplete="family-name" value="${esc(prefill.lastName)}"></label>
          </div>
          <label>Email <span class="req">*</span><input class="field" type="email" name="email" autocomplete="email" required value="${esc(prefill.email)}"></label>
          <label>Phone <span class="req">*</span><input class="field" type="tel" name="phone" autocomplete="tel" required value="${esc(prefill.phone)}"></label>
          ${q}
          <div><button class="btn" type="submit">Schedule session</button></div>
          <p class="notice">By booking you agree to receive appointment confirmations and reminders by email and text. Reply STOP to opt out.</p>
        </form>
      </section></div></div>`;
    scrollTop();
    document.getElementById('back').onclick = showPicker;
    const form = app.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      for (const k of ['firstName', 'lastName', 'email', 'phone']) prefill[k] = fd.get(k) || '';
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const answers = {};
      for (const qq of et.questions) answers[qq.id] = fd.get(`q_${qq.id}`) || '';
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Booking…';
      try {
        const data = await api('/api/bookings', {
          method: 'POST',
          body: {
            event: et.slug, start: new Date(ms).toISOString(), timezone: tz, ...prefill, answers,
            sourceUrl: params.get('src') || document.referrer || location.href,
            utm: utmFromUrl(),
          },
        });
        post('booked', { booking: data.booking, redirectUrl: data.redirectUrl });
        if (data.redirectUrl) {
          if (EMBED) post('redirect', { url: data.redirectUrl });
          else { location.href = data.redirectUrl; return; }
        }
        showDone(data.booking, tz);
      } catch (err) {
        showForm(ms, tz, err.message);
      }
    };
  }

  showPicker();
}

function googleCalUrl(b) {
  const f = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const qs = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${b.eventType.title} with ${b.host.name}`,
    dates: `${f(b.start)}/${f(b.end)}`,
    details: `Need to reschedule or cancel? ${b.manageUrl}`,
    location: b.eventType.location || '',
  });
  return `https://calendar.google.com/calendar/render?${qs}`;
}

function showDone(b, tz, heading = "You're booked!") {
  const startMs = Date.parse(b.start), endMs = Date.parse(b.end);
  const token = b.manageUrl.split('/').pop();
  app.innerHTML = `<div class="card"><div class="done">
    <div class="check">${icon.check}</div>
    <h1>${esc(heading)}</h1>
    <p class="desc">A confirmation has been sent to <strong>${esc(b.email)}</strong>.</p>
    <div class="summary"><ul class="meta">
      <li>${icon.cal}<span><strong>${esc(b.eventType.title)}</strong> with ${esc(b.host.name)}</span></li>
      <li>${icon.clock}<span>${esc(rangeLabel(startMs, endMs, tz))}</span></li>
      <li>${icon.globe}<span>${esc(tzLabel(tz))}</span></li>
      ${b.eventType.location ? `<li>${icon.pin}<span>${esc(locationText(b.eventType.location))}</span></li>` : ''}
    </ul></div>
    <div class="actions">
      <a class="btn" href="${esc(googleCalUrl(b))}" target="_blank" rel="noopener">Add to Google Calendar</a>
      <a class="btn secondary" href="/api/manage/${esc(token)}/ics">Add to Outlook / Apple</a>
    </div>
    <p class="desc" style="margin-top:22px">Need to make a change? <a href="${esc(b.manageUrl)}" target="_blank" rel="noopener">Reschedule or cancel</a></p>
  </div></div>`;
  scrollTop();
}

// ---------- manage (reschedule / cancel) ----------
async function managePage(token) {
  let data;
  try { data = await api(`/api/manage/${encodeURIComponent(token)}`); } catch (e) { return showError(e.message); }
  const b = data.booking;
  applyBranding(b.branding);
  document.title = `Manage booking | ${b.host.name}`;
  const tz = store.get('tc_tz') || b.timezone || guessTz();
  const ctx = { eventType: b.eventType, host: { ...b.host, photoUrl: '' }, branding: b.branding, tz };
  const startMs = Date.parse(b.start), endMs = Date.parse(b.end);
  const past = endMs < Date.now();

  function overview(msg = '') {
    const cancelled = b.status === 'cancelled';
    app.innerHTML = `<div class="card"><div class="done">
      <h1>${cancelled ? 'This session was cancelled' : 'Your upcoming session'}</h1>
      ${msg ? `<div class="error">${esc(msg)}</div>` : ''}
      <div class="summary"><ul class="meta">
        <li>${icon.cal}<span><strong>${esc(b.eventType.title)}</strong> with ${esc(b.host.name)}</span></li>
        <li>${icon.clock}<span ${cancelled ? 'style="text-decoration:line-through"' : ''}>${esc(rangeLabel(startMs, endMs, tz))}</span></li>
        <li>${icon.globe}<span>${esc(tzLabel(tz))}</span></li>
      </ul></div>
      ${cancelled
    ? `<a class="btn" href="/${esc(b.eventType.slug)}">Book a new time</a>`
    : past ? '<p class="desc">This session has already happened.</p>'
      : `<div class="actions"><button class="btn" id="resched">Reschedule</button><button class="btn secondary" id="cancel">Cancel session</button></div>`}
    </div></div>`;
    document.getElementById('resched')?.addEventListener('click', reschedule);
    document.getElementById('cancel')?.addEventListener('click', cancelForm);
  }

  function reschedule() {
    app.innerHTML = `<div class="card"><div class="layout">${infoPanel(ctx, '<div id="sel"></div>')}<section class="main">
      <button type="button" class="link-btn back" id="back">${icon.left} Back</button><div id="pick"></div></section></div></div>`;
    document.getElementById('back').onclick = () => overview();
    createPicker(document.getElementById('pick'), ctx, {
      manageToken: token,
      onSelectionChange: (ms, ztz) => {
        document.getElementById('sel').innerHTML = ms ? `<div class="selected-time">New time: ${esc(rangeLabel(ms, ms + b.eventType.duration_min * 60000, ztz))}</div>` : '';
      },
      onPick: async (ms, ztz) => {
        app.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
        try {
          const r = await api(`/api/manage/${encodeURIComponent(token)}/reschedule`, { method: 'POST', body: { start: new Date(ms).toISOString() } });
          showDone(r.booking, ztz, 'Your session was rescheduled');
        } catch (e) { overview(e.message); }
      },
    });
  }

  function cancelForm() {
    app.innerHTML = `<div class="card"><div class="done">
      <h1>Cancel this session?</h1>
      <p class="desc">${esc(b.eventType.title)} — ${esc(rangeLabel(startMs, endMs, tz))}</p>
      <form class="details" style="margin:20px auto;text-align:left">
        <label>Reason (optional)<textarea class="field" name="reason" placeholder="Let ${esc(b.host.name)} know why"></textarea></label>
        <div class="actions"><button class="btn danger" type="submit">Yes, cancel</button><button class="btn secondary" type="button" id="keep">Keep my session</button></div>
      </form></div></div>`;
    document.getElementById('keep').onclick = () => overview();
    app.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api(`/api/manage/${encodeURIComponent(token)}/cancel`, { method: 'POST', body: { reason: new FormData(e.target).get('reason') } });
        Object.assign(b, r.booking);
        overview();
      } catch (err) { overview(err.message); }
    };
  }

  overview();
}

// ---------- list of sessions ----------
async function listPage() {
  let data;
  try { data = await api('/api/event-types'); } catch (e) { return showError(e.message); }
  applyBranding(data.branding);
  document.title = `Book with ${data.host.name}`;
  app.innerHTML = `<div class="card"><div class="list">
    <h1>Book a session with ${esc(data.host.name)}</h1>
    ${data.eventTypes.map((et) => `<a class="event" href="/${esc(et.slug)}${location.search}"${et.color ? ` style="border-left-color:${esc(et.color)}"` : ''}>
      <strong>${esc(et.title)}</strong><div class="desc">${et.duration_min} minutes${et.description ? ` · ${esc(et.description)}` : ''}</div></a>`).join('')}
  </div></div>`;
}

// ---------- router ----------
const parts = location.pathname.split('/').filter(Boolean);
if (parts[0] === 'manage' && parts[1]) managePage(parts[1]);
else if (parts.length === 1) bookingPage(decodeURIComponent(parts[0]));
else listPage();
