const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const sheetsClient = require("./sheetsClient");

// Everything — branch/owner config AND business data — now lives in the
// Google Sheet identified by GOOGLE_SHEET_ID. There is no local file storage
// left in this module: that's what makes this app deployable to a
// serverless host (Vercel) with no writable/persistent disk.

const DEFAULT_RATES = {
  driverHourlyRate: 6,
  minimumWage: 14.15,
  zoneRates: [3, 3.5, 4, 5],
};

const CONFIG_HEADERS = ["key", "value"];
const EMPLOYEES_HEADERS = ["id", "branchId", "name", "active"];
// username/passwordHash let a driver log in on their own (see
// verifyDriverPassword()) to a read-only view of their own history —
// separate from the branch staff/admin accounts.
const DRIVERS_HEADERS = ["id", "branchId", "name", "active", "username", "passwordHash"];
// One plain row per employee-shift / driver-day (not one JSON-blob row per
// day's entry) so the Sheet itself stays readable to a non-technical owner
// opening it directly — see docs/BACKEND_SCHEMA.md §7. `entryId` groups the
// rows that make up one saved entry back together.
const ENTRIES_HEADERS = ["id", "entryId", "branchId", "date", "employeeId", "employeeName", "hours", "cashTips", "creditTips"];
const DELIVERY_ENTRIES_HEADERS = [
  "id",
  "entryId",
  "branchId",
  "date",
  "driverCount",
  "driverId",
  "driverName",
  "hours",
  "zone1Count",
  "zone2Count",
  "zone3Count",
  "zone4Count",
  "tips",
  "note",
  "cashOrdersJson",
];

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function newId() {
  return crypto.randomUUID();
}

// ---------- config (branches + credentials), stored as key/value rows ----------

// Deliberately NOT memoized here: which Sheet is connected can change
// mid-lifetime of a warm serverless instance (the owner reconnecting), and a
// "seeded once, ever" cache in this module would keep serving that fact for
// the OLD Sheet after a reconnect, skipping tab creation on the new one
// entirely. server.js already calls this at most once per actual Sheet
// (tracked by sheet ID there), so re-running the checks below on every call
// here is safe — each one is a cheap no-op once its Sheet is already set up.
async function ensureSeeded() {
  await sheetsClient.ensureTab("Config", CONFIG_HEADERS);
  await sheetsClient.ensureTab("Employees", EMPLOYEES_HEADERS);
  await sheetsClient.ensureTab("Drivers", DRIVERS_HEADERS);
  await sheetsClient.ensureTab("Entries", ENTRIES_HEADERS);
  await sheetsClient.ensureTab("DeliveryEntries", DELIVERY_ENTRIES_HEADERS);

  const cfg = await getConfig();
  if (!cfg.branches) {
    // No default branches: the owner creates each one themselves (with its
    // own passwords) from the dashboard after connecting a Sheet — see
    // IMPLEMENTATION_PLAN.md's setup-wizard flow.
    await saveBranches([]);
  }
  // No default owner password either: a freshly connected Sheet has none
  // until the owner sets one during the one-time post-connect setup step
  // (server.js's POST /api/setup/owner-password) — there's nothing to
  // protect yet on a brand-new Sheet, so leaving this unset has no bootstrap
  // security gap.
}

async function hasOwnerPassword() {
  const cfg = await getConfig();
  return !!cfg.ownerPasswordHash;
}

async function getConfigRows() {
  return sheetsClient.getRows("Config", CONFIG_HEADERS);
}

async function getConfig() {
  const rows = await getConfigRows();
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  if (cfg.branches) cfg.branches = JSON.parse(cfg.branches);
  return cfg;
}

async function setConfigValue(key, value) {
  const rows = await getConfigRows();
  const existing = rows.find((r) => r.key === key);
  const strValue = typeof value === "string" ? value : JSON.stringify(value);
  if (existing) {
    await sheetsClient.updateRow("Config", CONFIG_HEADERS, existing.__row, { key, value: strValue });
  } else {
    await sheetsClient.appendRow("Config", CONFIG_HEADERS, { key, value: strValue });
  }
}

async function saveBranches(branches) {
  await setConfigValue("branches", JSON.stringify(branches));
}

async function getBranches() {
  const cfg = await getConfig();
  return (cfg.branches || []).map((b) => ({ id: b.id, name: b.name }));
}

async function getBranchConfig(branchId) {
  const cfg = await getConfig();
  return (cfg.branches || []).find((b) => b.id === branchId) || null;
}

async function branchExists(branchId) {
  return !!(await getBranchConfig(branchId));
}

// ---------- owner (super-admin over all branches) ----------

async function verifyOwnerPassword(password) {
  const cfg = await getConfig();
  if (!cfg.ownerPasswordHash || !password) return false;
  return bcrypt.compareSync(password, cfg.ownerPasswordHash);
}

async function updateOwnerPassword(newPassword) {
  await setConfigValue("ownerPasswordHash", bcrypt.hashSync(newPassword, 10));
}

// The single Gmail address allowed to sign in as owner via Google. Unset by
// default — "Sign in with Google" stays disabled until the owner sets this
// themselves (from the owner dashboard, after logging in with the password),
// so there's no bootstrap gap where an unconfigured Google login could work.
async function getOwnerGoogleEmail() {
  const cfg = await getConfig();
  return cfg.ownerGoogleEmail || null;
}

async function setOwnerGoogleEmail(email) {
  await setConfigValue("ownerGoogleEmail", email ? email.trim().toLowerCase() : "");
}

// Driver pay rates (minimum wage, hourly rate, per-zone delivery rates) are
// a single owner-set value shared by every branch — not per-branch — since
// minimum wage in particular is a government-set figure the whole business
// is equally subject to, not something that should vary by location or be
// left to a branch admin to configure. See computeDeliveryPay() for how
// these feed into a driver's pay.
async function getGlobalRates() {
  const cfg = await getConfig();
  if (!cfg.globalRates) return { ...DEFAULT_RATES, zoneRates: [...DEFAULT_RATES.zoneRates] };
  return JSON.parse(cfg.globalRates);
}

async function setGlobalRates({ driverHourlyRate, minimumWage, zoneRates }) {
  if (!Number.isFinite(driverHourlyRate) || driverHourlyRate < 0) {
    throw new Error("Driver hourly rate must be a non-negative number.");
  }
  if (!Number.isFinite(minimumWage) || minimumWage < 0) {
    throw new Error("Minimum wage must be a non-negative number.");
  }
  if (!Array.isArray(zoneRates) || zoneRates.length !== 4 || !zoneRates.every((r) => Number.isFinite(r) && r >= 0)) {
    throw new Error("All 4 zone rates must be non-negative numbers.");
  }
  await setConfigValue("globalRates", JSON.stringify({ driverHourlyRate, minimumWage, zoneRates }));
}

// Off by default — the Sheet only ever grows by the owner's own explicit
// choice, never surprises them by deleting history on its own.
async function getAutoDeleteOldEntries() {
  const cfg = await getConfig();
  return cfg.autoDeleteOldEntries === "true";
}

async function setAutoDeleteOldEntries(enabled) {
  await setConfigValue("autoDeleteOldEntries", enabled ? "true" : "false");
}

function slugify(name) {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "store"
  );
}

function generateBranchId(name, existingIds) {
  const base = slugify(name);
  let id = base;
  let n = 2;
  while (existingIds.includes(id)) {
    id = `${base}-${n}`;
    n++;
  }
  return id;
}

async function createBranch({ name, staffPassword, adminPassword }) {
  const cfg = await getConfig();
  const branches = cfg.branches || [];
  const id = generateBranchId(name, branches.map((b) => b.id));
  const branch = {
    id,
    name: name.trim(),
    staffPasswordHash: bcrypt.hashSync(staffPassword, 10),
    adminPasswordHash: bcrypt.hashSync(adminPassword, 10),
  };
  branches.push(branch);
  await saveBranches(branches);
  return { id: branch.id, name: branch.name };
}

// Owner-level update: unlike updateBranchStaffPassword/updateBranchAdminPassword
// (self-service, used by a branch's own admin), this can also rename the store
// and does not require knowing the current password.
async function updateBranchByOwner(id, { name, staffPassword, adminPassword }) {
  const cfg = await getConfig();
  const branches = cfg.branches || [];
  const branch = branches.find((b) => b.id === id);
  if (!branch) return null;
  if (typeof name === "string" && name.trim()) branch.name = name.trim();
  if (staffPassword) branch.staffPasswordHash = bcrypt.hashSync(staffPassword, 10);
  if (adminPassword) branch.adminPasswordHash = bcrypt.hashSync(adminPassword, 10);
  await saveBranches(branches);
  return { id: branch.id, name: branch.name };
}

async function deleteAllRowsForBranch(tabName, headers, branchId) {
  const rows = await sheetsClient.getRows(tabName, headers);
  const toDelete = rows.filter((r) => r.branchId === branchId).sort((a, b) => b.__row - a.__row);
  for (const r of toDelete) {
    await sheetsClient.deleteRow(tabName, r.__row);
  }
}

async function deleteBranch(id) {
  const cfg = await getConfig();
  const branches = cfg.branches || [];
  const before = branches.length;
  const next = branches.filter((b) => b.id !== id);
  if (next.length === before) return false;
  await saveBranches(next);
  await deleteAllRowsForBranch("Employees", EMPLOYEES_HEADERS, id);
  await deleteAllRowsForBranch("Drivers", DRIVERS_HEADERS, id);
  await deleteAllRowsForBranch("Entries", ENTRIES_HEADERS, id);
  await deleteAllRowsForBranch("DeliveryEntries", DELIVERY_ENTRIES_HEADERS, id);
  return true;
}

async function verifyStaffPassword(branchId, password) {
  const branch = await getBranchConfig(branchId);
  if (!branch || !password) return false;
  return bcrypt.compareSync(password, branch.staffPasswordHash);
}

async function verifyAdminPassword(branchId, password) {
  const branch = await getBranchConfig(branchId);
  if (!branch || !password) return false;
  return bcrypt.compareSync(password, branch.adminPasswordHash);
}

async function updateBranchStaffPassword(branchId, newPassword) {
  const cfg = await getConfig();
  const branches = cfg.branches || [];
  const branch = branches.find((b) => b.id === branchId);
  if (!branch) return false;
  branch.staffPasswordHash = bcrypt.hashSync(newPassword, 10);
  await saveBranches(branches);
  return true;
}

async function updateBranchAdminPassword(branchId, newPassword) {
  const cfg = await getConfig();
  const branches = cfg.branches || [];
  const branch = branches.find((b) => b.id === branchId);
  if (!branch) return false;
  branch.adminPasswordHash = bcrypt.hashSync(newPassword, 10);
  await saveBranches(branches);
  return true;
}

// branchId is accepted (and every caller still passes one) purely so this
// reads the same everywhere delivery pay is computed — the rates
// themselves are global; see getGlobalRates().
async function getBranchRates(branchId) {
  return getGlobalRates();
}

// ---------- employees ----------

async function listEmployees(branchId, { includeInactive = false } = {}) {
  const rows = await sheetsClient.getRows("Employees", EMPLOYEES_HEADERS);
  return rows
    .filter((r) => r.branchId === branchId)
    .map((r) => ({ id: r.id, name: r.name, active: sheetsClient.toBool(r.active) }))
    .filter((e) => includeInactive || e.active)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function addEmployee(branchId, name) {
  const employee = { id: newId(), branchId, name: name.trim(), active: "TRUE" };
  await sheetsClient.appendRow("Employees", EMPLOYEES_HEADERS, employee);
  return { id: employee.id, name: employee.name, active: true };
}

async function findEmployeeRow(branchId, id) {
  const rows = await sheetsClient.getRows("Employees", EMPLOYEES_HEADERS);
  return rows.find((r) => r.branchId === branchId && r.id === id) || null;
}

async function updateEmployee(branchId, id, { name, active }) {
  const row = await findEmployeeRow(branchId, id);
  if (!row) return null;
  const next = {
    id: row.id,
    branchId: row.branchId,
    name: typeof name === "string" && name.trim() ? name.trim() : row.name,
    active: typeof active === "boolean" ? (active ? "TRUE" : "FALSE") : row.active,
  };
  await sheetsClient.updateRow("Employees", EMPLOYEES_HEADERS, row.__row, next);
  return { id: next.id, name: next.name, active: sheetsClient.toBool(next.active) };
}

async function employeeHasEntries(branchId, id) {
  const rows = await sheetsClient.getRows("Entries", ENTRIES_HEADERS);
  return rows.some((r) => r.branchId === branchId && r.employeeId === id);
}

async function deleteEmployee(branchId, id) {
  const row = await findEmployeeRow(branchId, id);
  if (!row) return false;
  await sheetsClient.deleteRow("Employees", row.__row);
  return true;
}

// ---------- entries ----------

function computeShares(entry) {
  const totalHours = entry.shifts.reduce((sum, s) => sum + s.hours, 0);
  return entry.shifts.map((s) => {
    const fraction = totalHours > 0 ? s.hours / totalHours : 0;
    return {
      employeeId: s.employeeId,
      hours: s.hours,
      cashShare: round2(entry.cashTips * fraction),
      creditShare: round2(entry.creditTips * fraction),
    };
  });
}

function withShares(entry) {
  return { ...entry, shares: computeShares(entry) };
}

// Regroups the Sheet's one-row-per-shift layout back into one entry object
// per distinct entryId (the shape every caller above this layer expects).
function groupEntryRows(rows) {
  const byEntryId = new Map();
  for (const r of rows) {
    if (!byEntryId.has(r.entryId)) byEntryId.set(r.entryId, []);
    byEntryId.get(r.entryId).push(r);
  }
  return [...byEntryId.values()].map((group) => {
    const first = group[0];
    return {
      id: first.entryId,
      branchId: first.branchId,
      date: first.date,
      cashTips: Number(first.cashTips) || 0,
      creditTips: Number(first.creditTips) || 0,
      shifts: group.map((r) => ({ employeeId: r.employeeId, hours: Number(r.hours) || 0 })),
      __rows: group.map((r) => r.__row),
    };
  });
}

async function listEntries(branchId, { from, to } = {}) {
  const rows = await sheetsClient.getRows("Entries", ENTRIES_HEADERS);
  return groupEntryRows(rows.filter((r) => r.branchId === branchId))
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(({ __rows, branchId: _b, ...e }) => withShares(e));
}

async function findEntryRow(branchId, id) {
  const rows = await sheetsClient.getRows("Entries", ENTRIES_HEADERS);
  const group = rows.filter((r) => r.branchId === branchId && r.entryId === id);
  return group.length ? groupEntryRows(group)[0] : null;
}

async function getEntry(branchId, id) {
  const found = await findEntryRow(branchId, id);
  if (!found) return null;
  const { __rows, branchId: _b, ...rest } = found;
  return withShares(rest);
}

// `validEmployeeIds` scopes accepted shifts to this branch's own employee
// list (active or inactive — an inactive one can still appear in an entry
// being edited) so an entry can never end up referencing another branch's
// employee, whether by a malicious request or a stale/bogus ID.
function validateEntryInput(input, validEmployeeIds) {
  if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error("A valid date is required.");
  }
  const cashTips = Number(input.cashTips);
  const creditTips = Number(input.creditTips);
  if (!Number.isFinite(cashTips) || cashTips < 0) throw new Error("Cash tips must be a non-negative number.");
  if (!Number.isFinite(creditTips) || creditTips < 0) throw new Error("Credit tips must be a non-negative number.");
  const shifts = Array.isArray(input.shifts) ? input.shifts : [];
  const cleanShifts = shifts
    .filter((s) => s && s.employeeId && validEmployeeIds.has(s.employeeId))
    .map((s) => {
      const hours = Number(s.hours);
      if (!Number.isFinite(hours) || hours <= 0) throw new Error("Each employee's hours must be a positive number.");
      return { employeeId: s.employeeId, hours };
    });
  if (cleanShifts.length === 0) throw new Error("Add at least one employee with hours worked.");
  return { date: input.date, cashTips, creditTips, shifts: cleanShifts };
}

async function writeEntryRows(entryId, branchId, clean, nameById) {
  for (const shift of clean.shifts) {
    await sheetsClient.appendRow("Entries", ENTRIES_HEADERS, {
      id: newId(),
      entryId,
      branchId,
      date: clean.date,
      employeeId: shift.employeeId,
      employeeName: nameById.get(shift.employeeId) || "",
      hours: shift.hours,
      cashTips: clean.cashTips,
      creditTips: clean.creditTips,
    });
  }
}

async function addEntry(branchId, input) {
  const employees = await listEmployees(branchId, { includeInactive: true });
  const nameById = new Map(employees.map((e) => [e.id, e.name]));
  const clean = validateEntryInput(input, new Set(employees.map((e) => e.id)));
  const entryId = newId();
  await writeEntryRows(entryId, branchId, clean, nameById);
  return withShares({ id: entryId, date: clean.date, cashTips: clean.cashTips, creditTips: clean.creditTips, shifts: clean.shifts });
}

async function updateEntry(branchId, id, input) {
  const existing = await findEntryRow(branchId, id);
  if (!existing) return null;
  const employees = await listEmployees(branchId, { includeInactive: true });
  const nameById = new Map(employees.map((e) => [e.id, e.name]));
  const clean = validateEntryInput(input, new Set(employees.map((e) => e.id)));
  // The number of shifts can differ from what was saved before, so replace
  // every row for this entry rather than updating them one-for-one — delete
  // in descending row order first so earlier deletes don't shift the row
  // numbers of ones still to be deleted.
  for (const rowNum of [...existing.__rows].sort((a, b) => b - a)) {
    await sheetsClient.deleteRow("Entries", rowNum);
  }
  await writeEntryRows(id, branchId, clean, nameById);
  return withShares({ id, date: clean.date, cashTips: clean.cashTips, creditTips: clean.creditTips, shifts: clean.shifts });
}

async function deleteEntry(branchId, id) {
  const existing = await findEntryRow(branchId, id);
  if (!existing) return false;
  for (const rowNum of [...existing.__rows].sort((a, b) => b - a)) {
    await sheetsClient.deleteRow("Entries", rowNum);
  }
  return true;
}

// ---------- drivers ----------

async function listDrivers(branchId, { includeInactive = false } = {}) {
  const rows = await sheetsClient.getRows("Drivers", DRIVERS_HEADERS);
  return rows
    .filter((r) => r.branchId === branchId)
    .map((r) => ({ id: r.id, name: r.name, active: sheetsClient.toBool(r.active), username: r.username || "" }))
    .filter((d) => includeInactive || d.active)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Usernames are global (not scoped to a branch) since a driver logs in from
// the same login page as everyone else, before the app knows which branch
// they belong to — it has to find them by username alone.
async function usernameTaken(username, excludeDriverId) {
  const rows = await sheetsClient.getRows("Drivers", DRIVERS_HEADERS);
  const normalized = username.trim().toLowerCase();
  return rows.some((r) => r.id !== excludeDriverId && (r.username || "").toLowerCase() === normalized);
}

async function addDriver(branchId, name, username, password) {
  if (!username || !username.trim()) throw new Error("A username is required for the driver to log in with.");
  if (!password || password.length < 6) throw new Error("Password must be at least 6 characters.");
  if (await usernameTaken(username)) throw new Error("That username is already taken. Choose another.");
  const driver = {
    id: newId(),
    branchId,
    name: name.trim(),
    active: "TRUE",
    username: username.trim(),
    passwordHash: bcrypt.hashSync(password, 10),
  };
  await sheetsClient.appendRow("Drivers", DRIVERS_HEADERS, driver);
  return { id: driver.id, name: driver.name, active: true, username: driver.username };
}

async function findDriverRow(branchId, id) {
  const rows = await sheetsClient.getRows("Drivers", DRIVERS_HEADERS);
  return rows.find((r) => r.branchId === branchId && r.id === id) || null;
}

async function updateDriver(branchId, id, { name, active, username, password }) {
  const row = await findDriverRow(branchId, id);
  if (!row) return null;
  if (typeof username === "string" && username.trim() && (await usernameTaken(username, id))) {
    throw new Error("That username is already taken. Choose another.");
  }
  if (typeof password === "string" && password && password.length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }
  const next = {
    id: row.id,
    branchId: row.branchId,
    name: typeof name === "string" && name.trim() ? name.trim() : row.name,
    active: typeof active === "boolean" ? (active ? "TRUE" : "FALSE") : row.active,
    username: typeof username === "string" && username.trim() ? username.trim() : row.username,
    passwordHash: typeof password === "string" && password ? bcrypt.hashSync(password, 10) : row.passwordHash,
  };
  await sheetsClient.updateRow("Drivers", DRIVERS_HEADERS, row.__row, next);
  return { id: next.id, name: next.name, active: sheetsClient.toBool(next.active), username: next.username };
}

// Used only by the driver login flow — searches across every branch, since
// a driver logs in by username alone before the app knows their branch.
async function verifyDriverLogin(username, password) {
  if (!username || !password) return null;
  const rows = await sheetsClient.getRows("Drivers", DRIVERS_HEADERS);
  const normalized = username.trim().toLowerCase();
  const row = rows.find((r) => (r.username || "").toLowerCase() === normalized);
  if (!row || !row.passwordHash || !sheetsClient.toBool(row.active)) return null;
  if (!bcrypt.compareSync(password, row.passwordHash)) return null;
  return { driverId: row.id, branchId: row.branchId, name: row.name };
}

async function driverHasEntries(branchId, id) {
  const rows = await sheetsClient.getRows("DeliveryEntries", DELIVERY_ENTRIES_HEADERS);
  return rows.some((r) => r.branchId === branchId && r.driverId === id);
}

async function deleteDriver(branchId, id) {
  const row = await findDriverRow(branchId, id);
  if (!row) return false;
  await sheetsClient.deleteRow("Drivers", row.__row);
  return true;
}

// ---------- delivery entries ----------

function computeDeliveryPay(driverRow, rates, isSolo) {
  const basePay = driverRow.hours * rates.driverHourlyRate;
  const zoneCounts = driverRow.zoneCounts;
  const deliveryPay = zoneCounts.reduce((sum, count, i) => sum + count * rates.zoneRates[i], 0);
  const rawTotal = basePay + deliveryPay;
  const minWageFloor = driverRow.hours * rates.minimumWage;
  const topUpApplied = isSolo && minWageFloor > rawTotal;
  const payBeforeTips = topUpApplied ? minWageFloor : rawTotal;
  // Tips are added on top of pay regardless of whether the minimum-wage
  // floor kicked in — they never factor into the floor comparison itself.
  const tips = driverRow.tips || 0;
  const finalPay = payBeforeTips + tips;
  // Cash the driver collected from customers on cash-on-delivery orders,
  // which they owe back to the till — not part of their own pay.
  const cashOrders = driverRow.cashOrders || [];
  return {
    driverId: driverRow.driverId,
    hours: driverRow.hours,
    zoneCounts,
    basePay: round2(basePay),
    deliveryPay: round2(deliveryPay),
    tips: round2(tips),
    topUpApplied,
    finalPay: round2(finalPay),
    cashOrders,
    cashOrderCount: cashOrders.length,
    cashOrderValue: round2(cashOrders.reduce((sum, v) => sum + v, 0)),
    note: driverRow.note || "",
  };
}

function withDeliveryShares(entry, rates) {
  // driverCount is the declared headcount for the day (set up front, before
  // anyone's individual details are filled in) — it's what decides solo vs.
  // multi-driver pay rules, independent of how many driver rows have been
  // filled in and saved so far. Older entries saved before this field
  // existed fall back to the row count.
  const isSolo = (entry.driverCount || entry.drivers.length) === 1;
  return { ...entry, shares: entry.drivers.map((d) => computeDeliveryPay(d, rates, isSolo)) };
}

// Regroups the Sheet's one-row-per-driver layout back into one entry object
// per distinct entryId (the shape every caller above this layer expects).
function groupDeliveryEntryRows(rows) {
  const byEntryId = new Map();
  for (const r of rows) {
    if (!byEntryId.has(r.entryId)) byEntryId.set(r.entryId, []);
    byEntryId.get(r.entryId).push(r);
  }
  return [...byEntryId.values()].map((group) => {
    const first = group[0];
    return {
      id: first.entryId,
      branchId: first.branchId,
      date: first.date,
      driverCount: Number(first.driverCount) || 0,
      drivers: group.map((r) => ({
        driverId: r.driverId,
        hours: Number(r.hours) || 0,
        zoneCounts: [Number(r.zone1Count) || 0, Number(r.zone2Count) || 0, Number(r.zone3Count) || 0, Number(r.zone4Count) || 0],
        cashOrders: JSON.parse(r.cashOrdersJson || "[]"),
        tips: Number(r.tips) || 0,
        note: r.note || "",
      })),
      __rows: group.map((r) => r.__row),
    };
  });
}

async function listDeliveryEntries(branchId, { from, to } = {}) {
  const rates = await getBranchRates(branchId);
  const rows = await sheetsClient.getRows("DeliveryEntries", DELIVERY_ENTRIES_HEADERS);
  return groupDeliveryEntryRows(rows.filter((r) => r.branchId === branchId))
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(({ __rows, branchId: _b, ...e }) => withDeliveryShares(e, rates));
}

async function findDeliveryEntryRow(branchId, id) {
  const rows = await sheetsClient.getRows("DeliveryEntries", DELIVERY_ENTRIES_HEADERS);
  const group = rows.filter((r) => r.branchId === branchId && r.entryId === id);
  return group.length ? groupDeliveryEntryRows(group)[0] : null;
}

async function getDeliveryEntry(branchId, id) {
  const found = await findDeliveryEntryRow(branchId, id);
  if (!found) return null;
  const rates = await getBranchRates(branchId);
  const { __rows, branchId: _b, ...rest } = found;
  return withDeliveryShares(rest, rates);
}

// `validDriverIds` scopes accepted rows to this branch's own driver list
// (active or inactive) so a delivery entry can never end up referencing
// another branch's driver.
function validateDeliveryEntryInput(input, validDriverIds) {
  if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error("A valid date is required.");
  }
  const driverCount = Math.floor(Number(input.driverCount));
  if (!Number.isFinite(driverCount) || driverCount < 1) {
    throw new Error("Number of drivers must be at least 1.");
  }
  const drivers = Array.isArray(input.drivers) ? input.drivers : [];
  const cleanDrivers = [];
  for (const d of drivers) {
    // A driver row that hasn't been filled in yet (no driver picked, or no
    // hours yet — e.g. they're still out on shift) is skipped rather than
    // rejected, so each driver can be saved independently as they finish up.
    if (!d || !d.driverId || !validDriverIds.has(d.driverId)) continue;
    const hours = Number(d.hours);
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const rawCounts = Array.isArray(d.zoneCounts) ? d.zoneCounts : [0, 0, 0, 0];
    const zoneCounts = [0, 1, 2, 3].map((i) => {
      const n = Number(rawCounts[i]) || 0;
      if (!Number.isFinite(n) || n < 0) throw new Error("Delivery counts must be non-negative numbers.");
      return n;
    });
    const rawCashOrders = Array.isArray(d.cashOrders) ? d.cashOrders : [];
    const cashOrders = rawCashOrders.map((v) => {
      const n = Number(v) || 0;
      if (!Number.isFinite(n) || n < 0) throw new Error("Cash order values must be non-negative numbers.");
      return n;
    });
    const tips = Number(d.tips) || 0;
    if (!Number.isFinite(tips) || tips < 0) throw new Error("Tips must be a non-negative number.");
    const note = typeof d.note === "string" ? d.note.trim().slice(0, 500) : "";
    cleanDrivers.push({ driverId: d.driverId, hours, zoneCounts, cashOrders, tips, note });
  }
  if (cleanDrivers.length === 0) throw new Error("Enter at least one driver's hours before saving.");
  return { date: input.date, driverCount, drivers: cleanDrivers };
}

async function writeDeliveryEntryRows(entryId, branchId, clean, nameById) {
  for (const d of clean.drivers) {
    await sheetsClient.appendRow("DeliveryEntries", DELIVERY_ENTRIES_HEADERS, {
      id: newId(),
      entryId,
      branchId,
      date: clean.date,
      driverCount: clean.driverCount,
      driverId: d.driverId,
      driverName: nameById.get(d.driverId) || "",
      hours: d.hours,
      zone1Count: d.zoneCounts[0],
      zone2Count: d.zoneCounts[1],
      zone3Count: d.zoneCounts[2],
      zone4Count: d.zoneCounts[3],
      tips: d.tips,
      note: d.note,
      cashOrdersJson: JSON.stringify(d.cashOrders),
    });
  }
}

async function addDeliveryEntry(branchId, input) {
  const drivers = await listDrivers(branchId, { includeInactive: true });
  const nameById = new Map(drivers.map((d) => [d.id, d.name]));
  const clean = validateDeliveryEntryInput(input, new Set(drivers.map((d) => d.id)));
  const entryId = newId();
  await writeDeliveryEntryRows(entryId, branchId, clean, nameById);
  const rates = await getBranchRates(branchId);
  return withDeliveryShares({ id: entryId, date: clean.date, driverCount: clean.driverCount, drivers: clean.drivers }, rates);
}

async function updateDeliveryEntry(branchId, id, input) {
  const existing = await findDeliveryEntryRow(branchId, id);
  if (!existing) return null;
  const drivers = await listDrivers(branchId, { includeInactive: true });
  const nameById = new Map(drivers.map((d) => [d.id, d.name]));
  const clean = validateDeliveryEntryInput(input, new Set(drivers.map((d) => d.id)));
  for (const rowNum of [...existing.__rows].sort((a, b) => b - a)) {
    await sheetsClient.deleteRow("DeliveryEntries", rowNum);
  }
  await writeDeliveryEntryRows(id, branchId, clean, nameById);
  const rates = await getBranchRates(branchId);
  return withDeliveryShares({ id, date: clean.date, driverCount: clean.driverCount, drivers: clean.drivers }, rates);
}

async function deleteDeliveryEntry(branchId, id) {
  const existing = await findDeliveryEntryRow(branchId, id);
  if (!existing) return false;
  for (const rowNum of [...existing.__rows].sort((a, b) => b - a)) {
    await sheetsClient.deleteRow("DeliveryEntries", rowNum);
  }
  return true;
}

// ---------- calendar-date helpers (UTC-anchored so there is no timezone drift) ----------

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseDateStr(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDateStr(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function addDaysStr(s, n) {
  const d = parseDateStr(s);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDateStr(d);
}

function addMonthsStr(s, n) {
  const d = parseDateStr(s);
  const nd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  return formatDateStr(nd);
}

function dayRange(anchorStr) {
  return { from: anchorStr, to: anchorStr };
}

function weekRange(anchorStr) {
  const d = parseDateStr(anchorStr);
  const diffToMonday = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - diffToMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { from: formatDateStr(monday), to: formatDateStr(sunday) };
}

function monthRange(anchorStr) {
  const d = parseDateStr(anchorStr);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { from: formatDateStr(first), to: formatDateStr(last) };
}

function quarterRange(anchorStr) {
  const d = parseDateStr(anchorStr);
  const firstMonth = Math.floor(d.getUTCMonth() / 3) * 3;
  const first = new Date(Date.UTC(d.getUTCFullYear(), firstMonth, 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), firstMonth + 3, 0));
  return { from: formatDateStr(first), to: formatDateStr(last) };
}

// ISO 8601 week number (weeks start Monday; week 1 contains the year's first Thursday).
function isoWeekNumber(dateStr) {
  const d = parseDateStr(dateStr);
  const dayNr = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  return 1 + Math.round((thursday - firstThursday) / (7 * 24 * 3600 * 1000));
}

function rangeLabel(mode, range) {
  const fmt = (s, opts) =>
    new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(parseDateStr(s));
  if (mode === "day") return fmt(range.from, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (mode === "month") return fmt(range.from, { month: "long", year: "numeric" });
  if (mode === "quarter") {
    const d = parseDateStr(range.from);
    return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  }
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  const fromLabel = fmt(range.from, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
  const toLabel = fmt(range.to, { month: "short", day: "numeric", year: "numeric" });
  return `${fromLabel} – ${toLabel} (Week ${isoWeekNumber(range.from)})`;
}

const HISTORY_MODES = ["day", "week", "month", "quarter"];

function resolveRange(mode, anchor) {
  const safeMode = HISTORY_MODES.includes(mode) ? mode : "week";
  let range, prevAnchor, nextAnchor;
  if (safeMode === "day") {
    range = dayRange(anchor);
    prevAnchor = addDaysStr(anchor, -1);
    nextAnchor = addDaysStr(anchor, 1);
  } else if (safeMode === "month") {
    range = monthRange(anchor);
    prevAnchor = addMonthsStr(anchor, -1);
    nextAnchor = addMonthsStr(anchor, 1);
  } else if (safeMode === "quarter") {
    range = quarterRange(anchor);
    prevAnchor = addMonthsStr(anchor, -3);
    nextAnchor = addMonthsStr(anchor, 3);
  } else {
    range = weekRange(anchor);
    prevAnchor = addDaysStr(anchor, -7);
    nextAnchor = addDaysStr(anchor, 7);
  }
  return { mode: safeMode, range, prevAnchor, nextAnchor, label: rangeLabel(safeMode, range) };
}

// ---------- history dashboard (weekly / monthly, per-employee, expandable) ----------

async function buildHistory({ branchId, mode, anchor }) {
  const { mode: safeMode, range, prevAnchor, nextAnchor, label } = resolveRange(mode, anchor);

  const entries = await listEntries(branchId, { from: range.from, to: range.to });
  const employees = await listEmployees(branchId, { includeInactive: true });
  const employeesById = new Map(employees.map((e) => [e.id, e]));

  const byEmployee = new Map();
  for (const entry of entries) {
    for (const share of entry.shares) {
      const row = byEmployee.get(share.employeeId) || {
        employeeId: share.employeeId,
        hours: 0,
        cashTips: 0,
        creditTips: 0,
        days: [],
      };
      row.hours += share.hours;
      row.cashTips += share.cashShare;
      row.creditTips += share.creditShare;
      row.days.push({
        entryId: entry.id,
        date: entry.date,
        hours: share.hours,
        cashTips: round2(share.cashShare),
        creditTips: round2(share.creditShare),
      });
      byEmployee.set(share.employeeId, row);
    }
  }

  const rows = Array.from(byEmployee.values())
    .map((row) => ({
      employeeId: row.employeeId,
      name: employeesById.get(row.employeeId)?.name || "(removed employee)",
      hours: round2(row.hours),
      cashTips: round2(row.cashTips),
      creditTips: round2(row.creditTips),
      total: round2(row.cashTips + row.creditTips),
      days: row.days.sort((a, b) => (a.date < b.date ? 1 : -1)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const totals = rows.reduce(
    (acc, r) => ({
      hours: round2(acc.hours + r.hours),
      cashTips: round2(acc.cashTips + r.cashTips),
      creditTips: round2(acc.creditTips + r.creditTips),
      total: round2(acc.total + r.total),
    }),
    { hours: 0, cashTips: 0, creditTips: 0, total: 0 }
  );

  return {
    mode: safeMode,
    anchor,
    prevAnchor,
    nextAnchor,
    from: range.from,
    to: range.to,
    label,
    entryCount: entries.length,
    rows,
    totals,
  };
}

// ---------- delivery history dashboard (weekly / monthly, per-driver, expandable) ----------

// `onlyDriverId`, when given, restricts this to one driver's own rows — used
// by the driver's own read-only history view so it can reuse every bit of
// this instead of re-deriving pay totals a second way.
async function buildDeliveryHistory({ branchId, mode, anchor, onlyDriverId }) {
  const { mode: safeMode, range, prevAnchor, nextAnchor, label } = resolveRange(mode, anchor);

  const entries = await listDeliveryEntries(branchId, { from: range.from, to: range.to });
  const drivers = await listDrivers(branchId, { includeInactive: true });
  const driversById = new Map(drivers.map((d) => [d.id, d]));

  const byDriver = new Map();
  for (const entry of entries) {
    const isSolo = (entry.driverCount || entry.drivers.length) === 1;
    for (const share of entry.shares) {
      if (onlyDriverId && share.driverId !== onlyDriverId) continue;
      const row = byDriver.get(share.driverId) || {
        driverId: share.driverId,
        hours: 0,
        basePay: 0,
        deliveryPay: 0,
        tips: 0,
        finalPay: 0,
        topUpDays: 0,
        cashOrderCount: 0,
        cashOrderValue: 0,
        days: [],
      };
      row.hours += share.hours;
      row.basePay += share.basePay;
      row.deliveryPay += share.deliveryPay;
      row.tips += share.tips;
      row.finalPay += share.finalPay;
      row.cashOrderCount += share.cashOrderCount;
      row.cashOrderValue += share.cashOrderValue;
      if (share.topUpApplied) row.topUpDays += 1;
      row.days.push({
        entryId: entry.id,
        date: entry.date,
        hours: share.hours,
        zoneCounts: share.zoneCounts,
        basePay: share.basePay,
        deliveryPay: share.deliveryPay,
        tips: share.tips,
        isSolo,
        topUpApplied: share.topUpApplied,
        finalPay: share.finalPay,
        cashOrderCount: share.cashOrderCount,
        cashOrderValue: round2(share.cashOrderValue),
        note: share.note,
      });
      byDriver.set(share.driverId, row);
    }
  }

  const rows = Array.from(byDriver.values())
    .map((row) => ({
      driverId: row.driverId,
      name: driversById.get(row.driverId)?.name || "(removed driver)",
      hours: round2(row.hours),
      basePay: round2(row.basePay),
      deliveryPay: round2(row.deliveryPay),
      tips: round2(row.tips),
      finalPay: round2(row.finalPay),
      topUpDays: row.topUpDays,
      cashOrderCount: row.cashOrderCount,
      cashOrderValue: round2(row.cashOrderValue),
      days: row.days.sort((a, b) => (a.date < b.date ? 1 : -1)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const totals = rows.reduce(
    (acc, r) => ({
      hours: round2(acc.hours + r.hours),
      basePay: round2(acc.basePay + r.basePay),
      deliveryPay: round2(acc.deliveryPay + r.deliveryPay),
      tips: round2(acc.tips + r.tips),
      finalPay: round2(acc.finalPay + r.finalPay),
      cashOrderCount: acc.cashOrderCount + r.cashOrderCount,
      cashOrderValue: round2(acc.cashOrderValue + r.cashOrderValue),
    }),
    { hours: 0, basePay: 0, deliveryPay: 0, tips: 0, finalPay: 0, cashOrderCount: 0, cashOrderValue: 0 }
  );

  return {
    mode: safeMode,
    anchor,
    prevAnchor,
    nextAnchor,
    from: range.from,
    to: range.to,
    label,
    entryCount: entries.length,
    rows,
    totals,
  };
}

// The driver's own read-only view — always weekly (never daily/monthly/
// quarterly like the branch admin's view), and only ever this one driver's
// pay, never other drivers'.
async function getDriverOwnHistory({ branchId, driverId, anchor }) {
  return buildDeliveryHistory({ branchId, mode: "week", anchor, onlyDriverId: driverId });
}

// ---------- flattened cross-branch dataset (owner analytics dashboard) ----------

async function getAnalyticsData() {
  const branches = await getBranches();
  const employees = [];
  const drivers = [];
  const tipRows = [];
  const deliveryRows = [];
  for (const b of branches) {
    const [emps, drvs, entries, deliveryEntries] = await Promise.all([
      listEmployees(b.id, { includeInactive: true }),
      listDrivers(b.id, { includeInactive: true }),
      listEntries(b.id),
      listDeliveryEntries(b.id),
    ]);
    for (const e of emps) employees.push({ id: e.id, branchId: b.id, name: e.name, active: e.active });
    for (const d of drvs) drivers.push({ id: d.id, branchId: b.id, name: d.name, active: d.active });
    for (const entry of entries) {
      for (const share of entry.shares) {
        tipRows.push({
          entryId: entry.id,
          branchId: b.id,
          date: entry.date,
          employeeId: share.employeeId,
          hours: share.hours,
          cashTips: share.cashShare,
          creditTips: share.creditShare,
        });
      }
    }
    for (const entry of deliveryEntries) {
      for (const share of entry.shares) {
        deliveryRows.push({
          entryId: entry.id,
          branchId: b.id,
          date: entry.date,
          driverId: share.driverId,
          hours: share.hours,
          zoneCounts: share.zoneCounts,
          basePay: share.basePay,
          deliveryPay: share.deliveryPay,
          tips: share.tips,
          topUpApplied: share.topUpApplied,
          finalPay: share.finalPay,
          cashOrderCount: share.cashOrderCount,
          cashOrderValue: share.cashOrderValue,
          note: share.note,
        });
      }
    }
  }
  return { branches, employees, drivers, tipRows, deliveryRows };
}

// ---------- retention: auto-delete entries older than 2 years ----------

async function deleteRowsOlderThan(tabName, headers, branchId, cutoffDateStr) {
  const rows = await sheetsClient.getRows(tabName, headers);
  const toDelete = rows
    .filter((r) => r.branchId === branchId && r.date < cutoffDateStr)
    .sort((a, b) => b.__row - a.__row);
  for (const r of toDelete) {
    await sheetsClient.deleteRow(tabName, r.__row);
  }
  return toDelete.length;
}

// If the owner has turned this on, permanently removes every Tip Sheet and
// Delivery Payout entry more than 2 years old (a rolling window measured
// from today, not a fixed calendar date) across every branch. There's no
// background scheduler in this app, so this runs opportunistically —
// whenever the owner dashboard is opened (see GET /api/owner/analytics) and
// right after the setting is turned on — rather than on a fixed clock; a
// deployment nobody opens for a while just catches up on the next visit.
async function purgeOldEntriesIfEnabled() {
  const enabled = await getAutoDeleteOldEntries();
  if (!enabled) return { ran: false, deletedCount: 0 };
  const cutoff = (() => {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - 2);
    return formatDateStr(d);
  })();
  const branches = await getBranches();
  let deletedCount = 0;
  for (const b of branches) {
    deletedCount += await deleteRowsOlderThan("Entries", ENTRIES_HEADERS, b.id, cutoff);
    deletedCount += await deleteRowsOlderThan("DeliveryEntries", DELIVERY_ENTRIES_HEADERS, b.id, cutoff);
  }
  return { ran: true, deletedCount };
}

module.exports = {
  ensureSeeded,
  getBranches,
  branchExists,
  verifyOwnerPassword,
  updateOwnerPassword,
  hasOwnerPassword,
  getOwnerGoogleEmail,
  setOwnerGoogleEmail,
  getAutoDeleteOldEntries,
  setAutoDeleteOldEntries,
  purgeOldEntriesIfEnabled,
  getAnalyticsData,
  createBranch,
  updateBranchByOwner,
  deleteBranch,
  verifyStaffPassword,
  verifyAdminPassword,
  updateBranchStaffPassword,
  updateBranchAdminPassword,
  getBranchRates,
  getGlobalRates,
  setGlobalRates,
  listEmployees,
  addEmployee,
  updateEmployee,
  employeeHasEntries,
  deleteEmployee,
  listEntries,
  getEntry,
  addEntry,
  updateEntry,
  deleteEntry,
  buildHistory,
  listDrivers,
  addDriver,
  updateDriver,
  driverHasEntries,
  deleteDriver,
  verifyDriverLogin,
  getDriverOwnHistory,
  listDeliveryEntries,
  getDeliveryEntry,
  addDeliveryEntry,
  updateDeliveryEntry,
  deleteDeliveryEntry,
  buildDeliveryHistory,
  formatDateStr,
};
