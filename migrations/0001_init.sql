-- Global key/value settings (JSON values).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE event_types (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  duration_min      INTEGER NOT NULL DEFAULT 30,
  slot_interval_min INTEGER NOT NULL DEFAULT 30,
  buffer_before_min INTEGER NOT NULL DEFAULT 0,
  buffer_after_min  INTEGER NOT NULL DEFAULT 15,
  min_notice_min    INTEGER NOT NULL DEFAULT 720,
  max_days_ahead    INTEGER NOT NULL DEFAULT 30,
  daily_limit       INTEGER NOT NULL DEFAULT 0,      -- 0 = no limit
  schedule          TEXT,                            -- JSON weekly hours; NULL = use default hours
  location          TEXT NOT NULL DEFAULT '',        -- e.g. Zoom link or "Tim will call you"
  questions         TEXT NOT NULL DEFAULT '[]',      -- JSON array of form questions
  ghl_calendar_id   TEXT NOT NULL DEFAULT '',
  ghl_tags          TEXT NOT NULL DEFAULT '',        -- comma separated
  ghl_webhook_url   TEXT NOT NULL DEFAULT '',        -- optional GHL workflow inbound webhook
  redirect_url      TEXT NOT NULL DEFAULT '',        -- optional thank-you page
  color             TEXT NOT NULL DEFAULT '',
  active            INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Date-specific changes to availability (holidays, extra hours). intervals '[]' = day off.
CREATE TABLE date_overrides (
  date      TEXT PRIMARY KEY,   -- YYYY-MM-DD in Tim's timezone
  intervals TEXT NOT NULL,      -- JSON [{"start":"09:00","end":"12:00"}]
  note      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE bookings (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type_id      INTEGER NOT NULL REFERENCES event_types(id),
  start_ms           INTEGER NOT NULL,
  end_ms             INTEGER NOT NULL,
  block_start_ms     INTEGER NOT NULL,  -- start minus buffer_before
  block_end_ms       INTEGER NOT NULL,  -- end plus buffer_after
  status             TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled
  first_name         TEXT NOT NULL,
  last_name          TEXT NOT NULL DEFAULT '',
  email              TEXT NOT NULL,
  phone              TEXT NOT NULL DEFAULT '',
  timezone           TEXT NOT NULL DEFAULT '',
  answers            TEXT NOT NULL DEFAULT '[]',
  source_url         TEXT NOT NULL DEFAULT '',
  utm                TEXT NOT NULL DEFAULT '{}',
  manage_token       TEXT NOT NULL UNIQUE,
  ghl_contact_id     TEXT NOT NULL DEFAULT '',
  ghl_appointment_id TEXT NOT NULL DEFAULT '',
  ghl_sync_error     TEXT NOT NULL DEFAULT '',
  cancel_reason      TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_bookings_block ON bookings(status, block_start_ms, block_end_ms);
CREATE INDEX idx_bookings_start ON bookings(start_ms);

INSERT INTO settings (key, value) VALUES
  ('host', '{"name":"Tim","title":"","photoUrl":"","timezone":"America/New_York"}'),
  ('branding', '{"brandName":"IRA Ideas","logoUrl":"","primaryColor":"#1f4e79","accentColor":"#c8a24a"}'),
  ('schedule', '{"mon":[{"start":"09:00","end":"17:00"}],"tue":[{"start":"09:00","end":"17:00"}],"wed":[{"start":"09:00","end":"17:00"}],"thu":[{"start":"09:00","end":"17:00"}],"fri":[{"start":"09:00","end":"17:00"}],"sat":[],"sun":[]}'),
  ('ghl', '{"locationId":"","userId":"","blockGhlBusyTimes":true,"manageLinkFieldKey":""}');

INSERT INTO event_types (slug, title, description, duration_min, slot_interval_min, questions, ghl_tags, sort_order) VALUES
  ('private-strategy-session', 'Private Strategy Session',
   'A one-on-one session with Tim to map out a strategy for your retirement accounts.',
   45, 30,
   '[{"id":"goal","label":"What would you most like to accomplish on this call?","type":"textarea","required":true},{"id":"assets","label":"Approximately how much do you have in retirement accounts?","type":"select","required":true,"options":["Under $100k","$100k - $250k","$250k - $500k","$500k - $1M","$1M+"]}]',
   'calendar: private strategy session', 1),
  ('retirement-certainty-session', 'Retirement Certainty Session',
   'Walk through your retirement plan with Tim and leave with clarity and confidence.',
   45, 30,
   '[{"id":"retire_when","label":"When are you planning to retire?","type":"select","required":true,"options":["Already retired","Within 1 year","1-5 years","5-10 years","10+ years"]},{"id":"concern","label":"What is your biggest retirement concern right now?","type":"textarea","required":false}]',
   'calendar: retirement certainty session', 2),
  ('work-with-tim', 'Work With Tim',
   'Book a call to see if working with Tim and The Roth Academy is the right fit.',
   30, 30,
   '[{"id":"interest","label":"What are you hoping Tim can help you with?","type":"textarea","required":true}]',
   'calendar: work with tim', 3);
