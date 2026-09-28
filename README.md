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

**New here?** [docs/PRD.md](docs/PRD.md) (what this is and who it's for),
[docs/TRD.md](docs/TRD.md) (how it's built), [docs/APP_FLOW.md](docs/APP_FLOW.md)
(screen-by-screen walkthrough), [docs/BACKEND_SCHEMA.md](docs/BACKEND_SCHEMA.md)
(the actual data shapes), [docs/UI_UX_DESIGN_BRIEF.md](docs/UI_UX_DESIGN_BRIEF.md),
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) (what's done vs. what's
next), and [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) (the pre-publish
security audit and fixes) cover this project end to end.

## Run it

This app has no local database — every branch/owner credential and every
piece of business data lives in a Google Sheet, so it needs a few
environment variables before it can do anything, including a first login.

```bash
npm install
cp .env.example .env   # then follow the instructions inside it
npm start
```

Then open http://localhost:3000 in your browser. The Sheet's tabs and
default branch/owner passwords are created automatically the first time the
server runs against a blank Sheet.

## Project structure

```
tips-tracker/
├── api/index.js           Vercel's serverless entrypoint — just re-exports backend/server.js
├── vercel.json             Routes every request to api/index.js
├── backend/
│   ├── server.js          Routes, stateless signed-cookie sessions, auth middleware
│   ├── lib/store.js       Data model, validation, pay/tip math, history queries
│   └── lib/sheetsClient.js Low-level Google Sheets read/write (the only "database" this app has)
├── frontend/               Static site served by the backend — plain HTML/CSS/JS, no build step
│   ├── *.html              One page per screen (login, dashboard, entry, history, settings, ...)
│   ├── privacy-policy.html, terms.html, cookie-policy.html   Legal pages (templates — see below)
│   ├── common.js            Shared fetch/session/render helpers used by every page
│   └── styles.css           All styling
├── docs/                  Planning & reference docs (PRD, TRD, app flow, schema, security review)
└── .github/workflows/      CI (syntax-checks the backend on every push/PR)
```

Everything runs from one Express app (`backend/server.js`, exported as a
module) that both serves the `frontend/` files and answers the `/api/*`
routes — run directly with `node`/`npm start` locally, or imported by
`api/index.js` as a single Vercel serverless function in production. There's
no separate frontend build/deploy — editing an HTML file under `frontend/`
takes effect on the next page load either way.

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
- **Explore an Analytics panel** below the store list — filter by store,
  employee or driver, metric (cash tips / credit tips / both / drivers' pay),
  and period (weekly/monthly/yearly), then view the result as a bar chart, a
  plain table, or one small chart per store side by side. Everything is
  computed client-side from `/api/owner/analytics`, so switching filters or
  chart type is instant.

The owner password is stored the same way as everything else — hashed, in
the Sheet's `Config` tab — seeded automatically the first time the server
runs against a blank Sheet.

### Where everything is stored: one Google Sheet

There is no local database of any kind. Every branch/admin/owner password
hash, every pay rate, and every employee/driver/tip-entry/delivery-entry
lives in the single Google Sheet identified by `GOOGLE_SHEET_ID` — read and
written directly on every request. See `.env.example` for the one-time setup
(enabling the Sheets API, creating an OAuth client, and minting a refresh
token) and [docs/BACKEND_SCHEMA.md](docs/BACKEND_SCHEMA.md) for the exact tab
layout. The app creates every tab and its header row automatically the first
time it runs against a Sheet that doesn't have them yet — you never need to
set anything up inside the Sheet by hand.

This is also what makes the app deployable to Vercel (see **Deployment**
below): there's no writable local disk to depend on, since a serverless
function has none.

### Owner sign-in with Google (optional, identity only)

As an alternative to the owner password, the owner can sign in with a real
Gmail account instead — this is a separate, opt-in feature from the Sheets
connection above and only proves *who* the owner is; it doesn't affect where
data is stored. The password keeps working either way.

To turn it on:

1. Log in as Owner with the password, go to **Settings**, and enter the
   exact Gmail address that should be allowed to sign in — only that one
   address will ever be accepted.
2. A "Continue with Google" button now appears on the login page whenever
   "Owner" is selected, using the same `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
   already configured for the Sheets connection.

- On the login page, pick a branch and enter its **staff password** to open
  that branch's dashboard, where you choose Tip Sheet or Delivery. Each
  branch has its own employees, drivers, tip history and delivery history —
  nothing is shared between branches.
- Inside either section, click the **Admin** button next to the Staff badge
  and enter that branch's **admin password** to unlock Employees, Drivers,
  and Settings (manage rosters, change either password, edit delivery
  rates). The same admin password unlocks both sections.

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

Clear the `Config` tab's rows (keep the header) in the Google Sheet to
regenerate the branch passwords and default rates from `backend/lib/store.js`
on the next request (does not touch history). Clear the `Employees`,
`Drivers`, `Entries`, and `DeliveryEntries` tabs' rows (keep each header) to
wipe all business data for every branch.

## Deployment

The app has no local storage and no in-memory session store (sessions are a
signed cookie, verified statelessly on every request — see
[docs/TRD.md](docs/TRD.md) §8), so it runs equally well as a normal
long-running Node process (a VPS, Render, Railway, Fly.io, or your own
machine via `npm start` plus a tunnel) **or** as a Vercel serverless
deployment:

1. Push this repo to GitHub (already done if you're reading this from there).
2. In Vercel, "Add New Project" → import the GitHub repo. Vercel detects
   `vercel.json`/`api/index.js` automatically — no build command needed.
3. Add every variable from `.env.example` under the project's **Environment
   Variables** settings (use your production `GOOGLE_REDIRECT_URI`, e.g.
   `https://your-project.vercel.app/auth/google/callback`, and add that exact
   URL to the OAuth client's Authorized redirect URIs in Google Cloud
   Console too).
4. Deploy. Every subsequent push to the connected branch redeploys
   automatically — that's Vercel's standard GitHub integration, no extra
   CI/CD setup needed beyond what's already in `.github/workflows/ci.yml`.

## Legal pages

`frontend/privacy-policy.html`, `frontend/terms.html`, and
`frontend/cookie-policy.html` are **templates**, linked from the login
page's footer. Each has a notice at the top and `[bracketed]` placeholders
for your actual business name, contact details, and governing jurisdiction —
fill those in and have the pages reviewed by someone qualified for your
jurisdiction before relying on them, especially if you operate in or serve
users in the EU/UK (GDPR) or California (CCPA/CPRA).

## Security

See [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) for the pre-publish
security audit (methodology, findings, and fixes — including a stored-XSS
class of bug that was found and fixed). In short: `helmet` security headers,
rate limiting on every password-checking route, all user-supplied text
escaped before it reaches the page (see `escapeHtml` in
`frontend/common.js`), a 6-character password minimum, and `npm audit`
clean at time of writing. Re-run `npm audit` periodically as dependencies
age.
