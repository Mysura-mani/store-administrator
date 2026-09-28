const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const store = require("./lib/store");

store.ensureSeeded();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
  session({
    name: "tips.sid",
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 12 },
  })
);

// ---------- helpers ----------

function requireAuth(req, res, next) {
  if (!req.session.role || !req.session.branchId) return res.status(401).json({ error: "not_authenticated" });
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.role !== "admin") {
    return res.status(403).json({ error: "Admin access is required for this action." });
  }
  next();
}

// Staff can freely keep completing TODAY's entry (e.g. adding another driver
// as their shift ends), but editing or deleting an entry for any other date
// — a retroactive correction — requires admin.
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

app.post("/api/login", (req, res) => {
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

app.post("/api/elevate-admin", requireAuth, (req, res) => {
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

app.get("/api/session", requireAuth, (req, res) => {
  const branch = store.getBranches().find((b) => b.id === req.session.branchId);
  res.json({ role: req.session.role, branchId: req.session.branchId, branchName: branch ? branch.name : req.session.branchId });
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
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters." });
  }
  store.updateBranchStaffPassword(req.session.branchId, newPassword);
  res.json({ ok: true });
});

app.post("/api/settings/admin-password", requireAuth, requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!store.verifyAdminPassword(req.session.branchId, currentPassword)) {
    return res.status(401).json({ error: "Current admin password is incorrect." });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters." });
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

app.listen(PORT, () => {
  console.log(`Tips Tracker running at http://localhost:${PORT}`);
});
