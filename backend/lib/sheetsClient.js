// Low-level Google Sheets access. The Sheet is this app's database (not a
// mirror of local files), and which Sheet/credentials to use is the owner's
// own runtime choice (see controlSheet.js) rather than something fixed at
// deploy time — so, unlike GOOGLE_CLIENT_ID/SECRET (the app's own OAuth
// client identity, which never changes), the sheet ID and refresh token
// are read fresh from that connection instead of from env vars.
const { google } = require("googleapis");
const controlSheet = require("./controlSheet");

let cached = null; // { refreshToken, sheetId, sheetsApi }
let cachedGidByTab = null;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}. See .env.example.`);
  return value;
}

async function getConnectionOrThrow() {
  const conn = await controlSheet.getConnection();
  if (!conn || !conn.sheetId || !conn.refreshToken) {
    throw new Error("No Google Sheet is connected yet. Connect one from Settings.");
  }
  return conn;
}

async function getSheetId() {
  const conn = await getConnectionOrThrow();
  return conn.sheetId;
}

async function getSheetsApi() {
  const conn = await getConnectionOrThrow();
  if (cached && cached.refreshToken === conn.refreshToken && cached.sheetId === conn.sheetId) {
    return cached.sheetsApi;
  }
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: conn.refreshToken });
  const sheetsApi = google.sheets({ version: "v4", auth: oauth2Client }).spreadsheets;
  cached = { refreshToken: conn.refreshToken, sheetId: conn.sheetId, sheetsApi };
  cachedGidByTab = null; // a different sheet means different tab gids
  return sheetsApi;
}

// 1-indexed column number -> letter (1 -> A, 26 -> Z, 27 -> AA, ...).
function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function getTabGid(tabName) {
  if (cachedGidByTab && cachedGidByTab[tabName] != null) return cachedGidByTab[tabName];
  const meta = await (await getSheetsApi()).get({ spreadsheetId: await getSheetId() });
  cachedGidByTab = {};
  for (const s of meta.data.sheets) cachedGidByTab[s.properties.title] = s.properties.sheetId;
  return cachedGidByTab[tabName];
}

// Creates the tab with a header row if it doesn't already exist. Safe to
// call on every cold start — a no-op once the tab is there.
async function ensureTab(tabName, headers) {
  const sheetsApi = await getSheetsApi();
  const sheetId = await getSheetId();
  const meta = await sheetsApi.get({ spreadsheetId: sheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === tabName);
  if (existing) {
    cachedGidByTab = cachedGidByTab || {};
    cachedGidByTab[tabName] = existing.properties.sheetId;
    return;
  }
  const res = await sheetsApi.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  cachedGidByTab = cachedGidByTab || {};
  cachedGidByTab[tabName] = res.data.replies[0].addSheet.properties.sheetId;
  await sheetsApi.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers] },
  });
}

// Every row comes back tagged with its real sheet row number (__row) so a
// later update/delete can target it directly.
async function getRows(tabName, headers) {
  const lastCol = colLetter(headers.length);
  const res = await (await getSheetsApi()).values.get({
    spreadsheetId: await getSheetId(),
    range: `${tabName}!A2:${lastCol}`,
  });
  const values = res.data.values || [];
  return values
    .map((row, i) => {
      const obj = { __row: i + 2 };
      headers.forEach((h, idx) => {
        obj[h] = row[idx] === undefined ? "" : row[idx];
      });
      return obj;
    })
    .filter((obj) => obj[headers[0]] !== "");
}

async function appendRow(tabName, headers, obj) {
  const row = headers.map((h) => (obj[h] === undefined || obj[h] === null ? "" : obj[h]));
  await (await getSheetsApi()).values.append({
    spreadsheetId: await getSheetId(),
    range: `${tabName}!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function updateRow(tabName, headers, rowNumber, obj) {
  const row = headers.map((h) => (obj[h] === undefined || obj[h] === null ? "" : obj[h]));
  const lastCol = colLetter(headers.length);
  await (await getSheetsApi()).values.update({
    spreadsheetId: await getSheetId(),
    range: `${tabName}!A${rowNumber}:${lastCol}${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

async function deleteRow(tabName, rowNumber) {
  const gid = await getTabGid(tabName);
  await (await getSheetsApi()).batchUpdate({
    spreadsheetId: await getSheetId(),
    requestBody: {
      requests: [{ deleteDimension: { range: { sheetId: gid, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber } } }],
    },
  });
}

function toBool(v) {
  return v === true || v === "TRUE" || v === "true";
}

module.exports = { getSheetsApi, getSheetId, ensureTab, getRows, appendRow, updateRow, deleteRow, toBool };
