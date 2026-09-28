# Backend Schema — Tips Tracker

**Status:** As-built. **Last updated:** 28 September 2026

There is no SQL/NoSQL database and no local file storage — everything lives in the single Google
Sheet identified by `GOOGLE_SHEET_ID`, in five tabs. `backend/lib/sheetsClient.js` provides generic
row-level CRUD (`getRows`/`appendRow`/`updateRow`/`deleteRow`) that `backend/lib/store.js` builds
every entity on top of. The app creates every tab and its header row automatically the first time
it runs against a Sheet that doesn't have them yet.

## 1. `Config` tab — key/value rows

Branch credentials, rates, and the owner account, as one row per key (column A = key, column B =
value). `branches` is a JSON-encoded array; everything else is a plain string. Every password
field is a bcrypt hash — the plain password is never stored.

| key | value |
|---|---|
| `branches` | `[{"id":"A","name":"Branch A","staffPasswordHash":"$2a$10$...","adminPasswordHash":"$2a$10$...","rates":{"driverHourlyRate":6,"minimumWage":14.15,"zoneRates":[3,3.5,4,5]}}, ...]` |
| `ownerPasswordHash` | `$2a$10$...` |
| `ownerGoogleEmail` | `owner@gmail.com` (or blank — the one authorized Gmail address for "Sign in with Google") |

A branch's `id` is a slug generated from its name (`slugify()` + a numeric suffix on collision) —
always lowercase alphanumeric-and-hyphens, which is also why it's safe to use unescaped as an HTML
attribute value or DOM element ID on the frontend.

## 2. `Employees` / `Drivers` tabs

One row per employee/driver. Identical shape for both:

| id | branchId | name | active |
|---|---|---|---|
| `<uuid>` | `A` | `Alex` | `TRUE` |

## 3. `Entries` tab (Tip Sheet)

One row per day's tip entry. `shiftsJson` holds the per-employee hours as a JSON array — the only
place this app still uses a JSON-in-a-cell column, because an entry's shift list is variable-length
and needs to round-trip exactly for editing (unlike a reporting export, this tab is live operational
storage, so completeness wins over every column being individually chartable).

| id | branchId | date | cashTips | creditTips | shiftsJson |
|---|---|---|---|---|---|
| `<uuid>` | `A` | `2026-09-28` | `30` | `10` | `[{"employeeId":"<uuid>","hours":5}]` |

`cashShare`/`creditShare` per employee are **computed on read** (`computeShares()` in
`backend/lib/store.js`), proportional to hours worked that day — never stored, so they can't drift
out of sync with `cashTips`/`creditTips`/`shiftsJson`.

## 4. `DeliveryEntries` tab (Delivery Payout)

One row per day's delivery entry. `driversJson` holds the full per-driver detail as a JSON array —
hours, per-zone delivery counts, raw cash-collection order amounts, tips, and an optional note.

| id | branchId | date | driverCount | driversJson |
|---|---|---|---|---|
| `<uuid>` | `A` | `2026-09-28` | `1` | `[{"driverId":"<uuid>","hours":5,"zoneCounts":[3,0,0,0],"cashOrders":[10,20],"tips":5,"note":""}]` |

`driverCount` is the *declared* headcount for the day (set up front, before any driver's individual
details are filled in) — it's what decides the solo/multi minimum-wage rule, independent of how many
driver rows have actually been saved so far (drivers can be saved one at a time as their shifts end).

`basePay`, `deliveryPay`, `finalPay`, `topUpApplied`, `cashOrderCount`, `cashOrderValue`
(`computeDeliveryPay()` in `backend/lib/store.js`) are **computed on read** from the raw fields
above plus the branch's *current* rates — never stored, which also means a later rate change
retroactively changes how past entries display (a pre-existing, intentional tradeoff: no migration
needed when rates change, at the cost of history not being frozen at save-time).

## 5. Flattened cross-branch dataset (owner analytics)

`store.getAnalyticsData()` reshapes tabs 2–4 above into one row per employee-shift / driver-day,
computed fields included — used by `GET /api/owner/analytics` (the owner dashboard's Analytics
panel):

```jsonc
{
  "branches": [{ "id": "A", "name": "Branch A" }],
  "employees": [{ "id": "<uuid>", "branchId": "A", "name": "Alex", "active": true }],
  "drivers": [{ "id": "<uuid>", "branchId": "A", "name": "Sam", "active": true }],
  "tipRows": [
    { "entryId": "<uuid>", "branchId": "A", "date": "2026-09-28", "employeeId": "<uuid>", "hours": 5, "cashTips": 30, "creditTips": 10 }
  ],
  "deliveryRows": [
    {
      "entryId": "<uuid>", "branchId": "A", "date": "2026-09-28", "driverId": "<uuid>", "hours": 5,
      "zoneCounts": [3, 0, 0, 0], "basePay": 30, "deliveryPay": 9, "tips": 0,
      "topUpApplied": true, "finalPay": 70.75, "cashOrderCount": 2, "cashOrderValue": 30, "note": ""
    }
  ]
}
```

## 6. IDs

Every `id` (employee, driver, entry, delivery entry) is `crypto.randomUUID()`.

## 7. Why one row per entry, not one row per employee-shift

An earlier iteration of this Sheet flattened `Entries`/`DeliveryEntries` to one row per
employee-shift / driver-day with every field in its own column, optimized for pivoting directly in
Sheets. Once the Sheet became this app's *only* datastore (not a reporting mirror alongside local
files), round-trip fidelity for editing took priority — updating or deleting a multi-row entry via
the Sheets API is materially more failure-prone (partial writes, row-index drift) than a single-row
read/write/delete. The owner Analytics panel (§5) still gives the fully flattened, chartable view;
it's just computed on demand rather than being the Sheet's own row layout.
