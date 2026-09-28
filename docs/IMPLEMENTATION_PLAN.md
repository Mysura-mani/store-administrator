# Implementation Plan — Tips Tracker

**Status:** As-built + forward-looking. **Last updated:** 28 September 2026

## Phase 0 — Built (done)

- Core Tip Sheet + Delivery Payout entry and history, with Irish minimum-wage top-up logic.
- Branch-scoped staff/admin roles; same-day exception for staff completing a Delivery entry.
- Owner role: store management, cross-branch Analytics, "open a store" impersonation.
- Login page and Owner dashboard visual redesign (Pinterest/CollectUI references).
- Optional Owner "Sign in with Google" identity check.
- Repo restructured into `frontend/`/`backend/`/`.github/workflows/` for external contributors.
- CI: syntax check + require-smoke-test on every push/PR.

## Phase 1 — Pre-publish checklist (this pass)

- [x] Dependency audit (`npm audit` — 0 vulnerabilities at time of writing).
- [x] Manual security review against the OWASP Top 10 web-app risks relevant to this codebase —
      see `SECURITY_REVIEW.md` for the full findings list and what was fixed.
- [x] Fixed a stored-XSS class of bug (unescaped user data — employee/driver/branch names,
      delivery notes — going into `innerHTML`), including one reachable from the **unauthenticated**
      login page.
- [x] Added `helmet` (security headers/CSP), rate limiting on every password-checking route,
      a request body size cap, `secure: "auto"` session cookies, and a generic top-level error
      handler that never leaks a stack trace.
- [x] Raised the minimum password length from 4 to 6 characters (client- and server-side).
- [x] Privacy Policy, Terms & Conditions, and Cookie Policy pages, linked from the login footer.
      **These are templates** — see the notice at the top of each page; they need the business's
      real name/contact/jurisdiction filled in and a legal review before they're relied on.
- [x] Cookie notice (informational — the app sets exactly one strictly-necessary session cookie,
      so there's nothing to gate behind opt-in consent; see `frontend/cookie-policy.html`).
- [x] This documentation set (PRD/TRD/App Flow/UI-UX brief/Backend schema/Implementation plan).
- [x] Checked against a second, user-supplied risk list (CORS, unbounded API consumption, IDOR,
      dependency hallucination, exposed secrets, 404 handling) — see `SECURITY_REVIEW.md` "Round 2".
- [x] **Storage migrated from local JSON files to Google Sheets as the sole datastore**, and
      sessions migrated from an in-memory store to a stateless signed cookie — the two changes that
      make this app deployable to Vercel (or any other host with no persistent local disk). See
      `TRD.md` §7 and §8.
- [x] Added Vercel deployment config (`vercel.json`, `api/index.js`) — see README.md "Deployment".

## Phase 2 — Near-term (not yet done)

- **Fill in the legal-page placeholders** with the business's actual name, contact email, address,
  and governing jurisdiction, then get them reviewed by someone qualified for the relevant
  jurisdiction (especially if any branch operates in the EU/UK or serves EU/UK customers' data).
- **Automated tests.** CI currently only syntax-checks; there's no unit coverage for the pay-math
  functions (`computeShares`, `computeDeliveryPay`) or the date-range helpers, which are exactly
  the kind of logic that benefits most from regression tests.
- **CSRF defense-in-depth.** `SameSite=Lax` cookies already block most cross-site request forgery
  for this app's fetch-based mutations; an explicit per-session CSRF token would close the
  remaining gap (top-level cross-site GETs) if the threat model changes.
- **Structured logging / audit trail** for admin/owner actions (password changes, branch
  deletion) — currently only implicit via the data files themselves.

## Phase 3 — Longer-term / optional

- Real database migration if this ever needs to run on serverless infra (see README.md
  "Deployment" for why the current JSON-file storage rules that out as-is).
- Multi-owner / role-based permissions finer than staff/admin/owner, if the business grows past
  a single owner managing every branch.
- Accessibility pass (keyboard navigation audit, `aria-live` regions for async errors, screen
  reader testing) — see `UI_UX_DESIGN_BRIEF.md` §7 for the current gaps.
- Export/reporting beyond the Google Sheet mirror (e.g. a scheduled PDF/CSV summary email).
