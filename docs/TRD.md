# Technical Requirements Document — Tips Tracker

**Status:** As-built. **Last updated:** 28 September 2026

## 1. Stack

- **Runtime:** Node.js, Express 4.
- **Frontend:** Static HTML/CSS/vanilla JS, no build step, no framework — served directly by
  Express (`express.static`). Chart.js loaded from the jsdelivr CDN for the Analytics charts.
- **Storage:** Local JSON files (`backend/data/config.json`, `backend/data/data.json`), plus an
  optional Google Sheet mirror. No SQL/NoSQL database.
- **Auth:** `express-session` (in-memory store) + `bcryptjs` password hashing. Optional Google
  OAuth 2.0 (`google-auth-library`) for the Owner only.
- **External services:** Google OAuth/Sheets API (optional, opt-in), Chart.js via CDN (owner
  dashboard only).

## 2. Architecture

```
backend/
  server.js       Express app: routes, session config, auth middleware, security middleware
  lib/store.js    Data layer — reads/writes the JSON files, all business/pay math, validation
  lib/sheets.js   Background sync of business data into the owner's Google Sheet
  data/           Runtime JSON storage (gitignored)
frontend/
  *.html          One page per screen; each has its own inline <script>
  common.js       Shared helpers: fetch wrapper, session/shell rendering, escapeHtml, date utils
  styles.css      All styling
```

One Express process serves both the frontend files and the `/api/*`/`/auth/*` routes — no
separate frontend build or deploy step.

## 3. Authorization model

Every mutating or data-scoped route runs through one of these middleware, and the frontend's UI
state is never trusted as the security boundary:

- `requireAuth` — session must have a role and a `branchId` (staff/admin).
- `requireAnyAuth` — as above, but also accepts `owner` (which has no `branchId`).
- `requireAdmin` — session role must be exactly `admin`.
- `requireOwner` — session role must be exactly `owner`.
- `requireAdminForPastEdit(getEntry)` — staff may edit/delete only if *both* the entry's existing
  date and the target date are today; anything else needs admin.

Branch-scoped data lookups (`store.getEntry(branchId, id)`, etc.) always filter by
`req.session.branchId` server-side, so one branch's staff/admin cannot read or modify another
branch's data even with a guessed entry ID (no IDOR).

Rate limiting (`express-rate-limit`, 20 requests / 15 min / IP) is applied to every route that
checks a password: `/api/login`, `/api/owner-login`, `/api/elevate-admin`,
`/api/owner/change-password`, `/api/settings/admin-password`.

## 4. Data model

See `BACKEND_SCHEMA.md` for the full JSON shapes.

## 5. Pay calculation (delivery)

```
raw_pay      = hours * driverHourlyRate + Σ(zoneCount[i] * zoneRate[i])
is_solo      = declared driverCount === 1   (not the count of rows actually saved)
pay_floor    = hours * minimumWage
pay_before_tips = is_solo ? max(raw_pay, pay_floor) : raw_pay
final_pay    = pay_before_tips + tips
```
Tips never factor into the floor comparison. `driverCount` is declared up front and stays
authoritative even while drivers are saved one at a time later in the day.

## 6. Date/time handling

All range math (weeks, months, quarters, ISO week numbers) is done with UTC-anchored
`Date.UTC(...)` construction and `getUTC*` reads — never `toISOString()` on a local-midnight
`Date`, which drifts a day in positive-UTC-offset timezones. "Today" defaults use local Y/M/D
components instead. The same ISO week algorithm (Monday-start, week 1 contains the year's first
Thursday) is implemented twice — `backend/lib/store.js: isoWeekNumber` and, ported to run
client-side, `frontend/owner-dashboard.html: isoWeekNumber` — so labels match everywhere.

## 7. Google Sheets sync design

- Local JSON remains the fast, always-available source every request reads/writes — the Sheet is
  a mirror, not the primary store.
- A write marks the relevant tab(s) dirty; a background timer (10s) plus a best-effort immediate
  attempt push the tab's *full current contents* to the Sheet (clear + rewrite, not incremental
  patches) — simple, idempotent, trivially retryable.
- Concurrent flush triggers share one in-flight promise (`flushNow()` in `lib/sheets.js`) rather
  than one silently no-op'ing while another runs.
- The owner's OAuth refresh token and the created spreadsheet ID live in `config.json`
  (gitignored) under `googleSheets`; never returned by any API response.
- Sheet columns are fully flattened (one row per employee-shift / driver-day) — no JSON blobs —
  specifically so the Sheet itself is pivot/chart-ready.

## 8. Security hardening

- `helmet` (CSP, X-Frame-Options, nosniff, HSTS, etc.) — `script-src`/`style-src` include
  `'unsafe-inline'` because the app has no build step and every page is one inline
  `<script>`/uses inline `style="..."` attributes; the primary XSS defense is therefore
  **output escaping**, not CSP.
- `escapeHtml()` (`frontend/common.js`) wraps every user-supplied string (employee/driver/branch
  names, notes) before it's interpolated into an `innerHTML` template — closes a stored-XSS class
  of bug found during the pre-publish security review (see `SECURITY_REVIEW.md`).
- Session cookie: `httpOnly`, `sameSite: "lax"`, `secure: "auto"` (correctly detects HTTPS behind
  a reverse proxy via `app.set("trust proxy", 1)`), 12-hour expiry.
- `express.json({ limit: "100kb" })` — bounds request body size.
- Password minimum raised from 4 to 6 characters, enforced both client- and server-side.
- A catch-all error handler returns a generic message and never leaks a stack trace to the client.
- `cors({ origin: false })` — explicit, auditable statement that no cross-origin caller is allowed
  (matches the app's actual same-origin architecture).
- Two layers of `express-rate-limit`: 20 req/15min/IP on password-checking routes specifically,
  300 req/15min/IP on all of `/api` and `/auth` generally (cost/DoS bound).
- `Permissions-Policy` denies geolocation/camera/microphone/payment/USB — unused by this app.
- A custom 404: JSON for `/api`/`/auth`, a styled page for everything else.
- `validateEntryInput`/`validateDeliveryEntryInput` only accept an `employeeId`/`driverId` that
  belongs to the acting branch, closing a cross-branch reference gap (see `SECURITY_REVIEW.md` #11).

Full findings and rationale: `SECURITY_REVIEW.md`.

## 9. Testing / CI

`.github/workflows/ci.yml`: `npm ci`, `node --check` on every backend file, and a
require-smoke-test. No unit/integration test suite exists yet — see `IMPLEMENTATION_PLAN.md`.
