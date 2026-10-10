(function () {
  const DEFAULT_VISIBLE_COLUMNS = [
    'be2025_26',
    'totalReleases',
    'expenditure',
    'proposedBE2026_27',
    'variationOverBE2'
  ];

  const CHANGE_STAT_KEY = '_changePct';
  const DEFAULT_VISIBLE_STATS = ['be2025_26', 'expenditure', 'proposedBE2026_27', CHANGE_STAT_KEY];

  const state = {
    meta: { columns: [], categories: [] },
    officeList: [], // [{id,name,type,rowCount}]
    selectedOffices: new Set(),
    selectedCategory: '', // '' = all categories
    selectedItems: new Set(), // item keys within the selected category; empty = all items
    itemOptions: [], // [{key, code, description}] available in the current category
    itemSearch: '',
    officeFilter: '',
    visibleColumns: new Set(DEFAULT_VISIBLE_COLUMNS),
    visibleStats: new Set(DEFAULT_VISIBLE_STATS),
    view: 'browse',
    compareMetric: 'proposedBE2026_27',
    chart: null
  };

  const GROUP_LABELS = { headquarters: 'Headquarters', summary: 'Summaries', regional: 'Regional Offices' };
  const GROUP_ORDER = ['headquarters', 'summary', 'regional'];

  const el = (id) => document.getElementById(id);

  function itemKey(row) {
    return `${row.code || ''}|${row.description || ''}`;
  }

  function fmt(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return Math.round(n).toLocaleString('en-PK');
  }

  function fmtPct(n) {
    if (n === null || n === undefined || Number.isNaN(n) || !isFinite(n)) return '—';
    return `${n.toFixed(1)}%`;
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (res.status === 401) {
      window.location.href = '/';
      throw new Error('Not authenticated');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // Numeric columns that make sense to sum up (excludes BPS/No. of Posts,
  // which config.js already leaves out of the numeric list since they're
  // grades/counts, not amounts).
  function numericColumns() {
    return state.meta.columns.filter((c) => c.numeric);
  }

  // ---------------- Boot ----------------

  async function boot() {
    const session = await api('/api/session');
    if (!session.authenticated) {
      window.location.href = '/';
      return;
    }
    el('user-name').textContent = session.user.displayName || session.user.username;

    const meta = await api('/api/meta');
    state.meta = meta;
    renderCategoryList();
    populateMetricSelect();
    renderColumnPicker();
    renderStatPicker();

    await loadOffices();

    attachEvents();
    render();
  }

  async function loadOffices(forceRefresh) {
    const data = await api(`/api/offices${forceRefresh ? '?forceRefresh=1' : ''}`);
    state.officeList = data.offices;
    updateSourceStatus(data);
    renderOfficeGroups();
  }

  function updateSourceStatus(data) {
    const elStatus = el('source-status');
    const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString() : '';
    if (data.source === 'google-sheets') {
      elStatus.textContent = `Live from Google Sheets · updated ${when}`;
      elStatus.className = 'source-status live';
    } else if (data.source === 'sample-fallback') {
      elStatus.textContent = `Google Sheets unavailable — showing bundled sample data (${when})`;
      elStatus.className = 'source-status stale';
    } else if (data.source === 'error') {
      elStatus.textContent = `Could not load data — see the error below`;
      elStatus.className = 'source-status stale';
    } else {
      elStatus.textContent = `Demo mode: bundled sample data (add Google credentials in .env for live data)`;
      elStatus.className = 'source-status demo';
    }
    const banner = el('error-banner');
    if (data.error) {
      banner.textContent = data.error;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  // ---------------- Sidebar: offices ----------------

  function renderOfficeGroups() {
    const container = el('office-groups');
    const filterText = state.officeFilter.toLowerCase();
    const grouped = {};
    for (const o of state.officeList) {
      if (filterText && !o.name.toLowerCase().includes(filterText)) continue;
      (grouped[o.type] = grouped[o.type] || []).push(o);
    }

    container.innerHTML = '';
    for (const type of GROUP_ORDER) {
      const list = grouped[type];
      if (!list || !list.length) continue;
      const labelEl = document.createElement('div');
      labelEl.className = 'office-group-label';
      labelEl.textContent = GROUP_LABELS[type];
      container.appendChild(labelEl);

      for (const o of list) {
        const row = document.createElement('label');
        row.className = 'office-item';
        row.innerHTML = `
          <input type="checkbox" value="${o.id}" ${state.selectedOffices.has(o.id) ? 'checked' : ''} />
          <span>${o.name}</span>
          <span class="rowcount">${o.rowCount}</span>
        `;
        row.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) state.selectedOffices.add(o.id);
          else state.selectedOffices.delete(o.id);
          render();
        });
        container.appendChild(row);
      }
    }
    if (!container.children.length) {
      container.innerHTML = '<p class="muted">No offices match.</p>';
    }
  }

  // ---------------- Sidebar: categories ----------------

  function renderCategoryList() {
    const container = el('category-list');
    container.innerHTML = '';

    const allRow = document.createElement('label');
    allRow.className = 'category-item';
    allRow.innerHTML = `<input type="radio" name="category" value="" checked /> <span>All categories</span>`;
    container.appendChild(allRow);

    for (const cat of state.meta.categories) {
      const row = document.createElement('label');
      row.className = 'category-item';
      row.innerHTML = `<input type="radio" name="category" value="${cat}" /> <span>${cat}</span>`;
      container.appendChild(row);
    }

    container.querySelectorAll('input[name="category"]').forEach((input) => {
      input.addEventListener('change', async (e) => {
        state.selectedCategory = e.target.value;
        // A new heading means a fresh item selection - "all items" by default,
        // since items only make sense within a single category at a time.
        state.selectedItems.clear();
        closeDropdown('item-picker');
        await refreshItemOptions();
        render();
      });
    });
  }

  // ---------------- Item picker (checklist of line items within one category) ----------------

  async function refreshItemOptions() {
    const wrap = el('item-picker');
    if (!state.selectedCategory) {
      wrap.hidden = true;
      state.itemOptions = [];
      return;
    }
    wrap.hidden = false;

    // Pull the full item list for this category across ALL offices (not just
    // the ones currently selected), so the checklist doesn't change shape
    // depending on which offices happen to be picked.
    const params = new URLSearchParams();
    params.set('category', state.selectedCategory);
    const data = await api(`/api/data?${params.toString()}`);

    const seen = new Map();
    for (const office of data.offices) {
      for (const r of office.rows) {
        if (!r.description) continue;
        const key = itemKey(r);
        if (!seen.has(key)) seen.set(key, { key, code: r.code, description: r.description });
      }
    }
    state.itemOptions = Array.from(seen.values()).sort((a, b) =>
      (a.description || '').localeCompare(b.description || '')
    );
    renderItemPickerList();
    updateItemPickerToggleLabel();
  }

  function renderItemPickerList() {
    const list = el('item-picker-list');
    if (!state.itemOptions.length) {
      list.innerHTML = '<p class="muted">No items in this category.</p>';
      return;
    }
    list.innerHTML = '';
    for (const item of state.itemOptions) {
      const label = document.createElement('label');
      const checked = state.selectedItems.has(item.key);
      label.innerHTML = `
        <input type="checkbox" value="${escapeAttr(item.key)}" ${checked ? 'checked' : ''} />
        <span>${item.description}</span>
      `;
      label.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) state.selectedItems.add(item.key);
        else state.selectedItems.delete(item.key);
        updateItemPickerToggleLabel();
        render();
      });
      list.appendChild(label);
    }
  }

  function updateItemPickerToggleLabel() {
    const labelEl = el('item-picker-toggle-label');
    const n = state.selectedItems.size;
    labelEl.textContent = n === 0 ? 'All items' : `${n} item${n === 1 ? '' : 's'} selected`;
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }

  function populateMetricSelect() {
    const select = el('metric-select');
    select.innerHTML = '';
    for (const col of numericColumns()) {
      const opt = document.createElement('option');
      opt.value = col.key;
      opt.textContent = col.label;
      select.appendChild(opt);
    }
    select.value = state.compareMetric;
    select.addEventListener('change', () => {
      state.compareMetric = select.value;
      renderCompareView();
    });
  }

  // ---------------- Column picker (which numeric/detail columns to show in tables) ----------------

  function pickableColumns() {
    return state.meta.columns.filter(
      (c) => c.key !== 'code' && c.key !== 'description' && c.key !== 'majorObject' && c.key !== 'minorObject'
    );
  }

  function renderColumnPicker() {
    const list = el('column-picker-list');
    list.innerHTML = '';
    for (const col of pickableColumns()) {
      const label = document.createElement('label');
      const checked = state.visibleColumns.has(col.key);
      label.innerHTML = `
        <input type="checkbox" value="${col.key}" ${checked ? 'checked' : ''} />
        <span>${col.label}</span>
      `;
      label.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) state.visibleColumns.add(col.key);
        else state.visibleColumns.delete(col.key);
        updateColumnPickerToggleLabel();
        render();
      });
      list.appendChild(label);
    }
    updateColumnPickerToggleLabel();
  }

  function updateColumnPickerToggleLabel() {
    const labelEl = el('column-picker-toggle-label');
    labelEl.textContent = `${state.visibleColumns.size} column${state.visibleColumns.size === 1 ? '' : 's'} shown`;
  }

  // ---------------- Stat picker (which totals to show as summary cards) ----------------

  function statOptions() {
    // The special % change card, plus every summable numeric column.
    return [
      { key: CHANGE_STAT_KEY, label: 'Change vs BE 2025-26 (%)' },
      ...numericColumns().map((c) => ({ key: c.key, label: c.label }))
    ];
  }

  function renderStatPicker() {
    const list = el('stat-picker-list');
    list.innerHTML = '';
    for (const opt of statOptions()) {
      const label = document.createElement('label');
      const checked = state.visibleStats.has(opt.key);
      label.innerHTML = `
        <input type="checkbox" value="${opt.key}" ${checked ? 'checked' : ''} />
        <span>${opt.label}</span>
      `;
      label.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) state.visibleStats.add(opt.key);
        else state.visibleStats.delete(opt.key);
        updateStatPickerToggleLabel();
        render();
      });
      list.appendChild(label);
    }
    updateStatPickerToggleLabel();
  }

  function updateStatPickerToggleLabel() {
    const labelEl = el('stat-picker-toggle-label');
    const n = state.visibleStats.size;
    labelEl.textContent = `${n} total${n === 1 ? '' : 's'} shown`;
  }

  // ---------------- Generic dropdown open/close ----------------
  // Panels are positioned with `position: fixed`, computed here from the
  // toggle button's on-screen location, so they render relative to the
  // viewport rather than to the sidebar. That means the sidebar's own
  // scroll area (overflow-y: auto) can never clip the panel or its Done
  // button - which is what made dropdowns feel like they wouldn't close.

  const dropdownRegistry = {}; // wrapId -> { toggle, panel }

  function setupDropdown(wrapId, toggleId, panelId, doneId) {
    const toggle = el(toggleId);
    const panel = el(panelId);
    dropdownRegistry[wrapId] = { toggle, panel };

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !panel.hidden;
      closeAllDropdowns();
      if (!isOpen) openDropdownPanel(toggle, panel);
    });
    if (doneId) {
      el(doneId).addEventListener('click', (e) => {
        e.stopPropagation();
        closeDropdown(wrapId);
      });
    }
    panel.addEventListener('click', (e) => e.stopPropagation());
  }

  function openDropdownPanel(toggle, panel) {
    const rect = toggle.getBoundingClientRect();
    const width = Math.max(rect.width, 260);
    let left = rect.left;
    // Keep the panel on-screen even if its toggle sits near the right edge.
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;

    panel.style.position = 'fixed';
    panel.style.top = `${rect.bottom + 6}px`;
    panel.style.left = `${Math.max(12, left)}px`;
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.max(160, Math.min(360, window.innerHeight - rect.bottom - 20))}px`;
    panel.hidden = false;
    toggle.classList.add('open');
  }

  function closeDropdown(wrapId) {
    const entry = dropdownRegistry[wrapId];
    if (!entry) return;
    entry.panel.hidden = true;
    entry.toggle.classList.remove('open');
  }

  function closeAllDropdowns() {
    Object.keys(dropdownRegistry).forEach(closeDropdown);
  }

  // ---------------- Events ----------------

  function attachEvents() {
    el('office-search').addEventListener('input', (e) => {
      state.officeFilter = e.target.value;
      renderOfficeGroups();
    });

    el('item-search').addEventListener('input', debounce((e) => {
      state.itemSearch = e.target.value;
      render();
    }, 300));

    el('select-none').addEventListener('click', () => {
      state.selectedOffices.clear();
      renderOfficeGroups();
      render();
    });

    el('refresh-btn').addEventListener('click', async () => {
      el('refresh-btn').textContent = '⟳ Refreshing…';
      await loadOffices(true);
      el('refresh-btn').textContent = '⟳ Refresh data';
      render();
    });

    el('logout-btn').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' });
      window.location.href = '/';
    });

    document.querySelectorAll('.view-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.view-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.view = btn.dataset.view;
        el('browse-view').hidden = state.view !== 'browse';
        el('compare-view').hidden = state.view !== 'compare';
        render();
      });
    });

    // Item picker dropdown
    setupDropdown('item-picker', 'item-picker-toggle', 'item-picker-panel', 'item-picker-done');
    el('item-select-all').addEventListener('click', () => {
      state.selectedItems = new Set(state.itemOptions.map((i) => i.key));
      renderItemPickerList();
      updateItemPickerToggleLabel();
      render();
    });
    el('item-select-clear').addEventListener('click', () => {
      state.selectedItems.clear();
      renderItemPickerList();
      updateItemPickerToggleLabel();
      render();
    });

    // Column picker dropdown
    setupDropdown('column-picker', 'column-picker-toggle', 'column-picker-panel', 'column-picker-done');
    el('column-select-all').addEventListener('click', () => {
      state.visibleColumns = new Set(pickableColumns().map((c) => c.key));
      renderColumnPicker();
      render();
    });
    el('column-select-default').addEventListener('click', () => {
      state.visibleColumns = new Set(DEFAULT_VISIBLE_COLUMNS);
      renderColumnPicker();
      render();
    });

    // Stat picker dropdown
    setupDropdown('stat-picker', 'stat-picker-toggle', 'stat-picker-panel', 'stat-picker-done');
    el('stat-select-all').addEventListener('click', () => {
      state.visibleStats = new Set(statOptions().map((s) => s.key));
      renderStatPicker();
      render();
    });
    el('stat-select-default').addEventListener('click', () => {
      state.visibleStats = new Set(DEFAULT_VISIBLE_STATS);
      renderStatPicker();
      render();
    });

    // Clicking anywhere outside a dropdown panel closes it.
    document.addEventListener('click', () => closeAllDropdowns());
    // Keep an open panel from sitting in a stale position if the window is resized.
    window.addEventListener('resize', () => closeAllDropdowns());
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // ---------------- Render dispatch ----------------

  function render() {
    if (state.view === 'browse') renderBrowseView();
    else renderCompareView();
  }

  function selectedItemsParam() {
    if (!state.selectedItems.size) return null;
    return Array.from(state.selectedItems).map((k) => encodeURIComponent(k)).join(',');
  }

  // A "summary" sheet's own numbers already add up every regional office
  // (and, depending on which summary, Headquarters too) - so if one of
  // those is selected at the same time as the offices it rolls up, the
  // Totals cards would be adding that money in twice. We can't guess which
  // one you actually meant to keep, so we just warn clearly instead of
  // silently "fixing" your selection for you.
  function checkDoubleCountRisk() {
    const selected = state.officeList.filter((o) => state.selectedOffices.has(o.id));
    const hasSummary = selected.some((o) => o.type === 'summary');
    const hasNonSummary = selected.some((o) => o.type === 'regional' || o.type === 'headquarters');
    return hasSummary && hasNonSummary;
  }

  function renderDoubleCountWarning() {
    const banner = el('double-count-warning');
    if (checkDoubleCountRisk()) {
      banner.textContent =
        'Heads up: your selection includes a Summary sheet together with individual office(s) it already totals. ' +
        'The figures below will count that spending twice. For an accurate total, select either the summary alone ' +
        'or the individual offices alone, not both.';
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  // ---------------- Browse view ----------------

  async function renderBrowseView() {
    const container = el('office-tables');
    renderDoubleCountWarning();
    if (!state.selectedOffices.size) {
      container.innerHTML = '<p class="muted">Select one or more offices from the sidebar to see their budget lines.</p>';
      el('stat-row').innerHTML = '';
      return;
    }

    const params = new URLSearchParams();
    params.set('offices', Array.from(state.selectedOffices).join(','));
    if (state.selectedCategory) params.set('category', state.selectedCategory);
    if (state.itemSearch) params.set('search', state.itemSearch);
    const itemsParam = selectedItemsParam();
    if (itemsParam) params.set('items', itemsParam);

    const data = await api(`/api/data?${params.toString()}`);
    renderStats(data.offices);

    const columns = buildActiveColumns();

    container.innerHTML = '';
    for (const office of data.offices) {
      const card = document.createElement('div');
      card.className = 'office-table-card';
      card.innerHTML = `
        <h3>${office.name} <span class="badge">${office.rows.length} line item${office.rows.length === 1 ? '' : 's'}</span></h3>
        <div class="table-scroll">${buildLedgerTable(office.rows, columns)}</div>
      `;
      container.appendChild(card);
    }
    if (!data.offices.length) {
      container.innerHTML = '<p class="muted">No matching line items.</p>';
    }
  }

  // Code + Description are always shown first and fixed; everything else is
  // whatever the person has checked in the Columns picker, in workbook order.
  function buildActiveColumns() {
    const cols = [
      { key: 'code', label: 'Code', cls: 'code' },
      { key: 'description', label: 'Description', cls: 'desc' }
    ];
    for (const c of state.meta.columns) {
      if (c.key === 'code' || c.key === 'description') continue;
      if (!state.visibleColumns.has(c.key)) continue;
      cols.push({ key: c.key, label: c.label, cls: c.numeric ? 'num' : 'code', money: c.numeric });
    }
    return cols;
  }

  function buildLedgerTable(rows, cols) {
    if (!rows.length) return '<p class="muted" style="padding:16px 18px;">No line items match the current filters.</p>';
    let html = '<table class="ledger"><thead><tr>';
    for (const c of cols) html += `<th>${c.label}</th>`;
    html += '</tr></thead><tbody>';
    for (const r of rows) {
      html += '<tr>';
      for (const c of cols) {
        const val = r[c.key];
        if (c.key === 'description') {
          html += `<td class="${c.cls}">${val || ''}</td>`;
        } else if (c.money) {
          html += `<td class="${c.cls}">${fmt(val)}</td>`;
        } else {
          html += `<td class="${c.cls}">${val || ''}</td>`;
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  // Builds whichever summary cards are currently checked in the stat picker,
  // in the same order they're listed there, totalled across exactly the
  // offices/category/items/search currently in effect (the `offices` param
  // here is already filtered that way by renderBrowseView).
  function renderStats(offices) {
    const container = el('stat-row');
    if (!state.visibleStats.size) {
      container.innerHTML = '<p class="muted">No totals selected — open "Totals shown" above to pick some.</p>';
      return;
    }

    const sums = {};
    for (const c of numericColumns()) sums[c.key] = 0;
    for (const o of offices) {
      for (const r of o.rows) {
        for (const c of numericColumns()) {
          sums[c.key] += r[c.key] || 0;
        }
      }
    }

    const cardsHtml = [];
    for (const opt of statOptions()) {
      if (!state.visibleStats.has(opt.key)) continue;
      if (opt.key === CHANGE_STAT_KEY) {
        const sumBE = sums.be2025_26 || 0;
        const sumProposed = sums.proposedBE2026_27 || 0;
        const change = sumBE ? ((sumProposed - sumBE) / sumBE) * 100 : null;
        cardsHtml.push(`
          <div class="stat-card">
            <p class="label">${opt.label}</p>
            <p class="value ${change === null ? '' : change >= 0 ? 'good' : 'bad'}">${fmtPct(change)}</p>
          </div>
        `);
      } else {
        cardsHtml.push(`
          <div class="stat-card">
            <p class="label">${opt.label}</p>
            <p class="value">Rs ${fmt(sums[opt.key])}</p>
          </div>
        `);
      }
    }
    container.innerHTML = cardsHtml.join('');
  }

  // ---------------- Compare view ----------------

  async function renderCompareView() {
    renderDoubleCountWarning();
    if (!state.selectedOffices.size) {
      el('compare-table-wrap').innerHTML = '<p class="muted">Select two or more offices from the sidebar to compare them.</p>';
      if (state.chart) { state.chart.destroy(); state.chart = null; }
      return;
    }

    const itemsParam = selectedItemsParam();

    const params = new URLSearchParams();
    params.set('offices', Array.from(state.selectedOffices).join(','));
    params.set('metric', state.compareMetric);
    if (state.selectedCategory) params.set('category', state.selectedCategory);
    if (itemsParam) params.set('items', itemsParam);

    const compareData = await api(`/api/compare?${params.toString()}`);
    renderChart(compareData);

    // Pivot table: line items (rows) x offices (columns) for the selected metric.
    const dataParams = new URLSearchParams();
    dataParams.set('offices', Array.from(state.selectedOffices).join(','));
    if (state.selectedCategory) dataParams.set('category', state.selectedCategory);
    if (state.itemSearch) dataParams.set('search', state.itemSearch);
    if (itemsParam) dataParams.set('items', itemsParam);
    const detail = await api(`/api/data?${dataParams.toString()}`);
    renderPivotTable(detail.offices);
  }

  function renderChart(compareData) {
    const ctx = el('compare-chart').getContext('2d');
    const labels = compareData.results.map((r) => r.name);
    const values = compareData.results.map((r) => r.total);
    const metricLabel = (state.meta.columns.find((c) => c.key === state.compareMetric) || {}).label || state.compareMetric;

    if (state.chart) state.chart.destroy();
    state.chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: metricLabel,
          data: values,
          backgroundColor: '#c9a227',
          borderRadius: 3,
          maxBarThickness: 46
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, title: { display: false } },
        scales: {
          x: { ticks: { color: '#9fb0c5', font: { family: 'Inter' } }, grid: { display: false } },
          y: {
            ticks: {
              color: '#9fb0c5',
              font: { family: 'IBM Plex Mono' },
              callback: (v) => fmt(v)
            },
            grid: { color: 'rgba(159,176,197,0.12)' }
          }
        }
      }
    });
  }

  function renderPivotTable(offices) {
    const wrap = el('compare-table-wrap');
    if (offices.length < 2) {
      wrap.innerHTML = '<p class="muted">Select at least two offices to see a side-by-side line-item comparison.</p>';
      return;
    }

    // Key rows by code+description so the same budget line lines up across offices.
    const rowMap = new Map(); // key -> { code, description, values: { officeId: number } }
    for (const office of offices) {
      for (const r of office.rows) {
        const key = itemKey(r);
        if (!rowMap.has(key)) {
          rowMap.set(key, { code: r.code, description: r.description, values: {} });
        }
        rowMap.get(key).values[office.id] = r[state.compareMetric];
      }
    }

    const metricLabel = (state.meta.columns.find((c) => c.key === state.compareMetric) || {}).label || state.compareMetric;

    let html = `<div class="office-table-card"><h3>Line-item comparison <span class="badge">${metricLabel}</span></h3><div class="table-scroll"><table class="ledger"><thead><tr>`;
    html += `<th>Description</th>`;
    for (const o of offices) html += `<th>${o.name}</th>`;
    html += `</tr></thead><tbody>`;

    for (const { description, values } of rowMap.values()) {
      if (!description) continue;
      html += `<tr><td class="desc">${description}</td>`;
      for (const o of offices) {
        html += `<td class="num">${fmt(values[o.id])}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div></div>`;
    wrap.innerHTML = html;
  }

  boot().catch((err) => {
    console.error(err);
    const banner = el('error-banner');
    if (banner) {
      banner.textContent = err.message;
      banner.hidden = false;
    }
  });
})();
