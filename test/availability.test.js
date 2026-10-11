import { describe, it, expect } from 'vitest';
import { computeSlots, zonedToUtc, dateKey, validateIntervals } from '../src/availability.js';

const NY = 'America/New_York';
const weekdays = { mon: [{ start: '09:00', end: '12:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
const et = (o = {}) => ({
  duration_min: 60, slot_interval_min: 60, buffer_before_min: 0, buffer_after_min: 0,
  min_notice_min: 0, max_days_ahead: 365, daily_limit: 0, ...o,
});
// Monday 2026-10-12, well in the "future" relative to `now`.
const now = Date.UTC(2026, 9, 1);
const dayRange = [Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 13)];
const iso = (ms) => new Date(ms).toISOString();

describe('time zone helpers', () => {
  it('converts wall time to UTC across DST', () => {
    expect(iso(zonedToUtc(2026, 7, 1, 9, 0, NY))).toBe('2026-07-01T13:00:00.000Z'); // EDT
    expect(iso(zonedToUtc(2026, 12, 1, 9, 0, NY))).toBe('2026-12-01T14:00:00.000Z'); // EST
  });
  it('gives the local date key', () => {
    expect(dateKey(Date.UTC(2026, 9, 12, 2), NY)).toBe('2026-10-11');
  });
  it('validates intervals', () => {
    expect(validateIntervals([{ start: '09:00', end: '17:00' }])).toBeNull();
    expect(validateIntervals([{ start: '17:00', end: '09:00' }])).toMatch(/after/);
    expect(validateIntervals([{ start: '9am', end: '17:00' }])).toMatch(/invalid/);
  });
});

describe('computeSlots', () => {
  const base = { schedule: weekdays, overrides: {}, hostTz: NY, rangeStart: dayRange[0], rangeEnd: dayRange[1], busy: [], now };

  it('produces slots inside the weekly hours in the host time zone', () => {
    const s = computeSlots({ ...base, eventType: et() }).map(iso);
    expect(s).toEqual(['2026-10-12T13:00:00.000Z', '2026-10-12T14:00:00.000Z', '2026-10-12T15:00:00.000Z']);
  });

  it('respects slot interval smaller than duration', () => {
    expect(computeSlots({ ...base, eventType: et({ slot_interval_min: 30 }) })).toHaveLength(5);
  });

  it('removes slots overlapping busy time including buffers', () => {
    const busy = [[Date.UTC(2026, 9, 12, 14), Date.UTC(2026, 9, 12, 15)]];
    expect(computeSlots({ ...base, busy, eventType: et() }).map(iso)).toEqual(['2026-10-12T13:00:00.000Z', '2026-10-12T15:00:00.000Z']);
    expect(computeSlots({ ...base, busy, eventType: et({ buffer_after_min: 15 }) }).map(iso)).toEqual(['2026-10-12T15:00:00.000Z']);
  });

  it('applies minimum notice and max days ahead', () => {
    const n = Date.UTC(2026, 9, 12, 12, 30);
    expect(computeSlots({ ...base, now: n, eventType: et({ min_notice_min: 60 }) }).map(iso)).toEqual(['2026-10-12T14:00:00.000Z', '2026-10-12T15:00:00.000Z']);
    expect(computeSlots({ ...base, now: Date.UTC(2026, 9, 1), eventType: et({ max_days_ahead: 5 }) })).toEqual([]);
  });

  it('date overrides replace weekly hours (day off and custom hours)', () => {
    expect(computeSlots({ ...base, overrides: { '2026-10-12': [] }, eventType: et() })).toEqual([]);
    const tue = [Date.UTC(2026, 9, 13), Date.UTC(2026, 9, 14)];
    const s = computeSlots({ ...base, rangeStart: tue[0], rangeEnd: tue[1], overrides: { '2026-10-13': [{ start: '18:00', end: '19:00' }] }, eventType: et() });
    expect(s.map(iso)).toEqual(['2026-10-13T22:00:00.000Z']);
  });

  it('honours the daily limit', () => {
    expect(computeSlots({ ...base, dailyCounts: { '2026-10-12': 2 }, eventType: et({ daily_limit: 2 }) })).toEqual([]);
    expect(computeSlots({ ...base, dailyCounts: { '2026-10-12': 1 }, eventType: et({ daily_limit: 2 }) })).toHaveLength(3);
  });

  it('handles the DST change week', () => {
    // Nov 2 2026 is the Monday after DST ends (Nov 1) — 9am EST = 14:00Z.
    const s = computeSlots({ ...base, rangeStart: Date.UTC(2026, 10, 2), rangeEnd: Date.UTC(2026, 10, 3), eventType: et() });
    expect(iso(s[0])).toBe('2026-11-02T14:00:00.000Z');
  });
});
