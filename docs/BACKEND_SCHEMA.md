# Backend Schema — Tips Tracker

**Status:** As-built. **Last updated:** 28 September 2026

There is no SQL/NoSQL database — this documents the shape of the two JSON files under
`backend/data/` (both gitignored) and the flattened dataset served to the owner's Analytics panel
and Google Sheet sync.

## 1. `backend/data/config.json`

Branch credentials/rates, the owner account, and Google Sheets sync state. Every password field
is a bcrypt hash — the plain password is never stored.

```jsonc
{
  "branches": [
    {
      "id": "A",                          // slug, generated from the name, globally unique
      "name": "Branch A",
      "staffPasswordHash": "$2a$10$...",
      "adminPasswordHash": "$2a$10$...",
      "rates": {
        "driverHourlyRate": 6,
        "minimumWage": 14.15,
        "zoneRates": [3, 3.5, 4, 5]        // fixed length 4, one per delivery zone
      }
    }
  ],
  "ownerPasswordHash": "$2a$10$...",
  "ownerGoogleEmail": "owner@gmail.com",    // or null — the one authorized Gmail address
  "googleSheets": {                          // absent until the owner connects Google
    "refreshToken": "1//...",                // NEVER returned by any API response
    "sheetId": "1kCXE8Tl...",
    "sheetUrl": "https://docs.google.com/spreadsheets/d/.../edit",
    "dirtyTabs": ["Employees", "Entries"],    // tabs pending the next sync
    "lastSyncedAt": "2026-09-28T17:20:29.000Z",
    "lastError": null
  }
}
```

## 2. `backend/data/data.json`

Per-branch employees, drivers, and entries.

```jsonc
{
  "branches": {
    "A": {
      "employees": [
        { "id": "<uuid>", "name": "Alex", "active": true }
      ],
      "drivers": [
        { "id": "<uuid>", "name": "Sam", "active": true }
      ],
      "entries": [                                    // Tip Sheet entries
        {
          "id": "<uuid>",
          "date": "2026-09-28",                        // YYYY-MM-DD
          "cashTips": 20,
          "creditTips": 10,
          "shifts": [
            { "employeeId": "<uuid>", "hours": 1 },
            { "employeeId": "<uuid>", "hours": 2 }
          ]
        }
      ],
      "deliveryEntries": [                              // Delivery Payout entries
        {
          "id": "<uuid>",
          "date": "2026-09-28",
          "driverCount": 1,                             // declared headcount — see TRD.md §5
          "drivers": [
            {
              "driverId": "<uuid>",
              "hours": 5,
              "zoneCounts": [3, 3, 3, 3],                // fixed length 4
              "cashOrders": [10, 20, 30],                // one entry per cash-on-delivery order
              "tips": 5,
              "note": ""
            }
          ]
        }
      ]
    }
  }
}
```

`shares`/pay fields (`cashShare`, `creditShare`, `basePay`, `deliveryPay`, `finalPay`,
`topUpApplied`, `cashOrderCount`, `cashOrderValue`, ...) are **computed on read**, in
`backend/lib/store.js` (`computeShares`, `computeDeliveryPay`), never stored — the stored data is
always just the raw inputs above, so a rate change never silently invalidates history.

## 3. Flattened analytics dataset

`store.getAnalyticsData()` (used by both `GET /api/owner/analytics` and the Google Sheets sync —
see TRD.md §7) reshapes the above into one row per employee-shift / driver-day, computed fields
included:

```jsonc
{
  "branches": [{ "id": "A", "name": "Branch A" }],
  "employees": [{ "id": "<uuid>", "branchId": "A", "name": "Alex", "active": true }],
  "drivers": [{ "id": "<uuid>", "branchId": "A", "name": "Sam", "active": true }],
  "tipRows": [
    {
      "entryId": "<uuid>", "branchId": "A", "date": "2026-09-28",
      "employeeId": "<uuid>", "hours": 1, "cashTips": 4, "creditTips": 2
    }
  ],
  "deliveryRows": [
    {
      "entryId": "<uuid>", "branchId": "A", "date": "2026-09-28",
      "driverId": "<uuid>", "hours": 5, "zoneCounts": [3, 3, 3, 3],
      "basePay": 30, "deliveryPay": 39, "tips": 5, "topUpApplied": false,
      "finalPay": 74, "cashOrderCount": 3, "cashOrderValue": 60, "note": ""
    }
  ]
}
```

This exact shape (minus `active`/inactive filtering differences) is what lands in the Google
Sheet's four tabs — see the README's "Sheet layout" section for the column-by-column mapping.

## 4. IDs

Every `id` (employee, driver, entry, delivery entry) is `crypto.randomUUID()`. Branch `id`s are
slugs generated from the branch name (`slugify()` + a numeric suffix on collision) — always
lowercase alphanumeric-and-hyphens, which is also why they're safe to use unescaped as HTML
attribute values or DOM element IDs.
