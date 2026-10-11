import { parseJson } from './util.js';

export const SETTING_DEFAULTS = {
  host: { name: 'Tim', title: '', photoUrl: '', timezone: 'America/New_York' },
  branding: { brandName: '', logoUrl: '', primaryColor: '#1f4e79', accentColor: '#c8a24a' },
  schedule: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
  ghl: { locationId: '', userId: '', blockGhlBusyTimes: true, manageLinkFieldKey: '' },
};

export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = structuredClone(SETTING_DEFAULTS);
  for (const r of results) {
    if (r.key in out) out[r.key] = { ...out[r.key], ...parseJson(r.value, {}) };
  }
  return out;
}

export async function putSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value)).run();
}

export function hydrateEventType(row) {
  if (!row) return null;
  return {
    ...row,
    active: Boolean(row.active),
    schedule: parseJson(row.schedule, null),
    questions: parseJson(row.questions, []),
  };
}

export async function getEventTypeBySlug(env, slug) {
  return hydrateEventType(await env.DB.prepare('SELECT * FROM event_types WHERE slug = ?').bind(slug).first());
}

export async function getEventTypeById(env, id) {
  return hydrateEventType(await env.DB.prepare('SELECT * FROM event_types WHERE id = ?').bind(id).first());
}

export async function listEventTypes(env) {
  const { results } = await env.DB.prepare('SELECT * FROM event_types ORDER BY sort_order, id').all();
  return results.map(hydrateEventType);
}

export async function getOverrides(env) {
  const { results } = await env.DB.prepare('SELECT date, intervals, note FROM date_overrides ORDER BY date').all();
  return results.map((r) => ({ date: r.date, intervals: parseJson(r.intervals, []), note: r.note }));
}

export function hydrateBooking(row) {
  if (!row) return null;
  return { ...row, answers: parseJson(row.answers, []), utm: parseJson(row.utm, {}) };
}

export async function getBookingByToken(env, token) {
  return hydrateBooking(await env.DB.prepare('SELECT * FROM bookings WHERE manage_token = ?').bind(token).first());
}

export async function getBookingById(env, id) {
  return hydrateBooking(await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first());
}
