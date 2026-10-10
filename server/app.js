const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const auth = require('./auth');
const dataStore = require('./dataStore');

const app = express();

app.use(express.json());
app.use(cookieParser());

// A stable identifier for a single budget line, used to let the frontend
// select specific line items within a category (e.g. from a checklist).
function itemKey(row) {
  return `${row.code || ''}|${row.description || ''}`;
}

function parseItemKeys(itemsParam) {
  if (!itemsParam) return null;
  return new Set(
    String(itemsParam)
      .split(',')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s))
  );
}

// ---- Auth routes (public) ----
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.get('/api/session', auth.sessionInfo);

// ---- Everything below requires a logged-in session ----
app.use('/api', auth.requireAuth);

app.get('/api/meta', (req, res) => {
  res.json(dataStore.getMeta());
});

app.get('/api/offices', async (req, res) => {
  const { forceRefresh } = req.query;
  const { offices, source, fetchedAt, error } = await dataStore.getData({
    forceRefresh: forceRefresh === '1'
  });
  res.json({
    source,
    fetchedAt,
    error,
    offices: offices.map((o) => ({ id: o.id, name: o.name, type: o.type, rowCount: o.rows.length }))
  });
});

// GET /api/data?offices=east,korangi&category=Total%20operating%20expenses&search=driver&items=key1,key2
app.get('/api/data', async (req, res) => {
  const { offices: officesParam, category, search, items: itemsParam } = req.query;
  const { offices, source, fetchedAt, error } = await dataStore.getData({});

  const wantedIds = officesParam ? String(officesParam).split(',').filter(Boolean) : null;
  const searchTerm = search ? String(search).toLowerCase() : null;
  const wantedItemKeys = parseItemKeys(itemsParam);

  const result = offices
    .filter((o) => !wantedIds || wantedIds.includes(o.id))
    .map((o) => {
      let rows = o.rows;
      if (category) rows = rows.filter((r) => r.category === category);
      if (wantedItemKeys) rows = rows.filter((r) => wantedItemKeys.has(itemKey(r)));
      if (searchTerm) {
        rows = rows.filter(
          (r) =>
            (r.description && r.description.toLowerCase().includes(searchTerm)) ||
            (r.code && String(r.code).toLowerCase().includes(searchTerm))
        );
      }
      return { id: o.id, name: o.name, type: o.type, rows };
    });

  res.json({ source, fetchedAt, error, offices: result });
});

// GET /api/compare?offices=east,korangi&metric=proposedBE2026_27&category=...&items=key1,key2
// Returns one summed total per office for the given numeric metric - built for
// the comparison chart / table across multiple selected offices.
app.get('/api/compare', async (req, res) => {
  const { offices: officesParam, metric, category, items: itemsParam } = req.query;
  if (!metric) return res.status(400).json({ ok: false, error: 'metric is required' });

  const { offices, source, fetchedAt, error } = await dataStore.getData({});
  const wantedIds = officesParam ? String(officesParam).split(',').filter(Boolean) : null;
  const wantedItemKeys = parseItemKeys(itemsParam);

  const result = offices
    .filter((o) => !wantedIds || wantedIds.includes(o.id))
    .map((o) => {
      let rows = category ? o.rows.filter((r) => r.category === category) : o.rows;
      if (wantedItemKeys) rows = rows.filter((r) => wantedItemKeys.has(itemKey(r)));
      const total = rows.reduce((sum, r) => sum + (typeof r[metric] === 'number' ? r[metric] : 0), 0);
      return { id: o.id, name: o.name, type: o.type, total };
    });

  res.json({ source, fetchedAt, error, metric, category: category || null, results: result });
});

// ---- Static frontend ----
// On Netlify this is served directly from the CDN (publish = "public") and
// never actually reaches this app, but keeping it here means `npm start`
// still serves the whole site from one process for local dev in VS Code.
app.use(express.static(path.join(__dirname, '..', 'public')));

module.exports = app;
