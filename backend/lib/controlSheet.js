// Which Google account/Sheet the owner has connected as the business-data
// store is a runtime choice made from the dashboard, not something fixed at
// deploy time — but it can't live inside the Sheet it's pointing to (we
// don't know which Sheet that is until after this is read). So it lives in
// a small, separate "control" Sheet instead: the SAME static
// GOOGLE_SHEET_ID/GOOGLE_REFRESH_TOKEN this app already required before this
// feature existed, reused exactly as-is — deliberately a completely
// separate, static Google Sheets connection from backend/lib/sheetsClient.js
// (which is dynamic), so resolving "which Sheet is the business data Sheet"
// never depends on already knowing which Sheet is the business data Sheet.
// See docs/TRD.md §7b.
const { google } = require("googleapis");

const TAB = "Connection";
const HEADERS = ["key", "value"];
const CONNECTION_KEY = "activeSheetConnection";
const CACHE_TTL_MS = 5000;

let cachedApi = null;
let cachedConnection; // undefined = not cached yet; null = cached "not connected"
let cachedAt = 0;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}. See .env.example.`);
  return value;
}

function getControlSheetId() {
  return requireEnv("GOOGLE_SHEET_ID");
}

function getApi() {
  if (cachedApi) return cachedApi;
  const oauth2Client = new google.auth.OAuth2(requireEnv("GOOGLE_CLIENT_ID"), requireEnv("GOOGLE_CLIENT_SECRET"));
  oauth2Client.setCredentials({ refresh_token: requireEnv("GOOGLE_REFRESH_TOKEN") });
  cachedApi = google.sheets({ version: "v4", auth: oauth2Client }).spreadsheets;
  return cachedApi;
}

async function ensureTab() {
  const api = getApi();
  const sheetId = getControlSheetId();
  const meta = await api.get({ spreadsheetId: sheetId });
  if (meta.data.sheets.some((s) => s.properties.title === TAB)) return;
  await api.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
  });
  await api.values.update({
    spreadsheetId: sheetId,
    range: `${TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
}

async function readRow() {
  await ensureTab();
  const api = getApi();
  const res = await api.values.get({ spreadsheetId: getControlSheetId(), range: `${TAB}!A2:B` });
  const rows = res.data.values || [];
  const idx = rows.findIndex((r) => r[0] === CONNECTION_KEY);
  return idx === -1 ? null : { rowNumber: idx + 2, value: rows[idx][1] };
}

async function getConnection() {
  const now = Date.now();
  if (cachedConnection !== undefined && now - cachedAt < CACHE_TTL_MS) return cachedConnection;
  const found = await readRow();
  try {
    cachedConnection = found ? JSON.parse(found.value) : null;
  } catch (_) {
    cachedConnection = null;
  }
  cachedAt = now;
  return cachedConnection;
}

async function isConnected() {
  const conn = await getConnection();
  return !!(conn && conn.sheetId && conn.refreshToken);
}

async function setConnection({ email, sheetId, refreshToken }) {
  const value = JSON.stringify({ email, sheetId, refreshToken, connectedAt: new Date().toISOString() });
  const api = getApi();
  const found = await readRow();
  if (found) {
    await api.values.update({
      spreadsheetId: getControlSheetId(),
      range: `${TAB}!A${found.rowNumber}:B${found.rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [[CONNECTION_KEY, value]] },
    });
  } else {
    await api.values.append({
      spreadsheetId: getControlSheetId(),
      range: `${TAB}!A:A`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[CONNECTION_KEY, value]] },
    });
  }
  cachedConnection = JSON.parse(value);
  cachedAt = Date.now();
}

module.exports = { getConnection, isConnected, setConnection };
