# Product Requirements Document — Tips Tracker

**Status:** As-built (this document describes the shipped product, not a future proposal).
**Last updated:** 28 September 2026

## 1. Problem

An Irish multi-branch food business needed a way to:
- Record daily cash/credit tips per branch and split them fairly among staff by hours worked.
- Record delivery driver hours and pay, including an Irish minimum-wage top-up rule that only
  applies when a single driver works alone that day.
- Let a branch admin manage that branch's roster and rates without touching other branches.
- Let a business owner see and manage every branch from one place, without learning each
  branch's password.
- Keep a durable, off-machine copy of the underlying business data for reporting/backup, without
  standing up and paying for a database.

## 2. Users and roles

| Role | Scope | Can do |
|---|---|---|
| Staff | One branch | Log tip entries and delivery entries; view that branch's history. |
| Admin | One branch | Everything Staff can, plus manage employees/drivers, edit or delete past entries, change that branch's passwords and pay rates. |
| Owner | Every branch | Add/edit/delete branches (and their passwords); open any branch's dashboard directly; view cross-branch Analytics; connect Google Sheet sync; change the owner password; optionally sign in with Google instead of a password. |

Roles are enforced server-side on every request — the frontend hiding a button is not the
security boundary (see TRD.md, "Authorization model").

## 3. Core features

1. **Tip Sheet** — per day: cash tips total, credit tips total, and each employee's hours that
   day. Tips split proportionally to hours worked. History view (daily/weekly/monthly/quarterly)
   with an expandable per-day breakdown per employee.
2. **Delivery Payout** — per day: number of drivers, then per driver: hours, deliveries per zone
   (4 zones), tips, cash-on-delivery orders collected. Pay = hours × driver rate + Σ(zone
   count × zone rate); topped up to hours × minimum wage only when exactly one driver worked
   that day and the raw pay falls short. Drivers can be saved one at a time as their shifts end.
3. **History (both kinds)** — Daily / Weekly / Monthly / Quarterly, with Prev/Next navigation,
   ISO week numbers in weekly labels, and per-person expandable day-by-day detail.
4. **Owner dashboard** — store management (create/edit/delete/open), and an **Analytics** panel:
   filter by store, employee or driver, metric (cash tips / credit tips / both / drivers' pay),
   period granularity (weekly/monthly/yearly) with a specific-period picker, and three views
   (bar chart, table, one chart per store).
5. **Google Sheet sync (optional)** — once the owner signs in with Google, a spreadsheet is
   created under that account and kept as a live mirror of employees/drivers/entries across every
   branch, synced in the background. Local files remain the fast/always-available copy; the Sheet
   is the durable off-machine one.
6. **Editing rules** — only a branch's admin can edit or delete a saved entry, except staff may
   keep completing *today's* delivery entry (e.g. adding the next driver) without elevating.

## 4. Non-goals

- Not a payroll system — it computes what's owed, but doesn't run payroll or file taxes.
- Not multi-tenant SaaS — one deployment serves one business's branches.
- Not built for public/anonymous use — every page requires a branch, admin, or owner login.

## 5. Success criteria

- A staff member can log a full day's tips or deliveries in under a minute.
- Pay calculations match the documented formulas exactly (verified by hand in README.md).
- An owner can answer "how much did Branch B pay out in cash tips last month?" in under 10 seconds
  via the Analytics panel, without exporting anything.
- No branch can see or affect another branch's data except through the owner.

## 6. Open questions for a real deployment

- Legal business name, contact address, and governing jurisdiction for the Privacy Policy/Terms
  (currently placeholders — see `frontend/privacy-policy.html` and `frontend/terms.html`).
- Hosting choice for anything beyond local + tunnel (see README.md "Deployment").
