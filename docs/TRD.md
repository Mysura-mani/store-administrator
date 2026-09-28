# Technical Requirements Document — Tips Tracker

**Status:** As-built. **Last updated:** 28 September 2026

## 1. Stack

- **Runtime:** Node.js, Express 4. Runs either as a normal long-running process (`npm start`) or
  as a single Vercel serverless function (`api/index.js` re-exports the same Express app).
- **Frontend:** Static HTML/CSS/vanilla JS, no build step, no framework — served directly by
  Express (`express.static`). Chart.js loaded from the jsdelivr CDN for the Analytics charts.
- **Storage:** A single Google Sheet — no local files, no SQL/NoSQL database. `backend/lib/
  sheetsClient.js` provides generic row CRUD; `backend/lib/store.js` builds every entity on it.
  This is what makes the app deployable to a host with no writable/persistent disk.
- **Auth:** A stateless, HMAC-signed session cookie (no server-side session store — see §8) +
  `bcryptjs` password hashing. Optional Google OAuth 2.0 (`google-auth-library`) for the Owner's
  identity only; separately, a static Google refresh token (env var) authenticates the app's own
  access to the Sheet, independent of any interactive login.
- **External services:** Google Sheets API (required), Google OAuth (required for the Sheets
  connection; optionally also used for the Owner's interactive login), Chart.js via CDN (owner
  dashboard only).

## 2. Architecture

```
api/index.js         Vercel serverless entrypoint — re-exports backend/server.js
vercel.json           Routes every request to api/index.js
backend/
  server.js          Express app: routes, stateless session cookie, auth middleware, security middleware
  lib/store.js       Data layer — all business/pay math, validation, and Sheets-backed CRUD
  lib/sheetsClient.js Low-level Google Sheets access: auth client, generic row get/append/update/delete
frontend/
  *.html          One page per screen; each has its own inline <script>
  common.js       Shared helpers: fetch wrapper, session/shell rendering, escapeHtml, date utils
  styles.css      All styling
```

One Express app (module-exported, not just `app.listen()`-ed) serves both the frontend files and
the `/api/*`/`/auth/*` routes — no separate frontend build or deploy step, and no code fork between
the local-dev and serverless-production entrypoints.

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

## 7. Google Sheets as the only datastore

- Every read/write goes directly and synchronously (`await`ed within the request) to the Sheet via
  `backend/lib/sheetsClient.js` — there's no local cache, no background sync, no eventual
  consistency. What the Sheet says right now is authoritative.
- The Sheets API client authenticates with a **static** refresh token
  (`GOOGLE_REFRESH_TOKEN` env var), obtained once and never rotated by the app itself — unlike an
  earlier design, there's no code path that discovers and persists a token at runtime, since a
  serverless function has nowhere durable to put it.
- Row-level CRUD: `getRows` (full-tab read, tagged with each row's real sheet row number),
  `appendRow`, `updateRow(tab, headers, rowNumber, obj)`, `deleteRow(tab, rowNumber)` (via a
  `batchUpdate` `deleteDimension` request, needing that tab's internal numeric `sheetId`/gid,
  fetched and cached in-process). An update/delete always re-fetches the current row number
  immediately before acting — never reuses a row number computed earlier in the same request
  chain — since another write could have shifted rows in between.
- `store.ensureSeeded()` runs once per process (memoized promise), lazily on the first request
  that needs it (there's no other "startup" moment on a serverless host): creates every tab with
  its header row if missing, and seeds default branches/owner password into `Config` if that tab
  has none yet.
- Config (branches, password hashes, rates, owner account) lives in the same Sheet, in a `Config`
  tab of key/value rows — see `BACKEND_SCHEMA.md` §1. This, not environment variables, is what
  makes "Add a store" / "change a password" through the owner UI actually persist.

## 7a. Why not keep a local cache (the earlier design)

An earlier iteration kept local JSON files as the fast primary copy and treated the Sheet as an
eventually-consistent mirror kept in sync by a background job. That's no longer possible once the
app needs to run as a stateless serverless function with no persistent disk at all — the Sheet had
to become the primary store outright. The tradeoff is per-request Sheets API latency (typically low
hundreds of ms) instead of instant local reads; acceptable for this app's traffic volume, and kept
in check by the "one row per entry" schema (§ below) rather than one row per employee-shift.

## 8. Security hardening

- `helmet` (CSP, X-Frame-Options, nosniff, HSTS, etc.) — `script-src`/`style-src` include
  `'unsafe-inline'` because the app has no build step and every page is one inline
  `<script>`/uses inline `style="..."` attributes; the primary XSS defense is therefore
  **output escaping**, not CSP.
- `escapeHtml()` (`frontend/common.js`) wraps every user-supplied string (employee/driver/branch
  names, notes) before it's interpolated into an `innerHTML` template — closes a stored-XSS class
  of bug found during the pre-publish security review (see `SECURITY_REVIEW.md`).
- Session is a stateless, HMAC-signed cookie (`cookie-parser`'s signed-cookie support, keyed by
  `SESSION_SECRET`) — not a server-side session store, since a serverless instance can't guarantee
  a later request lands on the same process. `httpOnly`, `sameSite: "lax"`, `secure: req.secure`
  (correctly reflects HTTPS behind a reverse proxy via `app.set("trust proxy", 1)`), 12-hour
  expiry. `SESSION_SECRET` **must** be a fixed value (not left blank) once more than one process
  might handle requests — a randomly-generated fallback would make different instances reject each
  other's cookies.
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
