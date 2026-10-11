import { describe, it, expect, vi, afterEach } from 'vitest';
import { syncBooking } from '../src/bookings.js';

function fakeDb() {
  const updates = [];
  return {
    updates,
    prepare: (sql) => ({ bind: (...args) => ({ run: async () => { updates.push({ sql, args }); return { meta: { changes: 1 } }; } }) }),
  };
}

const settings = {
  host: { name: 'Tim', timezone: 'America/New_York' },
  ghl: { locationId: 'LOC1', userId: 'USER1', blockGhlBusyTimes: true, manageLinkFieldKey: 'contact.manage_link' },
};
const et = { slug: 'pss', title: 'Private Strategy Session', ghl_tags: 'calendar: pss, lead', ghl_calendar_id: 'CAL1', ghl_webhook_url: 'https://hooks.example.com/x', location: 'https://zoom.us/j/1' };
const booking = {
  id: 7, start_ms: Date.UTC(2026, 9, 12, 13), end_ms: Date.UTC(2026, 9, 12, 13, 45), first_name: 'Jane', last_name: 'Doe',
  email: 'jane@example.com', phone: '5551234567', timezone: 'America/Chicago', answers: [{ id: 'goal', label: 'Goal', value: 'Roth' }],
  utm: { utm_source: 'fb' }, source_url: 'https://iraideas.com/private-strategy-session/', cancel_reason: '', ghl_contact_id: '', ghl_appointment_id: '',
};

afterEach(() => vi.unstubAllGlobals());

describe('syncBooking', () => {
  it('upserts contact, tags, notes, creates appointment and fires webhook', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      calls.push({ url: u, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
      const body = u.endsWith('/contacts/upsert') ? { contact: { id: 'C1' } }
        : u.endsWith('/calendars/events/appointments') ? { id: 'A1' } : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const env = { GHL_API_KEY: 'k', DB: fakeDb() };
    await syncBooking(env, settings, et, booking, 'booked', 'https://cal.example.com/manage/tok');

    const [upsert, tags, note, appt, hook] = calls;
    expect(upsert.url).toBe('https://services.leadconnectorhq.com/contacts/upsert');
    expect(upsert.headers.Authorization).toBe('Bearer k');
    expect(upsert.body).toMatchObject({ locationId: 'LOC1', email: 'jane@example.com', customFields: [{ key: 'contact.manage_link', field_value: 'https://cal.example.com/manage/tok' }] });
    expect(tags.body.tags).toEqual(['calendar: pss', 'lead']);
    expect(note.body.body).toContain('Goal: Roth');
    expect(appt.headers.Version).toBe('2021-04-15');
    expect(appt.body).toMatchObject({ calendarId: 'CAL1', contactId: 'C1', assignedUserId: 'USER1', startTime: '2026-10-12T13:00:00.000Z' });
    expect(hook.url).toBe('https://hooks.example.com/x');
    expect(hook.body).toMatchObject({ action: 'booked', email: 'jane@example.com', goal: 'Roth', utm_source: 'fb' });
    expect(env.DB.updates[0].args).toEqual(['C1', 'A1', '', 7]);
  });

  it('cancels the existing GHL appointment and records errors without throwing', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (String(url).includes('hooks.example.com')) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify(String(url).endsWith('/upsert') ? { contact: { id: 'C1' } } : {}), { status: 200 });
    }));
    const env = { GHL_API_KEY: 'k', DB: fakeDb() };
    await syncBooking(env, settings, et, { ...booking, ghl_appointment_id: 'A1', ghl_contact_id: 'C1' }, 'cancelled', 'u');
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.url).toContain('/calendars/events/appointments/A1');
    expect(put.body.appointmentStatus).toBe('cancelled');
    expect(calls.find((c) => c.url.endsWith('/tags')).body.tags).toEqual(['calendar: pss - cancelled', 'lead - cancelled']);
    expect(env.DB.updates[0].args[2]).toMatch(/Webhook 500/);
  });
});
