const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const DATA_PATH = path.join(DATA_DIR, "data.json");

const DEFAULT_BRANCHES = [
  { id: "A", name: "Branch A", staffPassword: "a123", adminPassword: "aadmin123" },
  { id: "B", name: "Branch B", staffPassword: "b123", adminPassword: "badmin123" },
  { id: "C", name: "Branch C", staffPassword: "c123", adminPassword: "cadmin123" },
  { id: "D", name: "Branch D", staffPassword: "d123", adminPassword: "dadmin123" },
];

const DEFAULT_RATES = {
  driverHourlyRate: 6,
  minimumWage: 14.15,
  zoneRates: [3, 3.5, 4, 5],
};

const DEFAULT_OWNER_PASSWORD = "owner123";

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function writeJson(filePath, value) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------- config (branches + credentials) ----------

function ensureSeeded() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const branches = DEFAULT_BRANCHES.map((b) => ({
      id: b.id,
      name: b.name,
      staffPasswordHash: bcrypt.hashSync(b.staffPassword, 10),
      adminPasswordHash: bcrypt.hashSync(b.adminPassword, 10),
      rates: { ...DEFAULT_RATES, zoneRates: [...DEFAULT_RATES.zoneRates] },
    }));
    writeJson(CONFIG_PATH, { branches, ownerPasswordHash: bcrypt.hashSync(DEFAULT_OWNER_PASSWORD, 10) });
    return;
  }
  // Backfill the owner account for configs saved before the owner role existed.
  const cfg = getConfig();
  if (!cfg.ownerPasswordHash) {
    cfg.ownerPasswordHash = bcrypt.hashSync(DEFAULT_OWNER_PASSWORD, 10);
    saveConfig(cfg);
  }
}

function getConfig() {
  return readJson(CONFIG_PATH, { branches: [] });
}

function saveConfig(cfg) {
  writeJson(CONFIG_PATH, cfg);
}

function getBranches() {
  return getConfig().branches.map((b) => ({ id: b.id, name: b.name }));
}

function getBranchConfig(branchId) {
  return getConfig().branches.find((b) => b.id === branchId) || null;
}

function branchExists(branchId) {
  return !!getBranchConfig(branchId);
}

// ---------- owner (super-admin over all branches) ----------

function verifyOwnerPassword(password) {
  const cfg = getConfig();
  if (!cfg.ownerPasswordHash || !password) return false;
  return bcrypt.compareSync(password, cfg.ownerPasswordHash);
}

function updateOwnerPassword(newPassword) {
  const cfg = getConfig();
  cfg.ownerPasswordHash = bcrypt.hashSync(newPassword, 10);
  saveConfig(cfg);
}

// The single Gmail address allowed to sign in as owner via Google. Unset by
// default — "Sign in with Google" stays disabled until the owner sets this
// themselves (from the owner dashboard, after logging in with the password),
// so there's no bootstrap gap where an unconfigured Google login could work.
function getOwnerGoogleEmail() {
  return getConfig().ownerGoogleEmail || null;
}

function setOwnerGoogleEmail(email) {
  const cfg = getConfig();
  cfg.ownerGoogleEmail = email ? email.trim().toLowerCase() : null;
  saveConfig(cfg);
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

function createBranch({ name, staffPassword, adminPassword }) {
  const cfg = getConfig();
  const id = generateBranchId(name, cfg.branches.map((b) => b.id));
  const branch = {
    id,
    name: name.trim(),
    staffPasswordHash: bcrypt.hashSync(staffPassword, 10),
    adminPasswordHash: bcrypt.hashSync(adminPassword, 10),
    rates: { ...DEFAULT_RATES, zoneRates: [...DEFAULT_RATES.zoneRates] },
  };
  cfg.branches.push(branch);
  saveConfig(cfg);
  return { id: branch.id, name: branch.name };
}

// Owner-level update: unlike updateBranchStaffPassword/updateBranchAdminPassword
// (self-service, used by a branch's own admin), this can also rename the store
// and does not require knowing the current password.
function updateBranchByOwner(id, { name, staffPassword, adminPassword }) {
  const cfg = getConfig();
  const branch = cfg.branches.find((b) => b.id === id);
  if (!branch) return null;
  if (typeof name === "string" && name.trim()) branch.name = name.trim();
  if (staffPassword) branch.staffPasswordHash = bcrypt.hashSync(staffPassword, 10);
  if (adminPassword) branch.adminPasswordHash = bcrypt.hashSync(adminPassword, 10);
  saveConfig(cfg);
  return { id: branch.id, name: branch.name };
}

function deleteBranch(id) {
  const cfg = getConfig();
  const before = cfg.branches.length;
  cfg.branches = cfg.branches.filter((b) => b.id !== id);
  saveConfig(cfg);
  if (cfg.branches.length === before) return false;
  const data = readAllData();
  delete data.branches[id];
  writeAllData(data);
  return true;
}

function verifyStaffPassword(branchId, password) {
  const branch = getBranchConfig(branchId);
  if (!branch || !password) return false;
  return bcrypt.compareSync(password, branch.staffPasswordHash);
}

function verifyAdminPassword(branchId, password) {
  const branch = getBranchConfig(branchId);
  if (!branch || !password) return false;
  return bcrypt.compareSync(password, branch.adminPasswordHash);
}

function updateBranchStaffPassword(branchId, newPassword) {
  const cfg = getConfig();
  const branch = cfg.branches.find((b) => b.id === branchId);
  if (!branch) return false;
  branch.staffPasswordHash = bcrypt.hashSync(newPassword, 10);
  saveConfig(cfg);
  return true;
}

function updateBranchAdminPassword(branchId, newPassword) {
  const cfg = getConfig();
  const branch = cfg.branches.find((b) => b.id === branchId);
  if (!branch) return false;
  branch.adminPasswordHash = bcrypt.hashSync(newPassword, 10);
  saveConfig(cfg);
  return true;
}

function getBranchRates(branchId) {
  const branch = getBranchConfig(branchId);
  if (!branch) return null;
  return branch.rates || { ...DEFAULT_RATES, zoneRates: [...DEFAULT_RATES.zoneRates] };
}

function updateBranchRates(branchId, { driverHourlyRate, minimumWage, zoneRates }) {
  const cfg = getConfig();
  const branch = cfg.branches.find((b) => b.id === branchId);
  if (!branch) return null;
  const current = branch.rates || { ...DEFAULT_RATES, zoneRates: [...DEFAULT_RATES.zoneRates] };
  const next = { ...current };
  if (Number.isFinite(driverHourlyRate) && driverHourlyRate >= 0) next.driverHourlyRate = driverHourlyRate;
  if (Number.isFinite(minimumWage) && minimumWage >= 0) next.minimumWage = minimumWage;
  if (Array.isArray(zoneRates) && zoneRates.length === 4 && zoneRates.every((r) => Number.isFinite(r) && r >= 0)) {
    next.zoneRates = zoneRates;
  }
  branch.rates = next;
  saveConfig(cfg);
  return next;
}

// ---------- per-branch app data (employees + entries) ----------

function defaultData() {
  return { branches: {} };
}

function defaultBranchData() {
  return { employees: [], entries: [], drivers: [], deliveryEntries: [] };
}

function readAllData() {
  return readJson(DATA_PATH, defaultData());
}

function writeAllData(data) {
  writeJson(DATA_PATH, data);
}

function readBranchData(branchId) {
  const data = readAllData();
  const branch = data.branches[branchId] || {};
  return { ...defaultBranchData(), ...branch };
}

function writeBranchData(branchId, branchData) {
  const data = readAllData();
  data.branches[branchId] = branchData;
  writeAllData(data);
}

function newId() {
  return crypto.randomUUID();
}

// ---------- employees ----------

function listEmployees(branchId, { includeInactive = false } = {}) {
  const data = readBranchData(branchId);
  return data.employees
    .filter((e) => includeInactive || e.active)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function addEmployee(branchId, name) {
  const data = readBranchData(branchId);
  const employee = { id: newId(), name: name.trim(), active: true };
  data.employees.push(employee);
  writeBranchData(branchId, data);
  return employee;
}

function updateEmployee(branchId, id, { name, active }) {
  const data = readBranchData(branchId);
  const employee = data.employees.find((e) => e.id === id);
  if (!employee) return null;
  if (typeof name === "string" && name.trim()) employee.name = name.trim();
  if (typeof active === "boolean") employee.active = active;
  writeBranchData(branchId, data);
  return employee;
}

function employeeHasEntries(branchId, id) {
  const data = readBranchData(branchId);
  return data.entries.some((entry) => entry.shifts.some((s) => s.employeeId === id));
}

function deleteEmployee(branchId, id) {
  const data = readBranchData(branchId);
  const before = data.employees.length;
  data.employees = data.employees.filter((e) => e.id !== id);
  writeBranchData(branchId, data);
  return data.employees.length < before;
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

function listEntries(branchId, { from, to } = {}) {
  const data = readBranchData(branchId);
  return data.entries
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(withShares);
}

function getEntry(branchId, id) {
  const data = readBranchData(branchId);
  const entry = data.entries.find((e) => e.id === id);
  return entry ? withShares(entry) : null;
}

function validateEntryInput(input) {
  if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error("A valid date is required.");
  }
  const cashTips = Number(input.cashTips);
  const creditTips = Number(input.creditTips);
  if (!Number.isFinite(cashTips) || cashTips < 0) throw new Error("Cash tips must be a non-negative number.");
  if (!Number.isFinite(creditTips) || creditTips < 0) throw new Error("Credit tips must be a non-negative number.");
  const shifts = Array.isArray(input.shifts) ? input.shifts : [];
  const cleanShifts = shifts
    .filter((s) => s && s.employeeId)
    .map((s) => {
      const hours = Number(s.hours);
      if (!Number.isFinite(hours) || hours <= 0) throw new Error("Each employee's hours must be a positive number.");
      return { employeeId: s.employeeId, hours };
    });
  if (cleanShifts.length === 0) throw new Error("Add at least one employee with hours worked.");
  return { date: input.date, cashTips, creditTips, shifts: cleanShifts };
}

function addEntry(branchId, input) {
  const clean = validateEntryInput(input);
  const data = readBranchData(branchId);
  const entry = { id: newId(), ...clean };
  data.entries.push(entry);
  writeBranchData(branchId, data);
  return withShares(entry);
}

function updateEntry(branchId, id, input) {
  const clean = validateEntryInput(input);
  const data = readBranchData(branchId);
  const entry = data.entries.find((e) => e.id === id);
  if (!entry) return null;
  Object.assign(entry, clean);
  writeBranchData(branchId, data);
  return withShares(entry);
}

function deleteEntry(branchId, id) {
  const data = readBranchData(branchId);
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => e.id !== id);
  writeBranchData(branchId, data);
  return data.entries.length < before;
}

// ---------- drivers ----------

function listDrivers(branchId, { includeInactive = false } = {}) {
  const data = readBranchData(branchId);
  return data.drivers
    .filter((d) => includeInactive || d.active)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function addDriver(branchId, name) {
  const data = readBranchData(branchId);
  const driver = { id: newId(), name: name.trim(), active: true };
  data.drivers.push(driver);
  writeBranchData(branchId, data);
  return driver;
}

function updateDriver(branchId, id, { name, active }) {
  const data = readBranchData(branchId);
  const driver = data.drivers.find((d) => d.id === id);
  if (!driver) return null;
  if (typeof name === "string" && name.trim()) driver.name = name.trim();
  if (typeof active === "boolean") driver.active = active;
  writeBranchData(branchId, data);
  return driver;
}

function driverHasEntries(branchId, id) {
  const data = readBranchData(branchId);
  return data.deliveryEntries.some((entry) => entry.drivers.some((s) => s.driverId === id));
}

function deleteDriver(branchId, id) {
  const data = readBranchData(branchId);
  const before = data.drivers.length;
  data.drivers = data.drivers.filter((d) => d.id !== id);
  writeBranchData(branchId, data);
  return data.drivers.length < before;
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

function listDeliveryEntries(branchId, { from, to } = {}) {
  const rates = getBranchRates(branchId);
  const data = readBranchData(branchId);
  return data.deliveryEntries
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((e) => withDeliveryShares(e, rates));
}

function getDeliveryEntry(branchId, id) {
  const rates = getBranchRates(branchId);
  const data = readBranchData(branchId);
  const entry = data.deliveryEntries.find((e) => e.id === id);
  return entry ? withDeliveryShares(entry, rates) : null;
}

function validateDeliveryEntryInput(input) {
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
    if (!d || !d.driverId) continue;
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

function addDeliveryEntry(branchId, input) {
  const clean = validateDeliveryEntryInput(input);
  const data = readBranchData(branchId);
  const entry = { id: newId(), ...clean };
  data.deliveryEntries.push(entry);
  writeBranchData(branchId, data);
  return withDeliveryShares(entry, getBranchRates(branchId));
}

function updateDeliveryEntry(branchId, id, input) {
  const clean = validateDeliveryEntryInput(input);
  const data = readBranchData(branchId);
  const entry = data.deliveryEntries.find((e) => e.id === id);
  if (!entry) return null;
  Object.assign(entry, clean);
  writeBranchData(branchId, data);
  return withDeliveryShares(entry, getBranchRates(branchId));
}

function deleteDeliveryEntry(branchId, id) {
  const data = readBranchData(branchId);
  const before = data.deliveryEntries.length;
  data.deliveryEntries = data.deliveryEntries.filter((e) => e.id !== id);
  writeBranchData(branchId, data);
  return data.deliveryEntries.length < before;
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

function buildHistory({ branchId, mode, anchor }) {
  const { mode: safeMode, range, prevAnchor, nextAnchor, label } = resolveRange(mode, anchor);

  const entries = listEntries(branchId, { from: range.from, to: range.to });
  const data = readBranchData(branchId);
  const employeesById = new Map(data.employees.map((e) => [e.id, e]));

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

function buildDeliveryHistory({ branchId, mode, anchor }) {
  const { mode: safeMode, range, prevAnchor, nextAnchor, label } = resolveRange(mode, anchor);

  const entries = listDeliveryEntries(branchId, { from: range.from, to: range.to });
  const data = readBranchData(branchId);
  const driversById = new Map(data.drivers.map((d) => [d.id, d]));

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

module.exports = {
  ensureSeeded,
  getBranches,
  branchExists,
  verifyOwnerPassword,
  updateOwnerPassword,
  getOwnerGoogleEmail,
  setOwnerGoogleEmail,
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
