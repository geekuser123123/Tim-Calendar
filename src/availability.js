// Slot engine. Pure functions only (no I/O) so it is easy to test.

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MIN = 60_000;
const DAY = 86_400_000;

const dtfCache = new Map();
function dtf(timeZone) {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  try { dtf(tz); return true; } catch { return false; }
}

/** Wall-clock parts of a UTC instant in a timezone. */
export function zonedParts(ms, timeZone) {
  const p = {};
  for (const { type, value } of dtf(timeZone).formatToParts(new Date(ms))) p[type] = value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

function offsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC ms for a wall-clock time in a timezone. Gaps (DST spring-forward) resolve forward. */
export function zonedToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = offsetMs(guess, timeZone);
  let utc = guess - off1;
  const off2 = offsetMs(utc, timeZone);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

/** "YYYY-MM-DD" of a UTC instant in a timezone. */
export function dateKey(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

/** Validates a list of {start,end} "HH:MM" intervals. Returns an error string or null. */
export function validateIntervals(list) {
  if (!Array.isArray(list)) return 'must be a list';
  for (const iv of list) {
    const a = parseHHMM(iv?.start), b = parseHHMM(iv?.end);
    if (a == null || b == null) return `invalid time in ${JSON.stringify(iv)}`;
    if (b <= a) return `end must be after start in ${iv.start}-${iv.end}`;
  }
  return null;
}

/**
 * Compute bookable slot start times (UTC ms).
 *
 * @param {object} o
 * @param {object} o.eventType  duration_min, slot_interval_min, buffer_before_min, buffer_after_min,
 *                              min_notice_min, max_days_ahead, daily_limit
 * @param {object} o.schedule   weekly hours {mon:[{start,end}], ...} in hostTz
 * @param {object} o.overrides  {"YYYY-MM-DD": [{start,end}]} — replaces the weekly hours that day
 * @param {string} o.hostTz
 * @param {number} o.rangeStart UTC ms (inclusive)
 * @param {number} o.rangeEnd   UTC ms (exclusive)
 * @param {Array<[number,number]>} o.busy  UTC ms intervals that cannot overlap a slot (+buffers)
 * @param {object} o.dailyCounts {"YYYY-MM-DD": n} existing bookings of this event type per host day
 * @param {number} o.now
 */
export function computeSlots(o) {
  const et = o.eventType;
  const duration = et.duration_min * MIN;
  const step = Math.max(5, et.slot_interval_min || et.duration_min) * MIN;
  const before = (et.buffer_before_min || 0) * MIN;
  const after = (et.buffer_after_min || 0) * MIN;
  const earliest = o.now + (et.min_notice_min || 0) * MIN;
  const latest = o.now + (et.max_days_ahead || 60) * DAY;
  const start = Math.max(o.rangeStart, earliest);
  const end = Math.min(o.rangeEnd, latest);
  if (end <= start) return [];

  const busy = [...(o.busy || [])].sort((a, b) => a[0] - b[0]);
  const overlapsBusy = (a, b) => {
    for (const [s, e] of busy) {
      if (s >= b) break;
      if (e > a) return true;
    }
    return false;
  };

  const out = [];
  // Walk host-local days covering [start, end), padded by a day for timezone edges.
  let cursor = start - DAY;
  const seen = new Set();
  while (cursor < end + DAY) {
    const key = dateKey(cursor, o.hostTz);
    cursor += DAY / 2; // half-day steps so DST days are never skipped
    if (seen.has(key)) continue;
    seen.add(key);

    const [y, m, d] = key.split('-').map(Number);
    const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    const intervals = Object.prototype.hasOwnProperty.call(o.overrides || {}, key)
      ? o.overrides[key]
      : (o.schedule?.[weekday] || []);
    if (et.daily_limit && (o.dailyCounts?.[key] || 0) >= et.daily_limit) continue;

    for (const iv of intervals) {
      const a = parseHHMM(iv.start), b = parseHHMM(iv.end);
      if (a == null || b == null || b <= a) continue;
      const winStart = zonedToUtc(y, m, d, Math.floor(a / 60), a % 60, o.hostTz);
      const winEnd = zonedToUtc(y, m, d, Math.floor(b / 60), b % 60, o.hostTz);
      for (let t = winStart; t + duration <= winEnd; t += step) {
        if (t < start || t >= end) continue;
        if (overlapsBusy(t - before, t + duration + after)) continue;
        out.push(t);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
