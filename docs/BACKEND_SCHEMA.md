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

One plain row per employee-shift — not one JSON-blob row per day. `entryId` groups the rows that
make up a single saved entry back together (an entry with 3 employees working that day is 3 rows,
all sharing the same `entryId`); `cashTips`/`creditTips` are the day's totals, repeated on every row
for that `entryId` so each row is independently readable without cross-referencing anything else.

| id | entryId | branchId | date | employeeId | employeeName | hours | cashTips | creditTips |
|---|---|---|---|---|---|---|---|---|
| `<uuid>` | `<uuid>` | `A` | `2026-09-28` | `<uuid>` | `Alex` | `5` | `30` | `10` |

`employeeName` is denormalized (copied in at save time) purely so the row means something at a
glance without opening the `Employees` tab — it isn't kept in sync if the employee is later renamed,
which is a feature here, not a bug: it's what the roster actually was on that day.

`cashShare`/`creditShare` per employee are **computed on read** (`computeShares()` in
`backend/lib/store.js`), proportional to hours worked that day — never stored, so they can't drift
out of sync with `cashTips`/`creditTips`/the shift rows.

Editing an entry (the set of employees/hours can change between saves) deletes every row for that
`entryId` and re-appends fresh ones, rather than trying to update them one-for-one — see
`writeEntryRows()`/`updateEntry()` in `backend/lib/store.js`.

## 4. `DeliveryEntries` tab (Delivery Payout)

One plain row per driver-day, grouped back into an entry by `entryId` the same way as `Entries`
above. Every field is its own column except `cashOrdersJson`: the individual cash-on-delivery order
amounts a driver collected that shift are a genuinely variable-length list (could be zero orders or
a dozen), so that one stays a small JSON array rather than an unbounded number of columns — it's
needed verbatim (not just a count/total) so editing an entry can re-show each amount for correction.

| id | entryId | branchId | date | driverCount | driverId | driverName | hours | zone1Count | zone2Count | zone3Count | zone4Count | tips | note | cashOrdersJson |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<uuid>` | `<uuid>` | `A` | `2026-09-28` | `1` | `<uuid>` | `Sam` | `5` | `3` | `0` | `0` | `0` | `5` | `` | `[10,20]` |

`driverCount` is the *declared* headcount for the day (set up front, before any driver's individual
details are filled in) — it's what decides the solo/multi minimum-wage rule, independent of how many
driver rows have actually been saved so far (drivers can be saved one at a time as their shifts end)
— and is repeated on every row for that `entryId`, same as `cashTips`/`creditTips` above.

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

## 7. Why one row per employee-shift, not one JSON-blob row per entry

An earlier iteration of this app stored one row per day's entry, with the per-employee/per-driver
detail packed into a `shiftsJson`/`driversJson` column — optimized for round-trip fidelity (a
single-row update/delete is less failure-prone than juggling several rows) at the cost of the Sheet
itself being unreadable to anyone who isn't the app. Since the whole point of this architecture is
that the owner's data lives in a Sheet *they* can open and understand — not just a store the app
happens to use — readability won out: every field that can reasonably be its own column now is one
(see §3/§4), and editing an entry deletes and re-appends its rows rather than updating a single blob
cell. The owner Analytics panel (§5) still gives the fully flattened, chartable view across
branches; it's just computed on demand rather than being the only place this data is readable.
