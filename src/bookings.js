// Public booking API: event info, available slots, create / reschedule / cancel.
import { computeSlots, dateKey, isValidTimeZone } from './availability.js';
import {
  getSettings, getEventTypeBySlug, getEventTypeById, getOverrides, getBookingByToken, listEventTypes,
} from './db.js';
import * as ghlApi from './ghl.js';
import { HttpError, json, readJson, str, isEmail, randomToken, baseUrl, formatInTz } from './util.js';

const MIN = 60_000;
const DAY = 86_400_000;

export function publicEventType(et) {
  return {
    slug: et.slug, title: et.title, description: et.description, duration_min: et.duration_min,
    location: et.location, questions: et.questions, color: et.color, max_days_ahead: et.max_days_ahead,
  };
}

function publicProfile(settings) {
  const { host, branding } = settings;
  return {
    host: { name: host.name, title: host.title, photoUrl: host.photoUrl, timezone: host.timezone },
    branding,
  };
}

async function requireEventType(env, slug) {
  const et = await getEventTypeBySlug(env, slug);
  if (!et || !et.active) throw new HttpError(404, 'This booking page is not available.');
  return et;
}

export async function handleEventInfo(env, slug) {
  const [et, settings] = await Promise.all([requireEventType(env, slug), getSettings(env)]);
  return json({ eventType: publicEventType(et), ...publicProfile(settings) });
}

export async function handleEventList(env) {
  const [types, settings] = await Promise.all([listEventTypes(env), getSettings(env)]);
  return json({ eventTypes: types.filter((t) => t.active).map(publicEventType), ...publicProfile(settings) });
}

/** Everything the slot engine needs for one event type over [startMs, endMs). */
async function slotsFor(env, et, settings, startMs, endMs, { excludeBookingId = 0, now = Date.now() } = {}) {
  const tz = settings.host.timezone;
  const pad = DAY; // buffers can reach a bit outside the range
  const [overridesList, busyRows, countRows, ghlBusy] = await Promise.all([
    getOverrides(env),
    env.DB.prepare(
      `SELECT block_start_ms, block_end_ms FROM bookings
       WHERE status = 'confirmed' AND id != ? AND block_start_ms < ? AND block_end_ms > ?`,
    ).bind(excludeBookingId, endMs + pad, startMs - pad).all(),
    et.daily_limit
      ? env.DB.prepare(
        `SELECT start_ms FROM bookings WHERE status = 'confirmed' AND event_type_id = ? AND id != ?
         AND start_ms >= ? AND start_ms < ?`,
      ).bind(et.id, excludeBookingId, startMs - 2 * DAY, endMs + 2 * DAY).all()
      : Promise.resolve({ results: [] }),
    settings.ghl.blockGhlBusyTimes && ghlApi.ghlEnabled(env, settings.ghl)
      ? ghlApi.fetchBusy(env, settings.ghl, [et.ghl_calendar_id], startMs - pad, endMs + pad).catch((e) => {
        console.warn('GHL busy lookup failed', e.message);
        return [];
      })
      : Promise.resolve([]),
  ]);

  const overrides = Object.fromEntries(overridesList.map((o) => [o.date, o.intervals]));
  const dailyCounts = {};
  for (const r of countRows.results) {
    const k = dateKey(r.start_ms, tz);
    dailyCounts[k] = (dailyCounts[k] || 0) + 1;
  }
  const busy = busyRows.results.map((r) => [r.block_start_ms, r.block_end_ms]);

  // When rescheduling, the booking's own GHL appointment still shows as busy — drop exact matches.
  let extBusy = ghlBusy;
  if (excludeBookingId) {
    const own = await env.DB.prepare('SELECT start_ms, end_ms FROM bookings WHERE id = ?').bind(excludeBookingId).first();
    if (own) extBusy = ghlBusy.filter(([s, e]) => !(s === own.start_ms && e === own.end_ms));
  }

  return computeSlots({
    eventType: et,
    schedule: et.schedule || settings.schedule,
    overrides,
    hostTz: tz,
    rangeStart: startMs,
    rangeEnd: endMs,
    busy: busy.concat(extBusy),
    dailyCounts,
    now,
  });
}

export async function handleSlots(env, url) {
  const slug = str(url.searchParams.get('event'), 100);
  const startMs = Date.parse(url.searchParams.get('start') || '');
  const endMs = Date.parse(url.searchParams.get('end') || '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new HttpError(400, 'start and end are required');
  if (endMs - startMs > 45 * DAY) throw new HttpError(400, 'Range too large');

  let excludeBookingId = 0;
  const token = url.searchParams.get('manage');
  if (token) {
    const b = await getBookingByToken(env, token);
    if (b) excludeBookingId = b.id;
  }
  const [et, settings] = await Promise.all([requireEventType(env, slug), getSettings(env)]);
  const slots = await slotsFor(env, et, settings, startMs, endMs, { excludeBookingId });
  return json({ slots: slots.map((t) => new Date(t).toISOString()), timezone: settings.host.timezone });
}

async function assertSlotOpen(env, et, settings, startMs, excludeBookingId = 0) {
  const slots = await slotsFor(env, et, settings, startMs, startMs + 1, { excludeBookingId });
  if (!slots.includes(startMs)) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another time.');
}

function blockFor(et, startMs) {
  const endMs = startMs + et.duration_min * MIN;
  return {
    endMs,
    blockStart: startMs - et.buffer_before_min * MIN,
    blockEnd: endMs + et.buffer_after_min * MIN,
  };
}

function cleanAnswers(et, raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const out = [];
  for (const q of et.questions) {
    let v = given[q.id];
    v = Array.isArray(v) ? v.map((x) => str(x, 200)).filter(Boolean).join(', ') : str(v, 2000);
    if (q.required && !v) throw new HttpError(400, `Please answer: ${q.label}`);
    if (v && q.type === 'select' && Array.isArray(q.options) && !q.options.includes(v)) {
      throw new HttpError(400, `Please choose a valid option for: ${q.label}`);
    }
    out.push({ id: q.id, label: q.label, value: v });
  }
  return out;
}

export async function handleCreateBooking(env, request, ctx) {
  const body = await readJson(request);
  const [et, settings] = await Promise.all([requireEventType(env, str(body.event, 100)), getSettings(env)]);

  const firstName = str(body.firstName, 100);
  const lastName = str(body.lastName, 100);
  const email = str(body.email, 200).toLowerCase();
  const phone = str(body.phone, 40);
  const timezone = isValidTimeZone(str(body.timezone, 64)) ? str(body.timezone, 64) : settings.host.timezone;
  if (!firstName) throw new HttpError(400, 'Please enter your first name.');
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!phone || phone.replace(/\D/g, '').length < 7) throw new HttpError(400, 'Please enter a valid phone number.');
  const answers = cleanAnswers(et, body.answers);

  const startMs = Date.parse(body.start || '');
  if (!Number.isFinite(startMs)) throw new HttpError(400, 'Please pick a time.');
  await assertSlotOpen(env, et, settings, startMs);

  const { endMs, blockStart, blockEnd } = blockFor(et, startMs);
  const token = randomToken();
  const utm = {};
  for (const [k, v] of Object.entries(body.utm || {})) if (/^utm_|^(gclid|fbclid)$/.test(k)) utm[k] = str(v, 200);

  // Single statement insert guarded against overlapping confirmed bookings (prevents double booking races).
  const res = await env.DB.prepare(
    `INSERT INTO bookings (event_type_id, start_ms, end_ms, block_start_ms, block_end_ms, first_name, last_name,
       email, phone, timezone, answers, source_url, utm, manage_token)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM bookings WHERE status = 'confirmed' AND block_start_ms < ? AND block_end_ms > ?
     )`,
  ).bind(
    et.id, startMs, endMs, blockStart, blockEnd, firstName, lastName, email, phone, timezone,
    JSON.stringify(answers), str(body.sourceUrl, 500), JSON.stringify(utm), token,
    blockEnd, blockStart,
  ).run();
  if (!res.meta.changes) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another time.');

  const booking = await getBookingByToken(env, token);
  const manageUrl = `${baseUrl(env, request)}/manage/${token}`;
  ctx.waitUntil(syncBooking(env, settings, et, booking, 'booked', manageUrl));

  return json({
    booking: bookingView(booking, et, settings, manageUrl),
    redirectUrl: et.redirect_url || '',
  }, 201);
}

function bookingView(b, et, settings, manageUrl) {
  return {
    status: b.status,
    start: new Date(b.start_ms).toISOString(),
    end: new Date(b.end_ms).toISOString(),
    timezone: b.timezone,
    firstName: b.first_name,
    lastName: b.last_name,
    email: b.email,
    eventType: publicEventType(et),
    host: { name: settings.host.name, timezone: settings.host.timezone },
    branding: settings.branding,
    manageUrl,
  };
}

async function loadManaged(env, token) {
  const b = await getBookingByToken(env, token);
  if (!b) throw new HttpError(404, 'Booking not found.');
  const [et, settings] = await Promise.all([getEventTypeById(env, b.event_type_id), getSettings(env)]);
  return { b, et, settings };
}

export async function handleGetManaged(env, request, token) {
  const { b, et, settings } = await loadManaged(env, token);
  return json({ booking: bookingView(b, et, settings, `${baseUrl(env, request)}/manage/${token}`) });
}

export async function handleCancelManaged(env, request, ctx, token) {
  const { b, et, settings } = await loadManaged(env, token);
  if (b.status !== 'confirmed') throw new HttpError(409, 'This booking is already cancelled.');
  const body = await readJson(request).catch(() => ({}));
  const updated = await cancelBooking(env, ctx, b, et, settings, str(body.reason, 1000), baseUrl(env, request));
  return json({ booking: bookingView(updated, et, settings, `${baseUrl(env, request)}/manage/${token}`) });
}

export async function cancelBooking(env, ctx, b, et, settings, reason, base) {
  await env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled', cancel_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
  ).bind(reason, b.id).run();
  const updated = await getBookingByToken(env, b.manage_token);
  ctx.waitUntil(syncBooking(env, settings, et, updated, 'cancelled', `${base}/manage/${b.manage_token}`));
  return updated;
}

export async function handleRescheduleManaged(env, request, ctx, token) {
  const { b, et, settings } = await loadManaged(env, token);
  if (b.status !== 'confirmed') throw new HttpError(409, 'This booking was cancelled. Please book a new time.');
  if (!et.active) throw new HttpError(409, 'This session type is no longer available.');
  const body = await readJson(request);
  const startMs = Date.parse(body.start || '');
  if (!Number.isFinite(startMs)) throw new HttpError(400, 'Please pick a time.');
  await assertSlotOpen(env, et, settings, startMs, b.id);

  const { endMs, blockStart, blockEnd } = blockFor(et, startMs);
  const res = await env.DB.prepare(
    `UPDATE bookings SET start_ms = ?, end_ms = ?, block_start_ms = ?, block_end_ms = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND NOT EXISTS (
       SELECT 1 FROM bookings WHERE status = 'confirmed' AND id != ? AND block_start_ms < ? AND block_end_ms > ?
     )`,
  ).bind(startMs, endMs, blockStart, blockEnd, b.id, b.id, blockEnd, blockStart).run();
  if (!res.meta.changes) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another time.');

  const updated = await getBookingByToken(env, token);
  const manageUrl = `${baseUrl(env, request)}/manage/${token}`;
  ctx.waitUntil(syncBooking(env, settings, et, updated, 'rescheduled', manageUrl, b.start_ms));
  return json({ booking: bookingView(updated, et, settings, manageUrl) });
}

function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
}

export async function handleIcs(env, request, token) {
  const { b, et, settings } = await loadManaged(env, token);
  const manageUrl = `${baseUrl(env, request)}/manage/${token}`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tim Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:booking-${b.id}@tim-calendar`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(b.start_ms)}`,
    `DTEND:${icsDate(b.end_ms)}`,
    `SUMMARY:${icsEscape(`${et.title} with ${settings.host.name}`)}`,
    `DESCRIPTION:${icsEscape(`${et.location ? `Location: ${et.location}\n` : ''}Need to reschedule or cancel? ${manageUrl}`)}`,
    et.location ? `LOCATION:${icsEscape(et.location)}` : '',
    `STATUS:${b.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${et.slug}.ics"`,
    },
  });
}

/**
 * Push a booking change to GoHighLevel: upsert contact, tag it, add a note, and create/update the
 * appointment on the mapped GHL calendar. Also fires the optional workflow webhook.
 * Errors are stored on the booking so they are visible in the admin panel.
 */
export async function syncBooking(env, settings, et, b, action, manageUrl, previousStartMs) {
  const errors = [];
  let contactId = b.ghl_contact_id;
  let appointmentId = b.ghl_appointment_id;
  const ghl = settings.ghl;
  const hostTz = settings.host.timezone;
  const whenHost = formatInTz(b.start_ms, hostTz);

  if (ghlApi.ghlEnabled(env, ghl)) {
    try {
      const customFields = ghl.manageLinkFieldKey ? [{ key: ghl.manageLinkFieldKey, field_value: manageUrl }] : [];
      contactId = await ghlApi.upsertContact(env, ghl, {
        firstName: b.first_name, lastName: b.last_name, email: b.email, phone: b.phone,
        timezone: b.timezone, source: `Calendar: ${et.title}`, customFields,
      }) || contactId;

      if (contactId) {
        const baseTags = et.ghl_tags.split(',').map((t) => t.trim()).filter(Boolean);
        const tags = action === 'booked' ? baseTags
          : action === 'cancelled' ? baseTags.map((t) => `${t} - cancelled`)
            : baseTags.map((t) => `${t} - rescheduled`);
        await ghlApi.addTags(env, contactId, tags).catch((e) => errors.push(e.message));

        const lines = [
          `📅 ${et.title} — ${action.toUpperCase()}`,
          `When: ${whenHost}${b.timezone && b.timezone !== hostTz ? ` (guest: ${formatInTz(b.start_ms, b.timezone)})` : ''}`,
          previousStartMs ? `Previously: ${formatInTz(previousStartMs, hostTz)}` : '',
          b.cancel_reason ? `Cancel reason: ${b.cancel_reason}` : '',
          ...b.answers.filter((a) => a.value).map((a) => `${a.label}: ${a.value}`),
          b.source_url ? `Booked from: ${b.source_url}` : '',
          Object.keys(b.utm).length ? `UTM: ${Object.entries(b.utm).map(([k, v]) => `${k}=${v}`).join(' ')}` : '',
          `Manage link: ${manageUrl}`,
        ].filter(Boolean);
        await ghlApi.addNote(env, contactId, lines.join('\n')).catch((e) => errors.push(e.message));

        if (et.ghl_calendar_id) {
          if (!appointmentId && action !== 'cancelled') {
            appointmentId = await ghlApi.createAppointment(env, ghl, {
              calendarId: et.ghl_calendar_id, contactId, startMs: b.start_ms, endMs: b.end_ms,
              title: `${et.title} — ${b.first_name} ${b.last_name}`.trim(), address: et.location,
            }) || '';
          } else if (appointmentId && action === 'rescheduled') {
            await ghlApi.updateAppointment(env, appointmentId, { startMs: b.start_ms, endMs: b.end_ms });
          } else if (appointmentId && action === 'cancelled') {
            await ghlApi.updateAppointment(env, appointmentId, { status: 'cancelled' });
          }
        }
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  if (et.ghl_webhook_url) {
    const payload = {
      action,
      event_type: et.slug,
      event_title: et.title,
      start_time: new Date(b.start_ms).toISOString(),
      end_time: new Date(b.end_ms).toISOString(),
      start_time_host: whenHost,
      start_time_guest: formatInTz(b.start_ms, b.timezone || hostTz),
      guest_timezone: b.timezone,
      previous_start_time: previousStartMs ? new Date(previousStartMs).toISOString() : '',
      first_name: b.first_name,
      last_name: b.last_name,
      email: b.email,
      phone: b.phone,
      location: et.location,
      manage_url: manageUrl,
      cancel_reason: b.cancel_reason,
      source_url: b.source_url,
      ...b.utm,
      ...Object.fromEntries(b.answers.map((a) => [a.id, a.value])),
      booking_id: b.id,
      ghl_contact_id: contactId,
    };
    await ghlApi.postWebhook(et.ghl_webhook_url, payload).catch((e) => errors.push(e.message));
  }

  await env.DB.prepare(
    'UPDATE bookings SET ghl_contact_id = ?, ghl_appointment_id = ?, ghl_sync_error = ? WHERE id = ?',
  ).bind(contactId || '', appointmentId || '', errors.join(' | ').slice(0, 1000), b.id).run();
}
