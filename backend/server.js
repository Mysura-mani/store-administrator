const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { OAuth2Client } = require("google-auth-library");
const store = require("./lib/store");

const app = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
// Only for the interactive "Sign in with Google" identity check on the login
// page — separate from the Sheets database connection, which authenticates
// with its own static GOOGLE_REFRESH_TOKEN (see backend/lib/sheetsClient.js)
// so it works with no user present, e.g. on a fresh serverless cold start.
const googleAuthConfigured = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const oauthClient = googleAuthConfigured
  ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)
  : null;

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_COOKIE_NAME = "tips.sid";
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12;

// Needed so req.secure correctly reflects the original request's scheme when
// this app runs behind a reverse proxy that terminates TLS (Cloudflare
// Tunnel, Vercel's edge, nginx, etc.) — without it, req.secure is always
// false even over HTTPS, since Express only trusts X-Forwarded-Proto from a
// configured proxy.
app.set("trust proxy", 1);

// Security headers (CSP, HSTS, clickjacking/MIME-sniffing protection, etc).
// script-src/style-src need 'unsafe-inline' because every page here is a
// single inline <script>/<style> with no build step — that's a real
// reduction in what CSP alone can stop, so the primary XSS defense is
// escaping user data before it ever reaches innerHTML (see escapeHtml in
// frontend/common.js), not CSP. CSP still blocks foreign script/style/frame
// sources, clickjacking, and object/embed injection.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // Off: would block the Chart.js script fetched from the jsdelivr CDN.
    crossOriginEmbedderPolicy: false,
  })
);

// Not set by helmet in this version — restricts browser features this app
// never uses, so an XSS that slipped through couldn't invoke them either.
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()");
  next();
});

// The frontend and API are always served from this same origin — there is
// no legitimate cross-origin caller, so CORS is explicitly disabled (rather
// than just left unconfigured) to make that a deliberate, auditable choice.
app.use(cors({ origin: false }));

// Blocks brute-forcing any password (branch staff/admin, owner) by capping
// attempts per IP. Applied only to routes that check a password.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

// A generous blanket cap on every API/auth request per IP, independent of
// the stricter authLimiter above — bounds worst-case request volume (cost
// and load) from a single source without affecting normal use.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});
app.use(["/api", "/auth"], apiLimiter);

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser(SESSION_SECRET));

// ---------- stateless session (a signed cookie, not a server-side store) ----------
// There's no persistent process/disk to hold sessions server-side once this
// runs on a serverless host — each request may land on a different, fresh
// instance. The session is instead the cookie itself: JSON, HMAC-signed so
// it can't be forged or tampered with, verified on every request.

function getSessionFromCookie(req) {
  const raw = req.signedCookies && req.signedCookies[SESSION_COOKIE_NAME];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function setSession(req, res, data) {
  res.cookie(SESSION_COOKIE_NAME, JSON.stringify(data), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    signed: true,
    maxAge: SESSION_MAX_AGE_MS,
  });
  req.session = data;
}

function clearSession(req, res) {
  res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: req.secure, signed: true });
  req.session = {};
}

app.use((req, res, next) => {
  req.session = getSessionFromCookie(req);
  next();
});

// Ensures the Sheet's tabs exist and default branches/owner password are
// seeded — once per process, the first time any request needs it (a cold
// start on a serverless host has no other "startup" moment to do this in).
let readyPromise = null;
app.use((req, res, next) => {
  if (!readyPromise) readyPromise = store.ensureSeeded();
  readyPromise.then(() => next(), next);
});

// Wraps an async route handler so a rejected promise reaches the error
// handler instead of crashing the process or hanging the request (Express 4
// does not do this automatically the way Express 5 does).
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------- helpers ----------

function requireAuth(req, res, next) {
  if (!req.session.role || !req.session.branchId) return res.status(401).json({ error: "not_authenticated" });
  next();
}

// Like requireAuth, but also accepts the owner role, which has no branchId.
function requireAnyAuth(req, res, next) {
  if (!req.session.role) return res.status(401).json({ error: "not_authenticated" });
  if (req.session.role !== "owner" && !req.session.branchId) return res.status(401).json({ error: "not_authenticated" });
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.role !== "admin") {
    return res.status(403).json({ error: "Admin access is required for this action." });
  }
  next();
}

function requireOwner(req, res, next) {
  if (req.session.role !== "owner") {
    return res.status(403).json({ error: "Owner access is required for this action." });
  }
  next();
}

// Staff can freely keep completing TODAY's entry (e.g. adding another driver
// as their shift ends), but editing or deleting an entry for any other date
// — a retroactive correction — requires admin.
function requireAdminForPastEdit(getEntryFn) {
  return ah(async (req, res, next) => {
    if (req.session.role === "admin") return next();
    const existing = await getEntryFn(req.session.branchId, req.params.id);
    if (!existing) return res.status(404).json({ error: "Entry not found." });
    const today = store.formatDateStr(new Date());
    const targetDate = (req.body && req.body.date) || existing.date;
    if (existing.date === today && targetDate === today) return next();
    return res.status(403).json({ error: "Admin access is required to edit or delete a past entry." });
  });
}

// ---------- branches & auth ----------

app.get("/api/branches", ah(async (req, res) => {
  res.json(await store.getBranches());
}));

app.post("/api/login", authLimiter, ah(async (req, res) => {
  const { branchId, password } = req.body || {};
  if (!branchId || !(await store.branchExists(branchId))) {
    return res.status(400).json({ error: "Choose a branch." });
  }
  if (!(await store.verifyStaffPassword(branchId, password))) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  setSession(req, res, { role: "staff", branchId });
  res.json({ ok: true, role: "staff", branchId });
}));

app.post("/api/elevate-admin", authLimiter, requireAuth, ah(async (req, res) => {
  const { password } = req.body || {};
  if (!(await store.verifyAdminPassword(req.session.branchId, password))) {
    return res.status(401).json({ error: "Incorrect admin password." });
  }
  setSession(req, res, { ...req.session, role: "admin" });
  res.json({ ok: true, role: "admin" });
}));

app.post("/api/logout", (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get("/api/session", requireAnyAuth, ah(async (req, res) => {
  if (req.session.role === "owner") {
    return res.json({ role: "owner" });
  }
  const branches = await store.getBranches();
  const branch = branches.find((b) => b.id === req.session.branchId);
  res.json({
    role: req.session.role,
    branchId: req.session.branchId,
    branchName: branch ? branch.name : req.session.branchId,
    viaOwner: !!req.session.viaOwner,
  });
}));

// ---------- owner (super-admin over all branches) ----------

app.post("/api/owner-login", authLimiter, ah(async (req, res) => {
  const { password } = req.body || {};
  if (!(await store.verifyOwnerPassword(password))) {
    return res.status(401).json({ error: "Incorrect owner password." });
  }
  setSession(req, res, { role: "owner" });
  res.json({ ok: true, role: "owner" });
}));

app.get("/api/owner/branches", requireOwner, ah(async (req, res) => {
  res.json(await store.getBranches());
}));

app.get("/api/owner/analytics", requireOwner, ah(async (req, res) => {
  res.json(await store.getAnalyticsData());
}));

app.post("/api/owner/branches", requireOwner, ah(async (req, res) => {
  const { name, staffPassword, adminPassword } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Store name is required." });
  if (!staffPassword || staffPassword.length < 6) {
    return res.status(400).json({ error: "Staff password must be at least 6 characters." });
  }
  if (!adminPassword || adminPassword.length < 6) {
    return res.status(400).json({ error: "Admin password must be at least 6 characters." });
  }
  res.status(201).json(await store.createBranch({ name, staffPassword, adminPassword }));
}));

app.put("/api/owner/branches/:id", requireOwner, ah(async (req, res) => {
  const { name, staffPassword, adminPassword } = req.body || {};
  if (staffPassword && staffPassword.length < 6) {
    return res.status(400).json({ error: "Staff password must be at least 6 characters." });
  }
  if (adminPassword && adminPassword.length < 6) {
    return res.status(400).json({ error: "Admin password must be at least 6 characters." });
  }
  const updated = await store.updateBranchByOwner(req.params.id, { name, staffPassword, adminPassword });
  if (!updated) return res.status(404).json({ error: "Store not found." });
  res.json(updated);
}));

app.delete("/api/owner/branches/:id", requireOwner, ah(async (req, res) => {
  const deleted = await store.deleteBranch(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Store not found." });
  res.json({ ok: true });
}));

// Lets the owner drop into a store's own dashboard (as that store's admin) to
// look into or manage it directly, without needing that store's password.
app.post("/api/owner/branches/:id/open", requireOwner, ah(async (req, res) => {
  if (!(await store.branchExists(req.params.id))) return res.status(404).json({ error: "Store not found." });
  setSession(req, res, { role: "admin", branchId: req.params.id, viaOwner: true });
  res.json({ ok: true });
}));

// Returns from a store (opened via the above) back to the owner dashboard.
app.post("/api/owner/return", requireAuth, (req, res) => {
  if (!req.session.viaOwner) return res.status(403).json({ error: "Not in owner mode." });
  setSession(req, res, { role: "owner" });
  res.json({ ok: true });
});

app.post("/api/owner/change-password", authLimiter, requireOwner, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!(await store.verifyOwnerPassword(currentPassword))) {
    return res.status(401).json({ error: "Current owner password is incorrect." });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }
  await store.updateOwnerPassword(newPassword);
  res.json({ ok: true });
}));

// ---------- owner sign-in with Google (identity check only) ----------

// Whether the "Sign in with Google" button should even be shown: the server
// needs a Google OAuth client configured (env vars) AND the owner needs to
// have set an authorized Gmail address from the dashboard.
app.get("/api/auth/google/available", ah(async (req, res) => {
  res.json({ available: googleAuthConfigured && !!(await store.getOwnerGoogleEmail()) });
}));

app.get("/api/owner/google-config", requireOwner, ah(async (req, res) => {
  res.json({ configured: googleAuthConfigured, email: await store.getOwnerGoogleEmail() });
}));

app.put("/api/owner/google-email", requireOwner, ah(async (req, res) => {
  const { email } = req.body || {};
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address, or leave it blank to disable Google sign-in." });
  }
  await store.setOwnerGoogleEmail(email || null);
  res.json({ ok: true, email: await store.getOwnerGoogleEmail() });
}));

// Read-only pointer at the Google Sheet backing this deployment, for the
// owner dashboard to link to. There's no "connect/sync/disconnect" anymore —
// every request already reads/writes the Sheet directly and immediately.
app.get("/api/owner/sheet-info", requireOwner, (req, res) => {
  const sheetId = process.env.GOOGLE_SHEET_ID || "";
  res.json({ sheetUrl: sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : null });
});

app.get("/auth/google", (req, res) => {
  if (!googleAuthConfigured) {
    return res.redirect("/login.html?error=google_not_configured");
  }
  const state = crypto.randomBytes(16).toString("hex");
  setSession(req, res, { ...req.session, googleOAuthState: state });
  const url = oauthClient.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email"],
    state,
    prompt: "select_account",
  });
  res.redirect(url);
});

app.get("/auth/google/callback", ah(async (req, res) => {
  const { code, state } = req.query;
  const expectedState = req.session.googleOAuthState;

  if (!googleAuthConfigured || !code || !state || state !== expectedState) {
    return res.redirect("/login.html?error=google_login_failed");
  }
  try {
    const { tokens } = await oauthClient.getToken({ code, redirect_uri: GOOGLE_REDIRECT_URI });
    const ticket = await oauthClient.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const authorizedEmail = await store.getOwnerGoogleEmail();
    if (!payload.email_verified || !authorizedEmail || payload.email.toLowerCase() !== authorizedEmail) {
      return res.redirect("/login.html?error=google_email_not_authorized");
    }
    setSession(req, res, { role: "owner" });
    res.redirect("/owner-dashboard.html");
  } catch (err) {
    res.redirect("/login.html?error=google_login_failed");
  }
}));

// ---------- employees ----------

app.get("/api/employees", requireAuth, ah(async (req, res) => {
  const includeInactive = req.query.all === "1";
  res.json(await store.listEmployees(req.session.branchId, { includeInactive }));
}));

app.post("/api/employees", requireAuth, requireAdmin, ah(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Employee name is required." });
  res.status(201).json(await store.addEmployee(req.session.branchId, name));
}));

app.put("/api/employees/:id", requireAuth, requireAdmin, ah(async (req, res) => {
  const { name, active } = req.body || {};
  const updated = await store.updateEmployee(req.session.branchId, req.params.id, { name, active });
  if (!updated) return res.status(404).json({ error: "Employee not found." });
  res.json(updated);
}));

app.delete("/api/employees/:id", requireAuth, requireAdmin, ah(async (req, res) => {
  if (await store.employeeHasEntries(req.session.branchId, req.params.id)) {
    return res.status(409).json({
      error: "This employee has tip history. Deactivate them instead of deleting so past reports stay accurate.",
    });
  }
  const deleted = await store.deleteEmployee(req.session.branchId, req.params.id);
  if (!deleted) return res.status(404).json({ error: "Employee not found." });
  res.json({ ok: true });
}));

// ---------- entries ----------

app.get("/api/entries", requireAuth, ah(async (req, res) => {
  const { from, to } = req.query;
  res.json(await store.listEntries(req.session.branchId, { from, to }));
}));

app.get("/api/entries/:id", requireAuth, ah(async (req, res) => {
  const entry = await store.getEntry(req.session.branchId, req.params.id);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  res.json(entry);
}));

app.post("/api/entries", requireAuth, ah(async (req, res) => {
  try {
    res.status(201).json(await store.addEntry(req.session.branchId, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.put(
  "/api/entries/:id",
  requireAuth,
  requireAdminForPastEdit((branchId, id) => store.getEntry(branchId, id)),
  ah(async (req, res) => {
    try {
      const updated = await store.updateEntry(req.session.branchId, req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ error: "Entry not found." });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

app.delete(
  "/api/entries/:id",
  requireAuth,
  requireAdminForPastEdit((branchId, id) => store.getEntry(branchId, id)),
  ah(async (req, res) => {
    const deleted = await store.deleteEntry(req.session.branchId, req.params.id);
    if (!deleted) return res.status(404).json({ error: "Entry not found." });
    res.json({ ok: true });
  })
);

// ---------- history dashboard (weekly / monthly, per-employee, expandable) ----------

app.get("/api/history", requireAuth, ah(async (req, res) => {
  const mode = req.query.mode;
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.anchor || "") ? req.query.anchor : store.formatDateStr(new Date());
  res.json(await store.buildHistory({ branchId: req.session.branchId, mode, anchor }));
}));

// ---------- drivers ----------

app.get("/api/drivers", requireAuth, ah(async (req, res) => {
  const includeInactive = req.query.all === "1";
  res.json(await store.listDrivers(req.session.branchId, { includeInactive }));
}));

app.post("/api/drivers", requireAuth, requireAdmin, ah(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Driver name is required." });
  res.status(201).json(await store.addDriver(req.session.branchId, name));
}));

app.put("/api/drivers/:id", requireAuth, requireAdmin, ah(async (req, res) => {
  const { name, active } = req.body || {};
  const updated = await store.updateDriver(req.session.branchId, req.params.id, { name, active });
  if (!updated) return res.status(404).json({ error: "Driver not found." });
  res.json(updated);
}));

app.delete("/api/drivers/:id", requireAuth, requireAdmin, ah(async (req, res) => {
  if (await store.driverHasEntries(req.session.branchId, req.params.id)) {
    return res.status(409).json({
      error: "This driver has delivery history. Deactivate them instead of deleting so past reports stay accurate.",
    });
  }
  const deleted = await store.deleteDriver(req.session.branchId, req.params.id);
  if (!deleted) return res.status(404).json({ error: "Driver not found." });
  res.json({ ok: true });
}));

// ---------- delivery entries ----------

app.get("/api/delivery-entries", requireAuth, ah(async (req, res) => {
  const { from, to } = req.query;
  res.json(await store.listDeliveryEntries(req.session.branchId, { from, to }));
}));

app.get("/api/delivery-entries/:id", requireAuth, ah(async (req, res) => {
  const entry = await store.getDeliveryEntry(req.session.branchId, req.params.id);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  res.json(entry);
}));

app.post("/api/delivery-entries", requireAuth, ah(async (req, res) => {
  try {
    res.status(201).json(await store.addDeliveryEntry(req.session.branchId, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.put(
  "/api/delivery-entries/:id",
  requireAuth,
  requireAdminForPastEdit((branchId, id) => store.getDeliveryEntry(branchId, id)),
  ah(async (req, res) => {
    try {
      const updated = await store.updateDeliveryEntry(req.session.branchId, req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ error: "Entry not found." });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

app.delete(
  "/api/delivery-entries/:id",
  requireAuth,
  requireAdminForPastEdit((branchId, id) => store.getDeliveryEntry(branchId, id)),
  ah(async (req, res) => {
    const deleted = await store.deleteDeliveryEntry(req.session.branchId, req.params.id);
    if (!deleted) return res.status(404).json({ error: "Entry not found." });
    res.json({ ok: true });
  })
);

// ---------- delivery history dashboard ----------

app.get("/api/delivery-history", requireAuth, ah(async (req, res) => {
  const mode = req.query.mode;
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.anchor || "") ? req.query.anchor : store.formatDateStr(new Date());
  res.json(await store.buildDeliveryHistory({ branchId: req.session.branchId, mode, anchor }));
}));

// ---------- rates ----------

app.get("/api/rates", requireAuth, ah(async (req, res) => {
  res.json(await store.getBranchRates(req.session.branchId));
}));

app.put("/api/rates", requireAuth, requireAdmin, ah(async (req, res) => {
  const { driverHourlyRate, minimumWage, zoneRates } = req.body || {};
  const updated = await store.updateBranchRates(req.session.branchId, {
    driverHourlyRate: Number(driverHourlyRate),
    minimumWage: Number(minimumWage),
    zoneRates: Array.isArray(zoneRates) ? zoneRates.map(Number) : undefined,
  });
  res.json(updated);
}));

// ---------- settings ----------

app.post("/api/settings/staff-password", requireAuth, requireAdmin, ah(async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }
  await store.updateBranchStaffPassword(req.session.branchId, newPassword);
  res.json({ ok: true });
}));

app.post("/api/settings/admin-password", authLimiter, requireAuth, requireAdmin, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!(await store.verifyAdminPassword(req.session.branchId, currentPassword))) {
    return res.status(401).json({ error: "Current admin password is incorrect." });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }
  await store.updateBranchAdminPassword(req.session.branchId, newPassword);
  res.json({ ok: true });
}));

// ---------- static pages ----------

app.use(
  express.static(path.join(__dirname, "..", "frontend"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  })
);

// Nothing above matched — a real 404, not a route bug. API/auth callers get
// JSON (consistent with every other response they get); everything else
// (an unknown page URL, a stray link) gets a friendly page instead of
// Express's default "Cannot GET ..." text.
app.use((req, res) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/auth")) {
    return res.status(404).json({ error: "Not found." });
  }
  res.status(404).sendFile(path.join(__dirname, "..", "frontend", "404.html"));
});

// Catches anything an earlier handler didn't — never leaks a stack trace or
// internal error detail to the client, only logs it server-side.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

// Vercel (and any other serverless host) imports this module and drives the
// exported app directly — it must NOT also call app.listen() itself. Running
// locally via `npm start`/`node backend/server.js` still starts a real
// server as before.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Tips Tracker running at http://localhost:${PORT}`);
  });
}

module.exports = app;
