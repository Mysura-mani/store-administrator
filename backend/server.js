const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { OAuth2Client } = require("google-auth-library");
const store = require("./lib/store");
const sheets = require("./lib/sheets");

store.ensureSeeded();
sheets.startBackgroundSync();

const app = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const googleAuthConfigured = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const oauthClient = googleAuthConfigured
  ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)
  : null;

// Needed for express-session's cookie.secure "auto" mode to work correctly
// when this app runs behind a reverse proxy that terminates TLS (Cloudflare
// Tunnel, nginx, etc.) — without it, req.secure is always false even when
// the original request was HTTPS, since Express only trusts
// X-Forwarded-Proto from a configured proxy.
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

// Blocks brute-forcing any password (branch staff/admin, owner) by capping
// attempts per IP. Applied only to routes that check a password.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

app.use(express.json({ limit: "100kb" }));
app.use(
  session({
    name: "tips.sid",
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 1000 * 60 * 60 * 12 },
  })
);

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
// â€” a retroactive correction â€” requires admin.
function requireAdminForPastEdit(getEntry) {
  return (req, res, next) => {
    if (req.session.role === "admin") return next();
    const existing = getEntry(req.session.branchId, req.params.id);
    if (!existing) return res.status(404).json({ error: "Entry not found." });
    const today = store.formatDateStr(new Date());
    const targetDate = (req.body && req.body.date) || existing.date;
    if (existing.date === today && targetDate === today) return next();
    return res.status(403).json({ error: "Admin access is required to edit or delete a past entry." });
  };
}

// ---------- branches & auth ----------

app.get("/api/branches", (req, res) => {
  res.json(store.getBranches());
});

app.post("/api/login", authLimiter, (req, res) => {
  const { branchId, password } = req.body || {};
  if (!branchId || !store.branchExists(branchId)) {
    return res.status(400).json({ error: "Choose a branch." });
  }
  if (!store.verifyStaffPassword(branchId, password)) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  req.session.role = "staff";
  req.session.branchId = branchId;
  res.json({ ok: true, role: "staff", branchId });
});

app.post("/api/elevate-admin", authLimiter, requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!store.verifyAdminPassword(req.session.branchId, password)) {
    return res.status(401).json({ error: "Incorrect admin password." });
  }
  req.session.role = "admin";
  res.json({ ok: true, role: "admin" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", requireAnyAuth, (req, res) => {
  if (req.session.role === "owner") {
    return res.json({ role: "owner" });
  }
  const branch = store.getBranches().find((b) => b.id === req.session.branchId);
  res.json({
    role: req.session.role,
    branchId: req.session.branchId,
    branchName: branch ? branch.name : req.session.branchId,
    viaOwner: !!req.session.viaOwner,
  });
});

// ---------- owner (super-admin over all branches) ----------

app.post("/api/owner-login", authLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!store.verifyOwnerPassword(password)) {
    return res.status(401).json({ error: "Incorrect owner password." });
  }
  req.session.role = "owner";
  delete req.session.branchId;
  delete req.session.viaOwner;
  res.json({ ok: true, role: "owner" });
});

app.get("/api/owner/branches", requireOwner, (req, res) => {
  res.json(store.getBranches());
});

app.get("/api/owner/analytics", requireOwner, (req, res) => {
  res.json(store.getAnalyticsData());
});

app.post("/api/owner/branches", requireOwner, (req, res) => {
  const { name, staffPassword, adminPassword } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Store name is required." });
  if (!staffPassword || staffPassword.length < 6) {
    return res.status(400).json({ error: "Staff password must be at least 6 characters." });
  }
  if (!adminPassword || adminPassword.length < 6) {
    return res.status(400).json({ error: "Admin password must be at least 6 characters." });
  }
  res.status(201).json(store.createBranch({ name, staffPassword, adminPassword }));
});

app.put("/api/owner/branches/:id", requireOwner, (req, res) => {
  const { name, staffPassword, adminPassword } = req.body || {};
  if (staffPassword && staffPassword.length < 6) {
    return res.status(400).json({ error: "Staff password must be at least 6 characters." });
  }
  if (adminPassword && adminPassword.length < 6) {
    return res.status(400).json({ error: "Admin password must be at least 6 characters." });
  }
  const updated = store.updateBranchByOwner(req.params.id, { name, staffPassword, adminPassword });
  if (!updated) return res.status(404).json({ error: "Store not found." });
  res.json(updated);
});

app.delete("/api/owner/branches/:id", requireOwner, (req, res) => {
  const deleted = store.deleteBranch(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Store not found." });
  res.json({ ok: true });
});

// Lets the owner drop into a store's own dashboard (as that store's admin) to
// look into or manage it directly, without needing that store's password.
app.post("/api/owner/branches/:id/open", requireOwner, (req, res) => {
  if (!store.branchExists(req.params.id)) return res.status(404).json({ error: "Store not found." });
  req.session.role = "admin";
  req.session.branchId = req.params.id;
  req.session.viaOwner = true;
  res.json({ ok: true });
});

// Returns from a store (opened via the above) back to the owner dashboard.
app.post("/api/owner/return", requireAuth, (req, res) => {
  if (!req.session.viaOwner) return res.status(403).json({ error: "Not in owner mode." });
  req.session.role = "owner";
  delete req.session.branchId;
  delete req.session.viaOwner;
  res.json({ ok: true });
});

app.post("/api/owner/change-password", authLimiter, requireOwner, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!store.verifyOwnerPassword(currentPassword)) {
    return res.status(401).json({ error: "Current owner password is incorrect." });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }
  store.updateOwnerPassword(newPassword);
  res.json({ ok: true });
});

// ---------- owner sign-in with Google ----------

// Whether the "Sign in with Google" button should even be shown: the server
// needs a Google OAuth client configured (env vars) AND the owner needs to
// have set an authorized Gmail address from the dashboard.
app.get("/api/auth/google/available", (req, res) => {
  res.json({ available: googleAuthConfigured && !!store.getOwnerGoogleEmail() });
});

app.get("/api/owner/google-config", requireOwner, (req, res) => {
  res.json({ configured: googleAuthConfigured, email: store.getOwnerGoogleEmail() });
});

app.put("/api/owner/google-email", requireOwner, (req, res) => {
  const { email } = req.body || {};
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address, or leave it blank to disable Google sign-in." });
  }
  store.setOwnerGoogleEmail(email || null);
  res.json({ ok: true, email: store.getOwnerGoogleEmail() });
});

app.get("/api/owner/sheets-status", requireOwner, (req, res) => {
  res.json(sheets.getStatus());
});

app.post("/api/owner/sheets-sync-now", requireOwner, async (req, res) => {
  try {
    sheets.markDirtyAll();
    await sheets.flushNow();
  } catch (err) {
    // status still reflects the failure via lastError; nothing more to do here
  }
  res.json(sheets.getStatus());
});

app.post("/api/owner/sheets-disconnect", requireOwner, (req, res) => {
  sheets.disconnect();
  res.json(sheets.getStatus());
});

app.get("/auth/google", (req, res) => {
  if (!googleAuthConfigured || !store.getOwnerGoogleEmail()) {
    return res.redirect("/login.html?error=google_not_configured");
  }
  const state = crypto.randomBytes(16).toString("hex");
  req.session.googleOAuthState = state;
  const url = oauthClient.generateAuthUrl({
    // offline + consent so Google issues a refresh token we can use later
    // (in the background, without the Owner being logged in) to keep the
    // Google Sheet in sync.
    access_type: "offline",
    scope: sheets.getScopes(),
    state,
    prompt: "consent select_account",
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query;
  const expectedState = req.session.googleOAuthState;
  delete req.session.googleOAuthState;

  if (!googleAuthConfigured || !code || !state || state !== expectedState) {
    return res.redirect("/login.html?error=google_login_failed");
  }
  try {
    const { tokens } = await oauthClient.getToken({ code, redirect_uri: GOOGLE_REDIRECT_URI });
    const ticket = await oauthClient.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const authorizedEmail = store.getOwnerGoogleEmail();
    if (!payload.email_verified || !authorizedEmail || payload.email.toLowerCase() !== authorizedEmail) {
      return res.redirect("/login.html?error=google_email_not_authorized");
    }
    req.session.role = "owner";
    delete req.session.branchId;
    delete req.session.viaOwner;
    sheets.handleOwnerLogin(tokens).catch(() => {});
    res.redirect("/owner-dashboard.html");
  } catch (err) {
    res.redirect("/login.html?error=google_login_failed");
  }
});

// ---------- employees ----------

app.get("/api/employees", requireAuth, (req, res) => {
  const includeInactive = req.query.all === "1";
  res.json(store.listEmployees(req.session.branchId, { includeInactive }));
});

app.post("/api/employees", requireAuth, requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Employee name is required." });
  res.status(201).json(store.addEmployee(req.session.branchId, name));
});

app.put("/api/employees/:id", requireAuth, requireAdmin, (req, res) => {
  const { name, active } = req.body || {};
  const updated = store.updateEmployee(req.session.branchId, req.params.id, { name, active });
  if (!updated) return res.status(404).json({ error: "Employee not found." });
  res.json(updated);
});

app.delete("/api/employees/:id", requireAuth, requireAdmin, (req, res) => {
  if (store.employeeHasEntries(req.session.branchId, req.params.id)) {
    return res.status(409).json({
      error: "This employee has tip history. Deactivate them instead of deleting so past reports stay accurate.",
    });
  }
  const deleted = store.deleteEmployee(req.session.branchId, req.params.id);
  if (!deleted) return res.status(404).json({ error: "Employee not found." });
  res.json({ ok: true });
});

// ---------- entries ----------

app.get("/api/entries", requireAuth, (req, res) => {
  const { from, to } = req.query;
  res.json(store.listEntries(req.session.branchId, { from, to }));
});

app.get("/api/entries/:id", requireAuth, (req, res) => {
  const entry = store.getEntry(req.session.branchId, req.params.id);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  res.json(entry);
});

app.post("/api/entries", requireAuth, (req, res) => {
  try {
    res.status(201).json(store.addEntry(req.session.branchId, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put(
  "/api/entries/:id",
  requireAuth,
  requireAdminForPastEdit((branchId, id) => store.getEntry(branchId, id)),
  (req, res) => {
    try {
      const updated = store.updateEntry(req.session.branchId, req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ error: "Entry not found." });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

app.delete(
  "/api/entries/:id",
  requireAuth,
  requireAdminForPastEdit((branchId, id) => store.getEntry(branchId, id)),
  (req, res) => {
    const deleted = store.deleteEntry(req.session.branchId, req.params.id);
    if (!deleted) return res.status(404).json({ error: "Entry not found." });
    res.json({ ok: true });
  }
);

// ---------- history dashboard (weekly / monthly, per-employee, expandable) ----------

app.get("/api/history", requireAuth, (req, res) => {
  const mode = req.query.mode;
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.anchor || "") ? req.query.anchor : store.formatDateStr(new Date());
  res.json(store.buildHistory({ branchId: req.session.branchId, mode, anchor }));
});

// ---------- drivers ----------

app.get("/api/drivers", requireAuth, (req, res) => {
  const includeInactive = req.query.all === "1";
  res.json(store.listDrivers(req.session.branchId, { includeInactive }));
});

app.post("/api/drivers", requireAuth, requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Driver name is required." });
  res.status(201).json(store.addDriver(req.session.branchId, name));
});

app.put("/api/drivers/:id", requireAuth, requireAdmin, (req, res) => {
  const { name, active } = req.body || {};
  const updated = store.updateDriver(req.session.branchId, req.params.id, { name, active });
  if (!updated) return res.status(404).json({ error: "Driver not found." });
  res.json(updated);
});

app.delete("/api/drivers/:id", requireAuth, requireAdmin, (req, res) => {
  if (store.driverHasEntries(req.session.branchId, req.params.id)) {
    return res.status(409).json({
      error: "This driver has delivery history. Deactivate them instead of deleting so past reports stay accurate.",
    });
  }
  const deleted = store.deleteDriver(req.session.branchId, req.params.id);
  if (!deleted) return res.status(404).json({ error: "Driver not found." });
  res.json({ ok: true });
});

// ---------- delivery entries ----------

app.get("/api/delivery-entries", requireAuth, (req, res) => {
  const { from, to } = req.query;
  res.json(store.listDeliveryEntries(req.session.branchId, { from, to }));
});

app.get("/api/delivery-entries/:id", requireAuth, (req, res) => {
  const entry = store.getDeliveryEntry(req.session.branchId, req.params.id);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  res.json(entry);
});

app.post("/api/delivery-entries", requireAuth, (req, res) => {
  try {
    res.status(201).json(store.addDeliveryEntry(req.session.branchId, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put(
  "/api/delivery-entries/:id",
  requireAuth,
  requireAdminForPastEdit((branchId, id) => store.getDeliveryEntry(branchId, id)),
  (req, res) => {
    try {
      const updated = store.updateDeliveryEntry(req.session.branchId, req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ error: "Entry not found." });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

app.delete(
  "/api/delivery-entries/:id",
  requireAuth,
  requireAdminForPastEdit((branchId, id) => store.getDeliveryEntry(branchId, id)),
  (req, res) => {
    const deleted = store.deleteDeliveryEntry(req.session.branchId, req.params.id);
    if (!deleted) return res.status(404).json({ error: "Entry not found." });
    res.json({ ok: true });
  }
);

// ---------- delivery history dashboard ----------

app.get("/api/delivery-history", requireAuth, (req, res) => {
  const mode = req.query.mode;
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.anchor || "") ? req.query.anchor : store.formatDateStr(new Date());
  res.json(store.buildDeliveryHistory({ branchId: req.session.branchId, mode, anchor }));
});

// ---------- rates ----------

app.get("/api/rates", requireAuth, (req, res) => {
  res.json(store.getBranchRates(req.session.branchId));
});

app.put("/api/rates", requireAuth, requireAdmin, (req, res) => {
  const { driverHourlyRate, minimumWage, zoneRates } = req.body || {};
  const updated = store.updateBranchRates(req.session.branchId, {
    driverHourlyRate: Number(driverHourlyRate),
    minimumWage: Number(minimumWage),
    zoneRates: Array.isArray(zoneRates) ? zoneRates.map(Number) : undefined,
  });
  res.json(updated);
});

// ---------- settings ----------

app.post("/api/settings/staff-password", requireAuth, requireAdmin, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }
  store.updateBranchStaffPassword(req.session.branchId, newPassword);
  res.json({ ok: true });
});

app.post("/api/settings/admin-password", authLimiter, requireAuth, requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!store.verifyAdminPassword(req.session.branchId, currentPassword)) {
    return res.status(401).json({ error: "Current admin password is incorrect." });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }
  store.updateBranchAdminPassword(req.session.branchId, newPassword);
  res.json({ ok: true });
});

// ---------- static pages ----------

app.use(
  express.static(path.join(__dirname, "..", "frontend"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  })
);

// Catches anything an earlier handler didn't — never leaks a stack trace or
// internal error detail to the client, only logs it server-side.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => {
  console.log(`Tips Tracker running at http://localhost:${PORT}`);
});
