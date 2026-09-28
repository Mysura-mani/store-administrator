# App Flow — Tips Tracker

**Status:** As-built. **Last updated:** 28 September 2026

## 1. Login

```
/login.html
  ├─ pick a Store (Branch A–D, or "Owner") from the dropdown
  ├─ enter that store's staff password  ──────────────► role=staff  ─► /dashboard.html
  ├─ (Owner) enter the owner password   ──────────────► role=owner  ─► /owner-dashboard.html
  └─ (Owner) "Continue with Google" (if configured & enabled)
         → Google account chooser → consent → /auth/google/callback
         → verifies the signed-in email matches the one authorized address
         → role=owner ─► /owner-dashboard.html
```
Wrong branch/owner password → inline error above "WELCOME BACK". Any active session already
logged in skips straight past this page.

## 2. Branch dashboard (staff/admin)

```
/dashboard.html (Overview)
  ├─ stat cards: tips this week, delivery pay this week, employee count, driver count
  ├─ Quick actions → Tip Sheet | Delivery
  └─ sidebar: Overview · Tip Sheet · Delivery · Tip History · Delivery History
              (admin only: Employees · Drivers · Settings)
              Admin unlock (staff) · ← Back to Owner (if opened via owner) · Log out
```

### Tip Sheet
```
/entry.html
  date → cash tips total → credit tips total → per-employee hours (add/remove rows)
  Save ─► POST /api/entries (or PUT if editing) ─► split proportionally to hours
```

### Delivery Payout
```
/delivery-entry.html
  date → "number of drivers today" (declares solo/multi for the minimum-wage rule)
       → auto-creates that many driver cards
  per driver card: pick driver, hours, deliveries per zone (×4), tips, cash-on-delivery
                   orders (count → per-order value fields), note
       → live color-coded total (green = topped up to minimum wage, orange = above floor)
       → "Save this driver" (independent per card — a driver can be saved as soon as
          their shift ends, without waiting for the others)
  Reopening the same date reloads whatever's saved so far.
```

### History (Tip / Delivery)
```
/history.html, /delivery-history.html
  period tabs: Daily · Weekly · Monthly · Quarterly, with ◀ Prev / Next ▶
  table: one row per employee/driver, click to expand → day-by-day breakdown
  admin only: "Edit" on a day-row jumps back into the entry form for that date
```

### Employees / Drivers / Settings (admin only)
```
/employees.html, /drivers.html
  add by name; rename inline; Deactivate/Reactivate (soft-delete — history stays intact)

/settings.html
  change this branch's staff password
  change this branch's admin password (requires the current admin password)
  edit pay rates: driver hourly rate, minimum wage, 4 zone rates
```

## 3. Owner dashboard

```
/owner-dashboard.html
  Stores view (default):
    ├─ store cards grid: Open dashboard | Edit | Delete, per branch
    ├─ + Add store → name + staff password + admin password → new branch, ready to use
    └─ Analytics panel (below the store grid):
         filters: Store · Metric · Employee/Driver (swaps based on metric)
                  · Period (weekly/monthly/yearly) · a specific-period picker
                  · View (Bar chart / Table / one chart per store)
         → fetches /api/owner/analytics once, filters/buckets entirely client-side

  Settings view:
    ├─ change owner password
    ├─ Google Sign-In: set the one authorized Gmail address (turns the button on/off)
    └─ Google Sheet sync: status, Open Google Sheet, Sync now, Disconnect

  "Open dashboard" on a store card:
    POST /api/owner/branches/:id/open → session becomes admin for that branch,
    viaOwner=true → redirected to /dashboard.html with a "← Back to Owner" button
    that returns to the owner dashboard without needing that branch's password.
```

## 4. Session lifecycle

- Login sets `req.session.role` (+`branchId` unless owner).
- Logout: `POST /api/logout` destroys the session outright.
- Every protected page's script calls `requireSession()` (common.js) on load, which hits
  `GET /api/session`; a 401 redirects to `/login.html` before rendering anything sensitive.
- Sessions expire after 12 hours of cookie lifetime or a server restart (in-memory store).
