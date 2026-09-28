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

### Round 2 — checked against a user-supplied risk list (28 September 2026)

| # | Finding | Severity | Status |
|---|---|---|---|
| 9 | No blanket rate limit on general API traffic (only login-type routes were capped) — "denial of wallet" / cost-DoS risk | Medium | Fixed |
| 10 | No explicit CORS policy declared (behavior was already safe by default, but undeclared) | Low | Fixed (made explicit) |
| 11 | An entry could reference an employee/driver ID from a *different* branch — not a cross-tenant data leak, but a data-integrity gap in access control | Low–Medium | Fixed |
| 12 | No `Permissions-Policy` header | Low | Fixed |
| 13 | No custom 404 — unmatched routes fell through to Express's default page/behavior | Low | Fixed |
| 14 | Dependency hallucination / malicious packages | — | Checked — see below |
| 15 | Verbose stack traces, missing headers, SQL/command injection, exposed secrets | — | Re-confirmed already covered by Round 1 (#3, #6) and existing architecture (no SQL, no shell-out); see below |

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

### 9. Unbounded API consumption / "denial of wallet" (Medium) — Fixed
Round 1 only rate-limited the password-checking routes. Every other `/api/*` route (history
queries, analytics, etc.) had no limit at all — cheap for a small internal tool today, but a real
cost/availability risk once hosted somewhere that bills per request or per compute-second (e.g.
serverless).
**Fix:** a second, more generous rate limiter (`express-rate-limit`, 300 requests / 15 min / IP)
applied to every `/api` and `/auth` route, layered on top of the stricter 20/15min limiter that
still applies specifically to the password-checking routes.

### 10. CORS not explicitly declared (Low) — made explicit
No `cors` middleware was present, which already meant no `Access-Control-Allow-Origin` header was
ever sent — i.e. cross-origin reads were already blocked by the browser's default same-origin
policy. That was correct, but undeclared, so a future change could accidentally introduce a
permissive CORS config without it standing out as a deliberate choice.
**Fix:** `cors({ origin: false })` — functionally identical to before, but now an explicit,
auditable statement that this app never intends to serve cross-origin API callers.

### 11. Cross-branch ID reference in entries (Low–Medium) — Fixed
`addEntry`/`updateEntry` and `addDeliveryEntry`/`updateDeliveryEntry` accepted any
`employeeId`/`driverId` string without checking it actually belonged to the branch making the
request. A branch's own staff member (already authenticated for that branch) could submit an
entry referencing another branch's employee/driver UUID. This does **not** leak the other branch's
data (the response never reflects anything about that ID beyond accepting it, and the history view
would just show "(removed employee)" since the foreign ID isn't in the acting branch's own
employee list) — it's a data-integrity gap, not a cross-tenant read, but it's still wrong for an
entry to be able to reference an ID outside its own branch at all.
**Fix:** `validateEntryInput`/`validateDeliveryEntryInput` now take the branch's actual set of
employee/driver IDs (active or inactive) and silently drop any row referencing an ID outside it,
consistent with how an incomplete row (no ID picked yet) was already handled.
**Verified:** created a real entry through the UI after the fix to confirm legitimate saves are
unaffected.

### 12. Missing `Permissions-Policy` header (Low) — Fixed
Not set by the current `helmet` version by default.
**Fix:** added explicitly, denying geolocation/camera/microphone/payment/USB — none of which this
app uses, so if an XSS or a malicious dependency ever tried to invoke them, the browser refuses.

### 13. No custom 404 (Low) — Fixed
Unmatched routes fell through to Express's default "Cannot GET ..." response.
**Fix:** a catch-all route (after static file serving, before the error handler) that returns
JSON `{"error":"Not found."}` for `/api`/`/auth` paths and a styled `frontend/404.html` page for
everything else.

### 14. Dependency hallucination / malicious packages — checked, none found
Verified every dependency in `package.json` (`bcryptjs`, `dotenv`, `express`, `express-session`,
`google-auth-library`, `googleapis`, `helmet`, `express-rate-limit`, `cors`) actually resolves on
the real npm registry to the well-known, canonically-named package for that library (`npm view
<pkg>` — confirmed real maintainers, sane version numbers, matches the intended library), not a
similarly-named typosquat. `npm audit` (which requires real registry resolution) also passed
cleanly, which independently confirms none of these are non-existent or phantom packages.

### 15. Re-confirmed from the user's list
- **Verbose stack traces** — covered by Round 1 #6 (catch-all error handler).
- **Missing HTTP headers** — covered by Round 1 #3 (`helmet`), extended by #12 above.
- **SQL injection** — not applicable; no SQL database exists in this architecture.
- **Command injection** — checked: no `child_process`/`exec`/`spawn` usage anywhere in `backend/`.
- **Exposed API keys & server secrets** — re-checked: `.env` and `backend/data/*` have never been
  committed at any point in git history (`git log --all --full-history` on both — empty), and
  nothing in the tracked repo contains a real secret value (checked for common key/token patterns).

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
