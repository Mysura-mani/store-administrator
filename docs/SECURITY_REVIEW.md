# Security Review — Tips Tracker

**Date:** 28 September 2026
**Method:** `npm audit` (dependency vulnerabilities) + a manual code review against the OWASP Top
10 web-application risks relevant to this codebase (no SQL database, no file uploads, no public
API), reasoned about directly against this app's actual code and threat model rather than run
through a generic scanner.

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Stored XSS via unescaped user input in `innerHTML` (employee/driver/branch names, delivery notes) — reachable from the **unauthenticated** login page via branch names | High | Fixed |
| 2 | No rate limiting on password-checking routes (brute-force risk) | Medium | Fixed |
| 3 | No security headers (CSP, clickjacking, MIME-sniffing protection) | Medium | Fixed |
| 4 | Session cookie not marked `secure` when served over HTTPS via a reverse proxy | Medium | Fixed |
| 5 | Minimum password length (4 characters) too low | Low–Medium | Fixed |
| 6 | Unhandled errors could leak a stack trace to the client | Low | Fixed |
| 7 | No request body size limit | Low | Fixed |
| 8 | Dependency vulnerabilities | — | None found (`npm audit`: 0 vulnerabilities) |

## Details

### 1. Stored XSS (High) — Fixed
Employee names, driver names, branch/store names, and delivery notes are all free-text fields a
logged-in staff member (the lowest privilege level) can set, and were being interpolated directly
into `innerHTML` template strings across most frontend pages without escaping. A branch staff
member could set e.g. an employee name to `<img src=x onerror="...">`, and that script would run
in the browser of anyone who later viewed that list — including a branch **admin** or the
**owner**, both higher-privileged than the attacker. Branch names specifically are also rendered
on the public, unauthenticated `/login.html` store-picker dropdown, so this was exploitable
without any login at all.

**Fix:** added `escapeHtml()` to `frontend/common.js` and applied it to every place user-supplied
text reaches `innerHTML` (`login.html`, `owner-dashboard.html`, `dashboard.html` was already
safe, `entry.html`, `delivery-entry.html`, `employees.html`, `drivers.html`, `history.html`,
`delivery-history.html`). One spot (`delivery-entry.html`'s note field) had an incomplete manual
escape (only `"` was escaped) that's now replaced with the same helper for consistency.
**Verified:** manually injected `<img src=x onerror="window.__xssFired=true">` as an employee
name through the real UI and confirmed it rendered as inert text with no script execution, both
before removing it.

### 2. No rate limiting (Medium) — Fixed
`/api/login`, `/api/owner-login`, `/api/elevate-admin`, `/api/owner/change-password`, and
`/api/settings/admin-password` all check a password with no limit on attempts, which combined
with a previously-low minimum password length made online brute-forcing realistic.
**Fix:** `express-rate-limit`, 20 requests per 15 minutes per IP, applied to all five routes.

### 3. No security headers (Medium) — Fixed
No Content-Security-Policy, X-Frame-Options, or X-Content-Type-Options were set.
**Fix:** `helmet`, with a CSP that allows `'self'` plus the Chart.js CDN
(`cdn.jsdelivr.net`) for scripts. `script-src`/`style-src` had to include `'unsafe-inline'`
because this app has no build step and every page is one inline `<script>` with inline `style=`
attributes throughout — rewriting that is out of scope for this pass, so CSP here is
defense-in-depth on top of finding #1's fix (output escaping), not a substitute for it.

### 4. Session cookie missing `secure` (Medium) — Fixed
`cookie.secure` wasn't set, so the session cookie could be sent over a plain HTTP connection even
when the app is reachable over HTTPS through a reverse proxy (e.g. the Cloudflare Tunnel setup
described in the README).
**Fix:** `cookie.secure = "auto"` (sends it as HTTPS-only exactly when the request actually was
HTTPS) plus `app.set("trust proxy", 1)` so Express reads `X-Forwarded-Proto` from the proxy
correctly.

### 5. Weak minimum password length (Low–Medium) — Fixed
4 characters was the enforced minimum everywhere a password could be set. Raised to 6,
client-side (`minlength` attributes) and server-side (the actual validation that matters).
Existing passwords shorter than 6 still work for login — this only affects newly-set passwords.

### 6. Stack trace leakage (Low) — Fixed
No top-level Express error handler existed; an uncaught error in a route could fall through to
Express's default handler, which includes a stack trace when `NODE_ENV` isn't `production`.
**Fix:** a catch-all error-handling middleware that logs server-side and returns a generic
message to the client.

### 7. No request body size limit (Low) — Fixed
`express.json()` had no `limit`, allowing arbitrarily large request bodies.
**Fix:** capped at `100kb`, comfortably above any legitimate payload this app sends.

### 8. Dependency vulnerabilities — none found
`npm audit` reported 0 vulnerabilities across all dependencies at the time of this review.

## Things assessed and judged adequate as-is

- **CSRF:** `SameSite=Lax` on the session cookie already blocks the cookie from being sent on
  cross-site XHR/fetch (how every mutating request in this app is made), which is the practical
  CSRF exposure for a session-cookie app like this one. A dedicated CSRF token was judged
  unnecessary for the current threat model; see `IMPLEMENTATION_PLAN.md` Phase 2 if that changes.
- **IDOR:** every branch-scoped `:id` lookup (entries, employees, drivers) filters by
  `req.session.branchId` server-side, so one branch cannot access another's records even with a
  guessed UUID. Owner-only routes intentionally act across branches by design.
- **SQL injection:** not applicable — there is no SQL database; storage is local JSON files.
- **Secrets handling:** the Google OAuth client secret and refresh token, and all password hashes,
  live only in gitignored files (`.env`, `backend/data/config.json`) and are never returned by any
  API response.

## About the "Anthropic Cybersecurity Skills" repository

The user pointed at github.com/mukul975/Anthropic-Cybersecurity-Skills as a source of skills to
"install" for this check. That repo is a general-purpose library of 817 skills, the large
majority of which are offensive/red-team, forensics, and cloud-infrastructure security content
(C2 frameworks, memory forensics, SCADA/ICS, mobile, blockchain, etc.) aimed at security
practitioners auditing arbitrary systems — not a web-app hardening checklist, and not a fit to
bulk-install into a small business app's public repository. This review instead applied the
relevant methodology directly (OWASP-style web-app review, dependency audit, secure defaults) as
a manual pass against this specific codebase.
