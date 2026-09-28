// Syncs business data (employees, drivers, tip entries, delivery entries)
// into a single Google Sheet owned by whichever Gmail account the Owner
// signed in with. Branch/admin/owner passwords and pay-rate settings are
// NOT included here — they stay in the local config file.
//
// Local storage (backend/data/data.json) remains the fast, always-available
// copy that every request reads/writes against — the Sheet is a mirror kept
// eventually-consistent in the background, so a brief loss of internet or a
// Google API hiccup never blocks or loses an entry. Every mutation marks the
// affected tabs "dirty"; a short interval (and an immediate best-effort
// attempt right after the write) pushes the full current contents of each
// dirty tab up to the Sheet, retrying until it succeeds.
const { google } = require("googleapis");

const TABS = ["Employees", "Drivers", "Entries", "DeliveryEntries"];

const HEADERS = {
  Employees: ["id", "branchId", "branchName", "name", "active"],
  Drivers: ["id", "branchId", "branchName", "name", "active"],
  Entries: ["entryId", "branchId", "branchName", "date", "employeeId", "employeeName", "hours", "cashTips", "creditTips"],
  DeliveryEntries: [
    "entryId",
    "branchId",
    "branchName",
    "date",
    "driverId",
    "driverName",
    "hours",
    "zone1Count",
    "zone2Count",
    "zone3Count",
    "zone4Count",
    "basePay",
    "deliveryPay",
    "tips",
    "topUpApplied",
    "finalPay",
    "cashOrderCount",
    "cashOrderValue",
    "note",
  ],
};

const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/spreadsheets"];
const SYNC_INTERVAL_MS = 10000;

let flushPromise = null;
let flushTimer = null;

function getStore() {
  // Required lazily to avoid a circular require — store.js requires this
  // module too (to mark tabs dirty right after a local write).
  return require("./store");
}

function getScopes() {
  return SCOPES;
}

function buildOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "";
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function isConfigured() {
  return !!buildOAuthClient();
}

// Called from the /auth/google/callback route right after the Owner's
// identity is verified. `tokens` is whatever oauthClient.getToken() returned.
async function handleOwnerLogin(tokens) {
  const store = getStore();
  if (tokens.refresh_token) {
    store.setGoogleSheetsState({ refreshToken: tokens.refresh_token, lastError: null });
  }
  const state = store.getGoogleSheetsState();
  if (!state.refreshToken) return; // no offline access granted — nothing to sync with
  markDirtyAll();
  flushNow().catch((err) => {
    store.setGoogleSheetsState({ lastError: err.message });
  });
}

function markDirtyAll() {
  const store = getStore();
  store.setGoogleSheetsState({ dirtyTabs: [...TABS] });
  // Best-effort immediate push so changes usually land within moments —
  // failures here are silent since the interval timer (and the next write)
  // will retry regardless.
  flushNow().catch(() => {});
}

function rowsForTab(tabName, analytics) {
  const branchNameById = new Map(analytics.branches.map((b) => [b.id, b.name]));
  const employeeNameById = new Map(analytics.employees.map((e) => [e.id, e.name]));
  const driverNameById = new Map(analytics.drivers.map((d) => [d.id, d.name]));

  if (tabName === "Employees") {
    return analytics.employees.map((e) => [e.id, e.branchId, branchNameById.get(e.branchId) || "", e.name, e.active]);
  }
  if (tabName === "Drivers") {
    return analytics.drivers.map((d) => [d.id, d.branchId, branchNameById.get(d.branchId) || "", d.name, d.active]);
  }
  if (tabName === "Entries") {
    return analytics.tipRows.map((r) => [
      r.entryId,
      r.branchId,
      branchNameById.get(r.branchId) || "",
      r.date,
      r.employeeId,
      employeeNameById.get(r.employeeId) || "(removed employee)",
      r.hours,
      r.cashTips,
      r.creditTips,
    ]);
  }
  if (tabName === "DeliveryEntries") {
    return analytics.deliveryRows.map((r) => [
      r.entryId,
      r.branchId,
      branchNameById.get(r.branchId) || "",
      r.date,
      r.driverId,
      driverNameById.get(r.driverId) || "(removed driver)",
      r.hours,
      r.zoneCounts[0],
      r.zoneCounts[1],
      r.zoneCounts[2],
      r.zoneCounts[3],
      r.basePay,
      r.deliveryPay,
      r.tips,
      r.topUpApplied,
      r.finalPay,
      r.cashOrderCount,
      r.cashOrderValue,
      r.note,
    ]);
  }
  return [];
}

async function createSpreadsheet(sheetsApi) {
  const res = await sheetsApi.spreadsheets.create({
    requestBody: {
      properties: { title: "Tips Tracker Data" },
      sheets: TABS.map((title) => ({ properties: { title } })),
    },
  });
  return { sheetId: res.data.spreadsheetId, sheetUrl: res.data.spreadsheetUrl };
}

// Rewrites the header row every time (not just at creation) so a header
// schema change (e.g. an added column) migrates an already-existing sheet
// automatically on the next sync, with no manual intervention needed.
async function writeTab(sheetsApi, sheetId, tabName, rows) {
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS[tabName]] },
  });
  await sheetsApi.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `${tabName}!A2:Z200000`,
  });
  if (rows.length > 0) {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tabName}!A2`,
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
  }
}

// Concurrent callers (the background timer, markDirtyAll()'s best-effort
// push, and an explicit "Sync now") all await the SAME in-flight run rather
// than one silently no-op'ing while another is mid-flight — otherwise a
// caller that awaits this (e.g. the "Sync now" endpoint) could return before
// the sync it asked for actually finished.
function flushNow() {
  if (!flushPromise) {
    flushPromise = doFlush().finally(() => {
      flushPromise = null;
    });
  }
  return flushPromise;
}

async function doFlush() {
  const store = getStore();
  const state = store.getGoogleSheetsState();
  if (!state.refreshToken) return; // not connected yet
  const dirtyTabs = state.dirtyTabs || [];
  if (dirtyTabs.length === 0) return;

  const oauth2Client = buildOAuthClient();
  if (!oauth2Client) return;
  oauth2Client.setCredentials({ refresh_token: state.refreshToken });
  const sheetsApi = google.sheets({ version: "v4", auth: oauth2Client });

  try {
    let sheetId = state.sheetId;
    let sheetUrl = state.sheetUrl;
    if (!sheetId) {
      const created = await createSpreadsheet(sheetsApi);
      sheetId = created.sheetId;
      sheetUrl = created.sheetUrl;
      store.setGoogleSheetsState({ sheetId, sheetUrl });
    }

    const analytics = store.getAnalyticsData();
    const remaining = [...dirtyTabs];
    for (const tab of dirtyTabs) {
      await writeTab(sheetsApi, sheetId, tab, rowsForTab(tab, analytics));
      remaining.splice(remaining.indexOf(tab), 1);
      store.setGoogleSheetsState({ dirtyTabs: remaining });
    }
    store.setGoogleSheetsState({ lastSyncedAt: new Date().toISOString(), lastError: null });
  } catch (err) {
    store.setGoogleSheetsState({ lastError: err.message || String(err) });
    throw err;
  }
}

function getStatus() {
  const state = getStore().getGoogleSheetsState();
  return {
    googleAuthConfigured: isConfigured(),
    connected: !!(state.refreshToken && state.sheetId),
    sheetUrl: state.sheetUrl || null,
    lastSyncedAt: state.lastSyncedAt || null,
    lastError: state.lastError || null,
    pending: (state.dirtyTabs || []).length > 0,
  };
}

function disconnect() {
  getStore().setGoogleSheetsState({
    refreshToken: null,
    sheetId: null,
    sheetUrl: null,
    dirtyTabs: [],
    lastSyncedAt: null,
    lastError: null,
  });
}

function startBackgroundSync() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushNow().catch(() => {});
  }, SYNC_INTERVAL_MS);
  flushNow().catch(() => {});
}

module.exports = {
  getScopes,
  isConfigured,
  handleOwnerLogin,
  markDirtyAll,
  flushNow,
  getStatus,
  disconnect,
  startBackgroundSync,
};
