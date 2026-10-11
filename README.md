# Tim's Calendar

A custom booking calendar for Tim that replaces Zoho Bookings. It runs on **Cloudflare Workers + D1** (deployed automatically from **GitHub**) and syncs every booking into **GoHighLevel**.

- One booking page per session type, e.g. `https://book.example.com/private-strategy-session`
- Embeds on any site: WordPress (iraideas.com), GHL funnels/sites (therothacademy.com), or anything else
- Admin panel at `/admin` where Tim edits hours, days off, sessions, questions and branding — no code
- Guests can reschedule/cancel from a private link; `.ics` + Google Calendar buttons after booking
- GoHighLevel: contact upsert, tags, a note with all answers, appointment on a GHL calendar (so GHL confirmation/reminder workflows fire), Tim's GHL busy times blocked, optional workflow webhook

## Sessions already set up

| Landing page | Session link |
|---|---|
| https://iraideas.com/private-strategy-session/ | `/private-strategy-session` |
| https://iraideas.com/retirement-certainty-session/ | `/retirement-certainty-session` |
| https://work.therothacademy.com/work-with-tim | `/work-with-tim` |

Durations, descriptions and questions are placeholders — edit them in **Admin → Sessions**.

---

## One-time setup

### 1. Cloudflare

```bash
npm install
npx wrangler login
npx wrangler d1 create tim-calendar          # copy the database_id it prints
```

Paste the `database_id` into `wrangler.jsonc`, then:

```bash
npx wrangler secret put ADMIN_PASSWORD        # Tim's admin password
npx wrangler secret put GHL_API_KEY           # GoHighLevel Private Integration token (step 3)
npm run deploy                                # creates tables + deploys
```

**Custom domain (recommended):** Cloudflare dashboard → Workers & Pages → `tim-calendar` → Settings → Domains & Routes → add e.g. `book.iraideas.com`. Then set `PUBLIC_BASE_URL` in `wrangler.jsonc` to that URL (used in reschedule/cancel links) and push.

### 2. GitHub auto-deploy

Every push to `main` runs the tests and deploys. In the GitHub repo → Settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers" template, plus **D1: Edit** permission |
| `CLOUDFLARE_ACCOUNT_ID` | Shown on the Cloudflare dashboard sidebar |

### 3. GoHighLevel

1. In the GHL sub-account: **Settings → Private Integrations → Create** with these scopes:
   `contacts.write`, `contacts.readonly`, `calendars.readonly`, `calendars.write`, `calendars/events.readonly`, `calendars/events.write`, `users.readonly`
2. Put the token into the worker: `npx wrangler secret put GHL_API_KEY`
3. Open `/admin` → **Settings** → enter the **Location ID** (GHL → Settings → Business Profile), click **Test connection**, pick **Tim's GHL user**, save.
4. **Admin → Sessions** → for each session pick the **GHL calendar** to put appointments on, and adjust tags.

What happens on every booking:

| Action | In GHL |
|---|---|
| Booked | Contact upserted · tags added · note with time, answers, source page & UTMs · appointment created on the chosen calendar |
| Rescheduled | Appointment moved · `<tag> - rescheduled` added · note |
| Cancelled | Appointment set to cancelled · `<tag> - cancelled` added · note |

Use those tags or the GHL appointment triggers ("Customer Booked Appointment", "Appointment Status") in your workflows for confirmations, reminders and pipeline moves.

**Avoiding double-booking with Tim's real calendar:** connect Tim's Google/Outlook calendar to his GHL user (GHL → Settings → Calendars → Connections) and keep "Block times that are already busy on Tim's GHL calendar" on. The calendar then hides any time that is busy in GHL.

**Reschedule link in GHL emails/SMS (optional):** create a contact custom field (e.g. *Booking Manage Link*), put its key (e.g. `contact.booking_manage_link`) in Admin → Settings, and use `{{contact.booking_manage_link}}` in your templates.

**Workflow webhook (optional):** in a GHL workflow add the trigger **Inbound Webhook**, copy its URL into the session's "Workflow inbound webhook URL". Each booking/reschedule/cancel posts fields like `action`, `first_name`, `email`, `phone`, `start_time`, `start_time_guest`, `manage_url`, every question answer (by its id) and UTMs.

### 4. Put it on the landing pages

Admin → **Share & embed** has copy-paste code for every session. Example:

```html
<div data-tim-calendar="private-strategy-session"></div>
<script src="https://book.iraideas.com/embed.js" async></script>
```

- **WordPress:** Custom HTML block / Elementor HTML widget.
- **GoHighLevel funnel/site:** Custom JS/HTML element.
- **Popup button instead:** `<a href="#" data-tim-calendar-popup="work-with-tim">Book a call</a>` + the same script.

The embed resizes itself, passes UTM tags (`utm_*`, `gclid`, `fbclid`) and pre-fills `first_name`, `last_name`, `email`, `phone` from the page URL. After a booking it fires a `tim-calendar:booked` window event and a `tim_calendar_booked` dataLayer event for pixels/GTM. Set a "Thank-you page URL" on a session to redirect the whole page after booking.

---

## For Tim: using the admin

Go to `https://<calendar-domain>/admin` and log in.

- **Bookings** — upcoming / past / cancelled, with answers. Cancel or reschedule for a guest, re-sync to GHL if a sync failed.
- **Sessions** — change title, length, description, Zoom link, questions, breaks between calls, minimum notice, how far ahead people can book, max per day, or give a session its own hours. Turn a session off to hide it.
- **Availability** — weekly hours, plus days off and special hours for specific dates.
- **Share & embed** — links and embed codes.
- **Settings** — name, photo, time zone, logo, colours, GHL connection.

## Development

```bash
cp .dev.vars.example .dev.vars   # set ADMIN_PASSWORD
npm run dev                      # http://localhost:8787  (admin at /admin)
npm test
```

```
src/index.js         router (only /api/* hits the worker; everything else is static)
src/availability.js  slot engine (time zones, buffers, notice, daily limits, overrides)
src/bookings.js      public booking API + GHL sync
src/admin.js         admin API + password session
src/ghl.js           GoHighLevel API v2 client
public/              booking page, admin panel, embed.js
migrations/          D1 schema + seed sessions
```
