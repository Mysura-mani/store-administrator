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
const DRIVERS_HEADERS = ["id", "branchId", "name", "active"];
const ENTRIES_HEADERS = ["id", "branchId", "date", "cashTips", "creditTips", "shiftsJson"];
const DELIVERY_ENTRIES_HEADERS = ["id", "branchId", "date", "driverCount", "driversJson"];

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function newId() {
  return crypto.randomUUID();
}

// ---------- config (branches + credentials), stored as key/value rows ----------

let seededPromise = null;
function ensureSeeded() {
  if (!seededPromise) seededPromise = doEnsureSeeded();
  return seededPromise;
}

async function doEnsureSeeded() {
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
    rates: { ...DEFAULT_RATES, zoneRates: [...DEFAULT_RATES.zoneRates] },
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

async function getBranchRates(branchId) {
  const branch = await getBranchConfig(branchId);
  if (!branch) return null;
  return branch.rates || { ...DEFAULT_RATES, zoneRates: [...DEFAULT_RATES.zoneRates] };
}

async function updateBranchRates(branchId, { driverHourlyRate, minimumWage, zoneRates }) {
  const cfg = await getConfig();
  const branches = cfg.branches || [];
  const branch = branches.find((b) => b.id === branchId);
  if (!branch) return null;
  const current = branch.rates || { ...DEFAULT_RATES, zoneRates: [...DEFAULT_RATES.zoneRates] };
  const next = { ...current };
  if (Number.isFinite(driverHourlyRate) && driverHourlyRate >= 0) next.driverHourlyRate = driverHourlyRate;
  if (Number.isFinite(minimumWage) && minimumWage >= 0) next.minimumWage = minimumWage;
  if (Array.isArray(zoneRates) && zoneRates.length === 4 && zoneRates.every((r) => Number.isFinite(r) && r >= 0)) {
    next.zoneRates = zoneRates;
  }
  branch.rates = next;
  await saveBranches(branches);
  return next;
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
  return rows
    .filter((r) => r.branchId === branchId)
    .some((r) => JSON.parse(r.shiftsJson || "[]").some((s) => s.employeeId === id));
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

function parseEntryRow(r) {
  return {
    id: r.id,
    branchId: r.branchId,
    date: r.date,
    cashTips: Number(r.cashTips) || 0,
    creditTips: Number(r.creditTips) || 0,
    shifts: JSON.parse(r.shiftsJson || "[]"),
    __row: r.__row,
  };
}

async function listEntries(branchId, { from, to } = {}) {
  const rows = await sheetsClient.getRows("Entries", ENTRIES_HEADERS);
  return rows
    .filter((r) => r.branchId === branchId)
    .map(parseEntryRow)
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(({ __row, branchId: _b, ...e }) => withShares(e));
}

async function findEntryRow(branchId, id) {
  const rows = await sheetsClient.getRows("Entries", ENTRIES_HEADERS);
  const found = rows.find((r) => r.branchId === branchId && r.id === id);
  return found ? parseEntryRow(found) : null;
}

async function getEntry(branchId, id) {
  const found = await findEntryRow(branchId, id);
  if (!found) return null;
  const { __row, branchId: _b, ...rest } = found;
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

async function addEntry(branchId, input) {
  const employees = await listEmployees(branchId, { includeInactive: true });
  const clean = validateEntryInput(input, new Set(employees.map((e) => e.id)));
  const id = newId();
  await sheetsClient.appendRow("Entries", ENTRIES_HEADERS, {
    id,
    branchId,
    date: clean.date,
    cashTips: clean.cashTips,
    creditTips: clean.creditTips,
    shiftsJson: JSON.stringify(clean.shifts),
  });
  return withShares({ id, date: clean.date, cashTips: clean.cashTips, creditTips: clean.creditTips, shifts: clean.shifts });
}

async function updateEntry(branchId, id, input) {
  const existing = await findEntryRow(branchId, id);
  if (!existing) return null;
  const employees = await listEmployees(branchId, { includeInactive: true });
  const clean = validateEntryInput(input, new Set(employees.map((e) => e.id)));
  await sheetsClient.updateRow("Entries", ENTRIES_HEADERS, existing.__row, {
    id,
    branchId,
    date: clean.date,
    cashTips: clean.cashTips,
    creditTips: clean.creditTips,
    shiftsJson: JSON.stringify(clean.shifts),
  });
  return withShares({ id, date: clean.date, cashTips: clean.cashTips, creditTips: clean.creditTips, shifts: clean.shifts });
}

async function deleteEntry(branchId, id) {
  const existing = await findEntryRow(branchId, id);
  if (!existing) return false;
  await sheetsClient.deleteRow("Entries", existing.__row);
  return true;
}

// ---------- drivers ----------

async function listDrivers(branchId, { includeInactive = false } = {}) {
  const rows = await sheetsClient.getRows("Drivers", DRIVERS_HEADERS);
  return rows
    .filter((r) => r.branchId === branchId)
    .map((r) => ({ id: r.id, name: r.name, active: sheetsClient.toBool(r.active) }))
    .filter((d) => includeInactive || d.active)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function addDriver(branchId, name) {
  const driver = { id: newId(), branchId, name: name.trim(), active: "TRUE" };
  await sheetsClient.appendRow("Drivers", DRIVERS_HEADERS, driver);
  return { id: driver.id, name: driver.name, active: true };
}

async function findDriverRow(branchId, id) {
  const rows = await sheetsClient.getRows("Drivers", DRIVERS_HEADERS);
  return rows.find((r) => r.branchId === branchId && r.id === id) || null;
}

async function updateDriver(branchId, id, { name, active }) {
  const row = await findDriverRow(branchId, id);
  if (!row) return null;
  const next = {
    id: row.id,
    branchId: row.branchId,
    name: typeof name === "string" && name.trim() ? name.trim() : row.name,
    active: typeof active === "boolean" ? (active ? "TRUE" : "FALSE") : row.active,
  };
  await sheetsClient.updateRow("Drivers", DRIVERS_HEADERS, row.__row, next);
  return { id: next.id, name: next.name, active: sheetsClient.toBool(next.active) };
}

async function driverHasEntries(branchId, id) {
  const rows = await sheetsClient.getRows("DeliveryEntries", DELIVERY_ENTRIES_HEADERS);
  return rows
    .filter((r) => r.branchId === branchId)
    .some((r) => JSON.parse(r.driversJson || "[]").some((d) => d.driverId === id));
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

function parseDeliveryEntryRow(r) {
  return {
    id: r.id,
    branchId: r.branchId,
    date: r.date,
    driverCount: Number(r.driverCount) || 0,
    drivers: JSON.parse(r.driversJson || "[]"),
    __row: r.__row,
  };
}

async function listDeliveryEntries(branchId, { from, to } = {}) {
  const rates = await getBranchRates(branchId);
  const rows = await sheetsClient.getRows("DeliveryEntries", DELIVERY_ENTRIES_HEADERS);
  return rows
    .filter((r) => r.branchId === branchId)
    .map(parseDeliveryEntryRow)
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(({ __row, branchId: _b, ...e }) => withDeliveryShares(e, rates));
}

async function findDeliveryEntryRow(branchId, id) {
  const rows = await sheetsClient.getRows("DeliveryEntries", DELIVERY_ENTRIES_HEADERS);
  const found = rows.find((r) => r.branchId === branchId && r.id === id);
  return found ? parseDeliveryEntryRow(found) : null;
}

async function getDeliveryEntry(branchId, id) {
  const found = await findDeliveryEntryRow(branchId, id);
  if (!found) return null;
  const rates = await getBranchRates(branchId);
  const { __row, branchId: _b, ...rest } = found;
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

async function addDeliveryEntry(branchId, input) {
  const drivers = await listDrivers(branchId, { includeInactive: true });
  const clean = validateDeliveryEntryInput(input, new Set(drivers.map((d) => d.id)));
  const id = newId();
  await sheetsClient.appendRow("DeliveryEntries", DELIVERY_ENTRIES_HEADERS, {
    id,
    branchId,
    date: clean.date,
    driverCount: clean.driverCount,
    driversJson: JSON.stringify(clean.drivers),
  });
  const rates = await getBranchRates(branchId);
  return withDeliveryShares({ id, date: clean.date, driverCount: clean.driverCount, drivers: clean.drivers }, rates);
}

async function updateDeliveryEntry(branchId, id, input) {
  const existing = await findDeliveryEntryRow(branchId, id);
  if (!existing) return null;
  const drivers = await listDrivers(branchId, { includeInactive: true });
  const clean = validateDeliveryEntryInput(input, new Set(drivers.map((d) => d.id)));
  await sheetsClient.updateRow("DeliveryEntries", DELIVERY_ENTRIES_HEADERS, existing.__row, {
    id,
    branchId,
    date: clean.date,
    driverCount: clean.driverCount,
    driversJson: JSON.stringify(clean.drivers),
  });
  const rates = await getBranchRates(branchId);
  return withDeliveryShares({ id, date: clean.date, driverCount: clean.driverCount, drivers: clean.drivers }, rates);
}

async function deleteDeliveryEntry(branchId, id) {
  const existing = await findDeliveryEntryRow(branchId, id);
  if (!existing) return false;
  await sheetsClient.deleteRow("DeliveryEntries", existing.__row);
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

async function buildDeliveryHistory({ branchId, mode, anchor }) {
  const { mode: safeMode, range, prevAnchor, nextAnchor, label } = resolveRange(mode, anchor);

  const entries = await listDeliveryEntries(branchId, { from: range.from, to: range.to });
  const drivers = await listDrivers(branchId, { includeInactive: true });
  const driversById = new Map(drivers.map((d) => [d.id, d]));

  const byDriver = new Map();
  for (const entry of entries) {
    const isSolo = (entry.driverCount || entry.drivers.length) === 1;
    for (const share of entry.shares) {
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

module.exports = {
  ensureSeeded,
  getBranches,
  branchExists,
  verifyOwnerPassword,
  updateOwnerPassword,
  hasOwnerPassword,
  getOwnerGoogleEmail,
  setOwnerGoogleEmail,
  getAnalyticsData,
  createBranch,
  updateBranchByOwner,
  deleteBranch,
  verifyStaffPassword,
  verifyAdminPassword,
  updateBranchStaffPassword,
  updateBranchAdminPassword,
  getBranchRates,
  updateBranchRates,
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
  listDeliveryEntries,
  getDeliveryEntry,
  addDeliveryEntry,
  updateDeliveryEntry,
  deleteDeliveryEntry,
  buildDeliveryHistory,
  formatDateStr,
};
