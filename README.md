# Tips Tracker

A small local website for logging daily cash/credit tips and delivery driver
pay per branch, with weekly/monthly history dashboards. After logging in to
a branch, staff choose between two sections:

- **Tip Sheet** — log daily cash/credit tips, split among employees by hours
  worked.
- **Delivery** — log driver hours and deliveries per zone, with pay
  calculated automatically (including an Irish minimum-wage top-up on solo
  days).

There's also a separate **Owner** login (a super-admin over every store — see
[Owner account](#owner-account) below).

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000 in your browser.

## Project structure

```
tips-tracker/
├── backend/               Express server and all data/business logic
│   ├── server.js          Routes, sessions, auth middleware
│   ├── lib/store.js       Data model, validation, pay/tip math, history queries
│   └── data/              Runtime JSON storage (gitignored, created on first run)
├── frontend/               Static site served by the backend — plain HTML/CSS/JS, no build step
│   ├── *.html              One page per screen (login, dashboard, entry, history, settings, ...)
│   ├── common.js            Shared fetch/session/render helpers used by every page
│   └── styles.css           All styling
└── .github/workflows/      CI (syntax-checks the backend on every push/PR)
```

Everything runs from one Express process (`backend/server.js`) that both
serves the `frontend/` files and answers the `/api/*` routes. There's no
separate frontend build/deploy — editing an HTML file under `frontend/`
takes effect on the next page load.

- **Want to change how something looks or behaves in the browser?** Edit the
  relevant file in `frontend/`.
- **Want to change a calculation, validation rule, or what's stored?** Edit
  `backend/lib/store.js`.
- **Want to add or change an API route, auth rule, or session behavior?**
  Edit `backend/server.js`.

## Branches & passwords

Four branches are pre-configured (edit `DEFAULT_BRANCHES` in
[backend/lib/store.js](backend/lib/store.js) to change these before first run):

| Branch | Staff password | Admin password |
|--------|-----------------|-----------------|
| A      | `a123`          | `aadmin123`     |
| B      | `b123`          | `badmin123`     |
| C      | `c123`          | `cadmin123`     |
| D      | `d123`          | `dadmin123`     |

## Owner account

The **Owner** login (default password `owner123`, changeable from the owner
dashboard's Settings page) sits above all branches. From the Owner
Dashboard, the owner can:

- See every store at a glance.
- **Add a store** — pick a name, get a staff + admin password, and it's
  immediately usable from the login page. The store's internal ID is
  auto-generated from its name (e.g. "Downtown Store" → `downtown-store`).
- **Edit a store** — rename it and/or reset its staff and/or admin password,
  without needing to know the old one.
- **Delete a store** — permanently removes it and all of its employees,
  drivers, and history. This cannot be undone.
- **Open a store's dashboard** directly (as that store's admin) to look
  into or manage its day-to-day data, with a "← Back to Owner" button to
  return.

The owner password is stored the same way as everything else — hashed in
`backend/data/config.json`, seeded automatically (including for
already-existing installs, which get the owner account backfilled on next
start).

- On the login page, pick a branch and enter its **staff password** to open
  that branch's dashboard, where you choose Tip Sheet or Delivery. Each
  branch has its own employees, drivers, tip history and delivery history —
  nothing is shared between branches.
- Inside either section, click the **Admin** button next to the Staff badge
  and enter that branch's **admin password** to unlock Employees, Drivers,
  and Settings (manage rosters, change either password, edit delivery
  rates). The same admin password unlocks both sections.

Passwords are stored hashed (never in plain text) in `backend/data/config.json`,
generated automatically the first time the server runs. Employees, drivers,
tip entries and delivery entries are stored per-branch in `backend/data/data.json`.
Neither file is committed to git.

## How tip splitting works

For each day you log: total cash tips, total credit tips, and each
employee's hours worked that day. Every employee's share of that day's cash
(and separately credit) tips is:

```
employee_share = (employee_hours / total_hours_that_day) * total_tips
```

The **History** page adds these shares up per employee over the selected
period — Daily, Weekly, Monthly, or Quarterly, with Prev/Next navigation —
and each employee's row expands to show the day-by-day breakdown behind
that total. Weekly labels also show the ISO week number, e.g. "Sep 28 – Oct
4, 2026 (Week 40)".

## How delivery pay works

For each day you log: each driver's hours worked and how many deliveries
they made in each of the 4 zones. A driver's raw pay for that day is:

```
raw_pay = (hours * driver_hourly_rate) + sum(zone_count[i] * zone_rate[i])
```

**If that driver was the only one logged for that day**, their pay is
topped up to the legal minimum whenever the raw pay falls short of it:

```
final_pay = max(raw_pay, hours * minimum_wage)
```

The moment a second driver is added to that same day, the top-up no longer
applies to anyone that day — both drivers are paid exactly their raw pay
(hours × rate + their own deliveries), same as the "greater amount" rule:
a solo driver who earns more than the minimum-wage floor from deliveries
keeps the higher actual amount, never just the floor.

Default rates (all editable per branch on the Settings page): €6/hour driver
rate, €14.15/hour minimum wage, and €3 / €3.50 / €4 / €5 for zones 1–4.

On the **Delivery Payout** page, you first set "Number of drivers today"
next to the date — that number both drives the minimum-wage rule above and
automatically creates that many driver cards to fill in. Each card shows a
live, color-coded Total as you type: green means that driver's pay was
topped up to the minimum-wage floor, orange means they earned more than the
floor and kept the higher amount.

Each driver card has its own **Save this driver** button, so if drivers
finish their shifts at different times you don't need everyone's numbers at
once — save Driver 1 as soon as they're done, and Driver 2 later. Opening
the Delivery Payout page again for a date that already has a (possibly
partial) entry automatically loads what's saved so far, so the next driver
can be added without redoing the first. The declared "Number of drivers"
stays the source of truth for the minimum-wage rule throughout, regardless
of how many of those drivers have actually been saved yet.

Each driver card also has a **Tips** field — a euro amount added on top of
pay *after* the minimum-wage comparison, regardless of whether the floor
applied or not. A solo driver topped up to €70.75 who also earned a €5 tip
is paid €75.75; tips never affect whether the floor kicks in.

Each driver card also has **Cash collection orders** — cash the driver
collected from customers that they owe back to the till, tracked separately
from their own pay. Enter how many cash orders they took and that many
"Order value" boxes appear; the total "Cash to return" is summed
automatically. An optional **Note** field next to it is for any remarks
about that day's cash orders (e.g. a refund or a payment issue).

The **Delivery History** page mirrors the Tip Sheet's History page, with
the same Daily/Weekly/Monthly/Quarterly periods: totals per driver (hours,
base pay, delivery pay, tips, total pay, cash to return), expandable to a
day-by-day breakdown showing the zone counts, any note, and the
color-coded pay for that day.

## Editing a saved entry

Only a branch's admin can edit or delete an entry once it's saved — staff
can create new entries (Tip Sheet or Delivery Payout) but can't retroactively
change one. The one exception: staff can keep adding drivers to a Delivery
Payout entry for **today** without elevating (e.g. saving Driver 2 after
Driver 1 already left), since that's completing the day, not correcting
history. The moment an entry's date is anything other than today, editing
or deleting it requires the branch admin password.

## Resetting

Delete `backend/data/config.json` to regenerate the branch passwords and
default rates from `backend/lib/store.js` (does not touch history). Delete
`backend/data/data.json` to wipe all employees, drivers, and entries for
every branch.

## Deployment

This app stores its data in local JSON files and keeps sessions in memory,
so it needs a host that runs a persistent Node process with a writable
disk (e.g. a VPS, Render, Railway, Fly.io — or simply your own machine via
`npm start` plus a tunnel). It is **not** compatible with Vercel or other
serverless platforms as-is: their filesystem is read-only/ephemeral, so
every save (a new entry, a password change, a new employee) would fail or
silently disappear. Moving to serverless would require replacing
`backend/data/*.json` with a real hosted database first.
