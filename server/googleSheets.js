const { google } = require('googleapis');
const { SPREADSHEET_ID, HEADER_ROW } = require('./config');
const { parseSheetRows, isExcludedSheet } = require('./parse');

function isConfigured() {
  return Boolean(
    SPREADSHEET_ID &&
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      process.env.GOOGLE_PRIVATE_KEY
  );
}

function normalizePrivateKey(raw) {
  let key = raw.trim();

  // Strip a single pair of wrapping quotes if the whole value got copied
  // including the quotes from the JSON file (very common mistake).
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }

  // Normalize every newline style we might have ended up with: literal
  // \r\n or \n sequences (two characters, from copy/pasting the raw JSON
  // text) as well as actual CRLF line breaks.
  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');

  if (!key.includes('-----BEGIN PRIVATE KEY-----') || !key.includes('-----END PRIVATE KEY-----')) {
    throw new Error(
      'GOOGLE_PRIVATE_KEY does not look like a valid PEM key after normalization. ' +
        'Copy the private_key value from your service account JSON file exactly, ' +
        'without the surrounding double quotes from the JSON file itself.'
    );
  }

  return key;
}

function getAuth() {
  const privateKey = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
}

/**
 * Fetches every tab in the spreadsheet and returns the parsed office list.
 * Uses a single batchGet so it costs one API call regardless of tab count.
 */
async function fetchLiveData() {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetNames = meta.data.sheets
    .map((s) => s.properties.title)
    .filter((name) => !isExcludedSheet(name));

  // A1:Z is enough to cover every column we care about; row 4 onward is data.
  const ranges = sheetNames.map((name) => `'${name}'!A${HEADER_ROW + 1}:Z1000`);

  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges
  });

  const offices = res.data.valueRanges.map((vr, i) =>
    parseSheetRows(sheetNames[i], vr.values || [])
  );

  return offices;
}

module.exports = { fetchLiveData, isConfigured };
