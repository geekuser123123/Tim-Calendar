// Tim Calendar — Cloudflare Worker entry point.
// Static files in /public are served by Workers Assets; this worker only handles /api/*.
import {
  handleEventInfo, handleEventList, handleSlots, handleCreateBooking,
  handleGetManaged, handleCancelManaged, handleRescheduleManaged, handleIcs,
} from './bookings.js';
import { handleAdmin } from './admin.js';
import { HttpError, json } from './util.js';

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  let m;

  if (path.startsWith('/api/admin/')) return handleAdmin(env, request, ctx, path);

  if (path === '/api/event-types' && method === 'GET') return handleEventList(env);
  if ((m = path.match(/^\/api\/event-types\/([a-z0-9-]+)$/)) && method === 'GET') return handleEventInfo(env, m[1]);
  if (path === '/api/slots' && method === 'GET') return handleSlots(env, url);
  if (path === '/api/bookings' && method === 'POST') return handleCreateBooking(env, request, ctx);

  if ((m = path.match(/^\/api\/manage\/([A-Za-z0-9_-]{20,64})(?:\/(cancel|reschedule|ics))?$/))) {
    const [, token, action] = m;
    if (!action && method === 'GET') return handleGetManaged(env, request, token);
    if (action === 'ics' && method === 'GET') return handleIcs(env, request, token);
    if (action === 'cancel' && method === 'POST') return handleCancelManaged(env, request, ctx, token);
    if (action === 'reschedule' && method === 'POST') return handleRescheduleManaged(env, request, ctx, token);
  }

  if (path === '/api/health') return json({ ok: true });
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  },
};
