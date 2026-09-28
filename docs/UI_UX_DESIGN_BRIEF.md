# UI/UX Design Brief — Tips Tracker

**Status:** As-built. **Last updated:** 28 September 2026

## 1. Visual language

- **Palette** (CSS custom properties in `frontend/styles.css`): `--primary: #2563eb`,
  `--primary-dark: #1d4ed8`, `--danger: #dc2626`, `--success: #16a34a`, `--bg: #f5f6f8`,
  `--text: #1c2230`, `--muted: #6b7280`, `--border: #e1e4e9`, `10px` corner radius throughout.
- **Type:** system font stack (`-apple-system, "Segoe UI", Roboto, ...`), no webfont — keeps the
  no-build-step architecture and avoids an extra external request.
- **Icons:** small inline SVG line icons (person, lock, two-people, arrow-in-box, chevron) drawn
  by hand at 24×24 viewBox, `stroke="currentColor"` so they inherit the surrounding text color —
  no icon font/library dependency.

## 2. Login page

Reference: "Admin Login Page" by Biruni Dev (Pinterest). Full-bleed illustration as the page
background (`object-fit: contain`, letterboxed in the page's own background color so it never
crops, regardless of viewport aspect ratio) with a single floating white card on the right —
**not** a two-panel split screen. Card contents, top to bottom: "Dashboard Login" eyebrow (with a
two-person icon) on a pale-blue band, an error slot (bold red, only populated on a failed login),
"WELCOME BACK" heading, subtitle, a Store dropdown (person icon, underline-style field, no boxed
border), a Password field (lock icon), and a full-width primary button with an arrow icon. A
"Continue with Google" button appears below a divider only when Owner is selected and Google
sign-in is configured. Footer: three small legal links (Privacy/Terms/Cookies), no Sitewide nav.

## 3. Branch dashboard ("Overview")

Sidebar + main-content layout (CollectUI-style), reused for both the branch dashboard and the
owner dashboard so the two feel like the same product:
- Sidebar: brand mark, role badge, nav links, Log out pinned to the bottom via `margin-bottom:
  auto` on the nav list.
- Main: page header, a row of stat cards (icon chip + big number + label), then task-specific
  content below (Quick actions on the branch Overview; store grid + Analytics on the Owner
  Stores view).
- Stat card icon chips use a distinct pastel background per metric (e.g. green-tinted for money,
  purple-tinted for people) purely for quick visual scanning, not semantic meaning.

## 4. Data entry pages (Tip Sheet, Delivery Payout)

Simple top-to-bottom forms; no wizard/multi-step pattern, since a shift's numbers are usually
known all at once. The Delivery Payout page is the one exception with real interaction
complexity: each driver gets its own card with its own **independent** Save button and a live,
color-coded total (green = minimum-wage top-up applied, orange = earned more than the floor) —
this exists specifically because drivers finish shifts at different times, not for visual
variety.

## 5. History pages

One table, sortable only by the natural "biggest total first" isn't enforced — rows are sorted
alphabetically by person; the far more common need (see today vs. last week) is served by the
period tabs + Prev/Next, not by re-sorting. Each row expands in place (no navigation, no modal) to
a day-by-day sub-table, indented and slightly dimmed (`.day-subtable`) to read as "detail of the
row above" rather than a new table.

## 6. Owner Analytics panel

Deliberately **not** a fixed dashboard of pre-picked charts — six independent filter dropdowns
(Store, Metric, Employee/Driver, Period, a specific-period picker, View) let the owner pivot the
same underlying dataset any way they need, rendered as a bar chart, a plain table, or small
multiples (one chart per store), because different questions ("how's this branch trending?" vs.
"how do all four branches compare this month?") genuinely want different chart shapes, not one
that compromises between them.

## 7. Accessibility notes (current state, not a completed audit)

- Every form input has an associated `<label for="...">`.
- Color is never the *only* signal (the pay-floor/above-floor states also change text, not just
  color; badges carry text like "Active"/"Admin", not just a colored dot).
- Icon-only buttons are rare; where they exist (chevrons, expand toggles) they sit next to text.
- Not yet done: no explicit `aria-live` region for async error messages, no keyboard-navigation
  pass beyond native tab order, no screen-reader testing. See `IMPLEMENTATION_PLAN.md`.

## 8. Responsive behavior

Single breakpoint at `620px` (phone width) collapses the sidebar layouts to a stacked top bar and
lets the login illustration's letterboxing handle any aspect ratio without a second breakpoint.
The Claude Desktop browser pane's own default width (~740–950px) sits above this breakpoint, so
it always sees the desktop layout during development/testing.
