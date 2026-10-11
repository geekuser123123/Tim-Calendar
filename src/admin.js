// Admin API (password protected) used by /admin.
import { isValidTimeZone, validateIntervals, WEEKDAYS } from './availability.js';
import {
  getSettings, putSetting, listEventTypes, getEventTypeById, getOverrides, getBookingById, hydrateBooking,
  SETTING_DEFAULTS,
} from './db.js';
import * as ghlApi from './ghl.js';
import { cancelBooking, syncBooking } from './bookings.js';
import { HttpError, json, readJson, str, int, isHttpUrl, baseUrl } from './util.js';

const COOKIE = 'tc_admin';
const SESSION_DAYS = 14;
const enc = new TextEncoder();

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

export async function isAdmin(env, request) {
  if (!env.ADMIN_PASSWORD) return false;
  const [exp, sig] = getCookie(request, COOKIE).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return timingSafeEqual(sig, await hmac(env.ADMIN_PASSWORD, `admin:${exp}`));
}

async function login(env, request) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(500, 'ADMIN_PASSWORD secret is not set on the worker.');
  const body = await readJson(request);
  const given = await hmac('cmp', str(body.password, 200));
  const expected = await hmac('cmp', env.ADMIN_PASSWORD);
  if (!timingSafeEqual(given, expected)) {
    await new Promise((r) => setTimeout(r, 800));
    throw new HttpError(401, 'Wrong password.');
  }
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const value = `${exp}.${await hmac(env.ADMIN_PASSWORD, `admin:${exp}`)}`;
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return json({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE}=${value}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`,
  });
}

function logout() {
  return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
}

function cleanSchedule(s) {
  const out = {};
  for (const d of WEEKDAYS) {
    const list = Array.isArray(s?.[d]) ? s[d].map((iv) => ({ start: str(iv.start, 5), end: str(iv.end, 5) })) : [];
    const err = validateIntervals(list);
    if (err) throw new HttpError(400, `${d.toUpperCase()}: ${err}`);
    out[d] = list;
  }
  return out;
}

function cleanQuestions(list) {
  if (!Array.isArray(list)) return [];
  const ids = new Set();
  return list.slice(0, 20).map((q, i) => {
    let id = str(q.id, 40).replace(/[^a-z0-9_]/gi, '_').toLowerCase() || `q${i + 1}`;
    while (ids.has(id)) id += '_';
    ids.add(id);
    const type = ['text', 'textarea', 'select'].includes(q.type) ? q.type : 'text';
    const label = str(q.label, 300);
    if (!label) throw new HttpError(400, `Question ${i + 1} needs a label.`);
    const options = type === 'select'
      ? (Array.isArray(q.options) ? q.options : String(q.options || '').split('\n')).map((o) => str(o, 200)).filter(Boolean)
      : undefined;
    if (type === 'select' && !options.length) throw new HttpError(400, `Question "${label}" needs at least one option.`);
    return { id, label, type, required: Boolean(q.required), ...(options ? { options } : {}) };
  });
}

function cleanEventType(b) {
  const slug = str(b.slug, 80).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new HttpError(400, 'Link name (slug) is required.');
  if (['api', 'admin', 'manage', 'assets', 'embed'].includes(slug)) throw new HttpError(400, `"${slug}" is reserved.`);
  const title = str(b.title, 200);
  if (!title) throw new HttpError(400, 'Title is required.');
  for (const k of ['ghl_webhook_url', 'redirect_url']) {
    if (b[k] && !isHttpUrl(b[k])) throw new HttpError(400, `${k} must be a full https:// URL.`);
  }
  return {
    slug,
    title,
    description: str(b.description, 5000),
    duration_min: int(b.duration_min, { min: 5, max: 480, fallback: 30 }),
    slot_interval_min: int(b.slot_interval_min, { min: 5, max: 480, fallback: 30 }),
    buffer_before_min: int(b.buffer_before_min, { max: 240 }),
    buffer_after_min: int(b.buffer_after_min, { max: 240 }),
    min_notice_min: int(b.min_notice_min, { max: 60 * 24 * 60 }),
    max_days_ahead: int(b.max_days_ahead, { min: 1, max: 365, fallback: 30 }),
    daily_limit: int(b.daily_limit, { max: 100 }),
    schedule: b.schedule ? JSON.stringify(cleanSchedule(b.schedule)) : null,
    location: str(b.location, 1000),
    questions: JSON.stringify(cleanQuestions(b.questions)),
    ghl_calendar_id: str(b.ghl_calendar_id, 100),
    ghl_tags: str(b.ghl_tags, 500),
    ghl_webhook_url: str(b.ghl_webhook_url, 1000),
    redirect_url: str(b.redirect_url, 1000),
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '',
    active: b.active === false ? 0 : 1,
    sort_order: int(b.sort_order, { max: 1000 }),
  };
}

async function saveEventType(env, id, body) {
  const et = cleanEventType(body);
  const cols = Object.keys(et);
  try {
    if (id) {
      const r = await env.DB.prepare(`UPDATE event_types SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .bind(...cols.map((c) => et[c]), id).run();
      if (!r.meta.changes) throw new HttpError(404, 'Event type not found');
    } else {
      const r = await env.DB.prepare(`INSERT INTO event_types (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .bind(...cols.map((c) => et[c])).run();
      id = r.meta.last_row_id;
    }
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, `Another event already uses the link "${et.slug}".`);
    throw e;
  }
  return json({ eventType: await getEventTypeById(env, id) });
}

async function saveSettings(env, body) {
  const cur = await getSettings(env);
  if (body.host) {
    const tz = str(body.host.timezone, 64) || cur.host.timezone;
    if (!isValidTimeZone(tz)) throw new HttpError(400, `Unknown timezone "${tz}".`);
    await putSetting(env, 'host', {
      name: str(body.host.name, 100) || 'Tim', title: str(body.host.title, 200),
      photoUrl: str(body.host.photoUrl, 1000), timezone: tz,
    });
  }
  if (body.branding) {
    const color = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
    await putSetting(env, 'branding', {
      brandName: str(body.branding.brandName, 100), logoUrl: str(body.branding.logoUrl, 1000),
      primaryColor: color(body.branding.primaryColor, SETTING_DEFAULTS.branding.primaryColor),
      accentColor: color(body.branding.accentColor, SETTING_DEFAULTS.branding.accentColor),
    });
  }
  if (body.schedule) await putSetting(env, 'schedule', cleanSchedule(body.schedule));
  if (body.ghl) {
    await putSetting(env, 'ghl', {
      locationId: str(body.ghl.locationId, 100), userId: str(body.ghl.userId, 100),
      blockGhlBusyTimes: body.ghl.blockGhlBusyTimes !== false, manageLinkFieldKey: str(body.ghl.manageLinkFieldKey, 100),
    });
  }
  return json({ settings: await getSettings(env), ghlKeySet: Boolean(env.GHL_API_KEY) });
}

async function saveOverride(env, body) {
  const date = str(body.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Date must be YYYY-MM-DD.');
  const intervals = Array.isArray(body.intervals) ? body.intervals.map((iv) => ({ start: str(iv.start, 5), end: str(iv.end, 5) })) : [];
  const err = validateIntervals(intervals);
  if (err) throw new HttpError(400, err);
  await env.DB.prepare(
    'INSERT INTO date_overrides (date, intervals, note) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET intervals = excluded.intervals, note = excluded.note',
  ).bind(date, JSON.stringify(intervals), str(body.note, 200)).run();
  return json({ overrides: await getOverrides(env) });
}

async function listBookings(env, url) {
  const scope = url.searchParams.get('scope') || 'upcoming';
  const q = str(url.searchParams.get('q'), 100).toLowerCase();
  const now = Date.now();
  let where = "b.status = 'confirmed' AND b.end_ms >= ?";
  let order = 'b.start_ms ASC';
  const args = [now];
  if (scope === 'past') { where = "b.status = 'confirmed' AND b.end_ms < ?"; order = 'b.start_ms DESC'; }
  if (scope === 'cancelled') { where = "b.status = 'cancelled'"; order = 'b.updated_at DESC'; args.length = 0; }
  if (q) {
    where += ' AND (lower(b.email) LIKE ? OR lower(b.first_name || \' \' || b.last_name) LIKE ? OR b.phone LIKE ?)';
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const { results } = await env.DB.prepare(
    `SELECT b.*, e.title AS event_title, e.slug AS event_slug FROM bookings b
     JOIN event_types e ON e.id = b.event_type_id WHERE ${where} ORDER BY ${order} LIMIT 200`,
  ).bind(...args).all();
  return json({ bookings: results.map(hydrateBooking) });
}

export async function handleAdmin(env, request, ctx, path) {
  const method = request.method;
  if (path === '/api/admin/login' && method === 'POST') return login(env, request);
  if (path === '/api/admin/logout' && method === 'POST') return logout();
  if (!(await isAdmin(env, request))) throw new HttpError(401, 'Please log in.');

  // CSRF guard: state-changing admin calls must come from this origin.
  if (method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Bad origin');
  }

  let m;
  if (path === '/api/admin/me') return json({ ok: true, ghlKeySet: Boolean(env.GHL_API_KEY), baseUrl: baseUrl(env, request) });

  if (path === '/api/admin/settings') {
    if (method === 'GET') return json({ settings: await getSettings(env), ghlKeySet: Boolean(env.GHL_API_KEY) });
    if (method === 'PUT') return saveSettings(env, await readJson(request));
  }

  if (path === '/api/admin/event-types') {
    if (method === 'GET') return json({ eventTypes: await listEventTypes(env) });
    if (method === 'POST') return saveEventType(env, 0, await readJson(request));
  }
  if ((m = path.match(/^\/api\/admin\/event-types\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PUT') return saveEventType(env, id, await readJson(request));
    if (method === 'DELETE') {
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM bookings WHERE event_type_id = ?').bind(id).first();
      if (used.n) throw new HttpError(409, 'This event has bookings — turn it off instead of deleting it.');
      await env.DB.prepare('DELETE FROM event_types WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  if (path === '/api/admin/overrides') {
    if (method === 'GET') return json({ overrides: await getOverrides(env) });
    if (method === 'PUT') return saveOverride(env, await readJson(request));
  }
  if ((m = path.match(/^\/api\/admin\/overrides\/(\d{4}-\d{2}-\d{2})$/)) && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM date_overrides WHERE date = ?').bind(m[1]).run();
    return json({ overrides: await getOverrides(env) });
  }

  if (path === '/api/admin/bookings' && method === 'GET') return listBookings(env, new URL(request.url));
  if ((m = path.match(/^\/api\/admin\/bookings\/(\d+)\/(cancel|resync)$/)) && method === 'POST') {
    const b = await getBookingById(env, Number(m[1]));
    if (!b) throw new HttpError(404, 'Booking not found');
    const [et, settings] = await Promise.all([getEventTypeById(env, b.event_type_id), getSettings(env)]);
    const base = baseUrl(env, request);
    if (m[2] === 'cancel') {
      if (b.status !== 'confirmed') throw new HttpError(409, 'Already cancelled');
      const body = await readJson(request).catch(() => ({}));
      await cancelBooking(env, ctx, b, et, settings, str(body.reason, 1000) || 'Cancelled by host', base);
    } else {
      await syncBooking(env, settings, et, b, b.status === 'cancelled' ? 'cancelled' : 'booked', `${base}/manage/${b.manage_token}`);
    }
    return json({ booking: await getBookingById(env, b.id) });
  }

  if (path === '/api/admin/ghl/lookup' && method === 'GET') {
    const settings = await getSettings(env);
    if (!env.GHL_API_KEY) throw new HttpError(400, 'GHL_API_KEY secret is not set on the worker yet.');
    if (!settings.ghl.locationId) throw new HttpError(400, 'Save your GHL Location ID first.');
    const [calendars, users] = await Promise.all([
      ghlApi.listCalendars(env, settings.ghl),
      ghlApi.listUsers(env, settings.ghl).catch(() => []),
    ]);
    return json({ calendars, users });
  }

  throw new HttpError(404, 'Not found');
}
