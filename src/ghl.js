// GoHighLevel (LeadConnector) API v2 client.
// Auth uses a Private Integration token (Settings → Private Integrations in GHL).

const BASE = 'https://services.leadconnectorhq.com';
const V_CONTACTS = '2021-07-28';
const V_CALENDARS = '2021-04-15';

export class GhlError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function ghlEnabled(env, ghl) {
  return Boolean(env.GHL_API_KEY && ghl?.locationId);
}

async function call(env, method, path, { version = V_CONTACTS, query, body, timeoutMs = 10_000 } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.GHL_API_KEY}`,
      Version: version,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join('; ') : (data?.message || data?.error || res.statusText);
    throw new GhlError(`GHL ${method} ${path} → ${res.status}: ${msg}`, res.status, data);
  }
  return data;
}

export async function upsertContact(env, ghl, c) {
  const body = {
    locationId: ghl.locationId,
    firstName: c.firstName,
    lastName: c.lastName || undefined,
    email: c.email,
    phone: c.phone || undefined,
    timezone: c.timezone || undefined,
    source: c.source || 'Tim Calendar',
  };
  if (c.customFields?.length) body.customFields = c.customFields;
  const data = await call(env, 'POST', '/contacts/upsert', { body });
  return data.contact?.id;
}

export async function addTags(env, contactId, tags) {
  if (!tags.length) return;
  await call(env, 'POST', `/contacts/${contactId}/tags`, { body: { tags } });
}

export async function addNote(env, contactId, text) {
  await call(env, 'POST', `/contacts/${contactId}/notes`, { body: { body: text } });
}

export async function createAppointment(env, ghl, a) {
  const body = {
    calendarId: a.calendarId,
    locationId: ghl.locationId,
    contactId: a.contactId,
    startTime: new Date(a.startMs).toISOString(),
    endTime: new Date(a.endMs).toISOString(),
    title: a.title,
    appointmentStatus: 'confirmed',
    address: a.address || undefined,
    ignoreDateRange: true,
    ignoreFreeSlotValidation: true,
    toNotify: true,
  };
  if (ghl.userId) body.assignedUserId = ghl.userId;
  const data = await call(env, 'POST', '/calendars/events/appointments', { version: V_CALENDARS, body });
  return data.id || data.event?.id || data.appointment?.id;
}

export async function updateAppointment(env, appointmentId, patch) {
  const body = { ignoreDateRange: true, ignoreFreeSlotValidation: true, toNotify: true };
  if (patch.startMs) body.startTime = new Date(patch.startMs).toISOString();
  if (patch.endMs) body.endTime = new Date(patch.endMs).toISOString();
  if (patch.status) body.appointmentStatus = patch.status;
  await call(env, 'PUT', `/calendars/events/appointments/${appointmentId}`, { version: V_CALENDARS, body });
}

/**
 * Busy intervals from GHL for Tim (appointments + blocked time, which includes events
 * synced from his connected Google/Outlook calendar). Returns [[startMs, endMs], ...].
 */
const busyCache = new Map(); // per-isolate, keeps GHL calls well under its rate limit on busy pages
const BUSY_TTL_MS = 60_000;

export async function fetchBusy(env, ghl, calendarIds, startMs, endMs) {
  const key = JSON.stringify([ghl.locationId, ghl.userId, calendarIds, startMs, endMs]);
  const hit = busyCache.get(key);
  if (hit && hit.at > Date.now() - BUSY_TTL_MS) return hit.busy;
  const busy = await fetchBusyUncached(env, ghl, calendarIds, startMs, endMs);
  if (busyCache.size > 200) busyCache.clear();
  busyCache.set(key, { at: Date.now(), busy });
  return busy;
}

async function fetchBusyUncached(env, ghl, calendarIds, startMs, endMs) {
  const filters = ghl.userId ? [{ userId: ghl.userId }] : calendarIds.filter(Boolean).map((calendarId) => ({ calendarId }));
  if (!filters.length) return [];
  const jobs = [];
  for (const f of filters) {
    const query = { locationId: ghl.locationId, startTime: startMs, endTime: endMs, ...f };
    jobs.push(call(env, 'GET', '/calendars/events', { version: V_CALENDARS, query, timeoutMs: 6000 }));
    jobs.push(call(env, 'GET', '/calendars/blocked-slots', { version: V_CALENDARS, query, timeoutMs: 6000 }));
  }
  const busy = [];
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status !== 'fulfilled') { console.warn('GHL busy fetch failed:', r.reason?.message); continue; }
    for (const ev of r.value.events || []) {
      const status = String(ev.appointmentStatus || ev.status || '').toLowerCase();
      if (status === 'cancelled' || status === 'invalid' || ev.deleted) continue;
      const s = Date.parse(ev.startTime), e = Date.parse(ev.endTime);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) busy.push([s, e]);
    }
  }
  return busy;
}

export async function listCalendars(env, ghl) {
  const data = await call(env, 'GET', '/calendars/', { version: V_CALENDARS, query: { locationId: ghl.locationId } });
  return (data.calendars || []).map((c) => ({ id: c.id, name: c.name, isActive: c.isActive }));
}

export async function listUsers(env, ghl) {
  const data = await call(env, 'GET', '/users/', { query: { locationId: ghl.locationId } });
  return (data.users || []).map((u) => ({ id: u.id, name: u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim(), email: u.email }));
}

/** Post a booking event to a GHL workflow "Inbound Webhook" trigger URL. */
export async function postWebhook(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Webhook ${res.status}`);
}
