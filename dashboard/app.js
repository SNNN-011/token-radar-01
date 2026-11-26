(function () {
  'use strict';

  var PAGE_SIZE = 12;

  var SORT_COLUMNS = [
    { key: 'rank', label: 'Rank', className: 'col-rank', numeric: false },
    { key: 'name', label: 'Protocol', className: 'col-name', numeric: false },
    { key: 'category', label: 'Category', className: 'col-category', numeric: false },
    { key: 'tvlUsd', label: 'TVL', className: 'col-tvl', numeric: true },
    { key: 'change7d', label: '7d', className: 'col-change', numeric: true },
    { key: 'impliedValueUsd', label: 'Implied cap', className: 'col-implied', numeric: true },
    { key: 'bandWidth', label: 'Empirical band', className: 'col-band', numeric: false },
    { key: 'peerCount', label: 'Peers', className: 'col-peers', numeric: true },
    { key: 'evidence', label: 'Evidence', className: 'col-evidence', numeric: false }
  ];

  var DEFAULT_DIRECTION = {
    rank: 'asc',
    name: 'asc',
    category: 'asc',
    tvlUsd: 'desc',
    change7d: 'desc',
    impliedValueUsd: 'desc',
    bandWidth: 'desc',
    peerCount: 'desc',
    evidence: 'asc'
  };

  var FLAG_LABELS = {
    'global-median-ratio': 'Global ratio baseline',
    'category-median-ratio': 'Category ratio baseline',
    'category-median-fallback': 'Category fallback',
    'category-partially-pooled': 'Partially pooled category',
    'category-unseen': 'Unseen category',
    'sparse-category': 'Sparse category',
    'category-adjustment-large': 'Large category adjustment',
    'tvl-below-fit-range': 'TVL below fit range',
    'tvl-above-fit-range': 'TVL above fit range',
    'missing-change-7d': 'Missing 7d change',
    'missing-listed-at': 'Missing listing date',
    'interval-wide': 'Wide interval',
    'small-calibration-sample': 'Small calibration sample'
  };

  var FARM_STATUS_LABELS = {
    'source-backed': 'Source-backed',
    'verify-terms': 'Verify terms',
    'research-only': 'Research only'
  };

  var state = {
    query: '',
    category: 'all',
    watchlistOnly: false,
    evidence: 'all',
    sortKey: 'rank',
    sortDir: 'asc',
    page: 1
  };

  var app = document.getElementById('app');
  var mastheadMeta = document.getElementById('masthead-meta');
  var footerSource = document.getElementById('footer-source');
  var announcer = document.getElementById('announcer');

  var data = null;
  var rows = [];
  var bandDomain = null;
  var ledger = null;
  var view = 'board';
  var lastBoardScroll = 0;
  var lastRenderedRoute = null;

  function create(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function append(parent) {
    for (var i = 1; i < arguments.length; i += 1) {
      var child = arguments[i];
      if (child !== null && child !== undefined) parent.appendChild(child);
    }
    return parent;
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function isPositiveNumber(value) {
    return isFiniteNumber(value) && value > 0;
  }

  function asText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function sentenceCase(value) {
    if (!value) return '';
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function flagLabel(flag) {
    return FLAG_LABELS[flag] || sentenceCase(String(flag).replace(/-/g, ' '));
  }

  function formatCompactUsd(value) {
    if (!isPositiveNumber(value)) return '—';
    if (value >= 1e12) return '$' + (value / 1e12).toFixed(value >= 1e13 ? 0 : 1) + 'T';
    if (value >= 1e9) return '$' + (value / 1e9).toFixed(value >= 1e10 ? 0 : 1) + 'B';
    if (value >= 1e6) return '$' + (value / 1e6).toFixed(value >= 1e7 ? 0 : 1) + 'M';
    if (value >= 1e3) return '$' + (value / 1e3).toFixed(value >= 1e4 ? 0 : 1) + 'K';
    return '$' + Math.round(value);
  }

  function formatFullUsd(value) {
    if (!isPositiveNumber(value)) return 'Not supplied';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0
      }).format(value);
    } catch (error) {
      return '$' + Math.round(value);
    }
  }

  function formatCount(value) {
    if (!isFiniteNumber(value)) return '—';
    return new Intl.NumberFormat('en-US').format(value);
  }

  function formatDecimal(value, digits) {
    if (!isFiniteNumber(value)) return '—';
    return value.toFixed(digits);
  }

  function formatCoverage(value) {
    if (!isFiniteNumber(value)) return '—';
    var percent = value <= 1 ? value * 100 : value;
    return Math.round(percent) + '%';
  }

  function percentLevel(value) {
    if (!isFiniteNumber(value)) return null;
    var percent = value <= 1 ? value * 100 : value;
    return Math.round(percent) + '%';
  }

  function formatChange(value) {
    if (!isFiniteNumber(value)) return '—';
    var sign = value > 0 ? '+' : '';
    return sign + value.toFixed(1) + '%';
  }

  function changeClass(value) {
    if (!isFiniteNumber(value) || value === 0) return 'change--flat';
    return value > 0 ? 'change--up' : 'change--down';
  }

  function formatMultiple(low, high) {
    if (!isPositiveNumber(low) || !isPositiveNumber(high) || high <= low) return null;
    var multiple = high / low;
    return (multiple >= 10 ? multiple.toFixed(1) : multiple.toFixed(2)) + '×';
  }

  function normalizeRow(raw) {
    var farm = null;
    if (raw && raw.farm && typeof raw.farm === 'object') {
      farm = {
        status: asText(raw.farm.status),
        steps: Array.isArray(raw.farm.steps)
          ? raw.farm.steps.filter(function (step) { return typeof step === 'string' && step.trim(); })
          : [],
        sources: Array.isArray(raw.farm.sources)
          ? raw.farm.sources.filter(function (source) { return typeof source === 'string' && source.trim(); })
          : []
      };
    }

    var peers = [];
    if (raw && Array.isArray(raw.peers)) {
      peers = raw.peers.filter(function (peer) {
        return peer && typeof peer === 'object' && typeof peer.slug === 'string' && peer.slug.trim();
      }).map(function (peer) {
        return {
          slug: peer.slug,
          tvlUsd: isPositiveNumber(peer.tvlUsd) ? peer.tvlUsd : null,
          marketCapUsd: isPositiveNumber(peer.marketCapUsd) ? peer.marketCapUsd : null
        };
      });
    }

    return {
      slug: raw.slug,
      name: asText(raw.name) || raw.slug,
      rank: isFiniteNumber(raw.rank) ? raw.rank : null,
      category: asText(raw.category) || null,
      chains: Array.isArray(raw.chains)
        ? raw.chains.filter(function (chain) { return typeof chain === 'string' && chain.trim(); })
        : [],
      tvlUsd: isPositiveNumber(raw.tvlUsd) ? raw.tvlUsd : null,
      change7d: isFiniteNumber(raw.change7d) ? raw.change7d : null,
      listedAt: asText(raw.listedAt) || null,
      watchlist: raw.watchlist === true,
      impliedValueUsd: isPositiveNumber(raw.impliedValueUsd) ? raw.impliedValueUsd : null,
      lowUsd: isPositiveNumber(raw.lowUsd) ? raw.lowUsd : null,
      highUsd: isPositiveNumber(raw.highUsd) ? raw.highUsd : null,
      peerCount: isFiniteNumber(raw.peerCount) ? raw.peerCount : null,
      peers: peers,
      flags: Array.isArray(raw.flags)
        ? raw.flags.filter(function (flag) { return typeof flag === 'string' && flag.trim(); })
        : [],
      tokenStatus: asText(raw.tokenStatus),
      farm: farm
    };
  }

  function normalizeCounts(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var keys = ['protocols', 'candidates', 'watchlist', 'peers', 'excluded'];
    var counts = {};
    var found = false;
    keys.forEach(function (key) {
      if (isFiniteNumber(raw[key])) {
        counts[key] = raw[key];
        found = true;
      }
    });
    return found ? counts : null;
  }

  function normalizeMetric(raw) {
    if (!raw || typeof raw !== 'object') {
      return { medianAbsLogError: null, coverage: null, mape: null };
    }
    return {
      medianAbsLogError: isFiniteNumber(raw.medianAbsLogError) ? raw.medianAbsLogError : null,
      coverage: isFiniteNumber(raw.coverage) ? raw.coverage : null,
      mape: isFiniteNumber(raw.medianAbsolutePercentageError)
        ? raw.medianAbsolutePercentageError
        : null
    };
  }

  function normalizeBenchmark(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      sampleN: isFiniteNumber(raw.sampleN) ? raw.sampleN : null,
      selected: normalizeMetric(raw.selected),
      global: normalizeMetric(raw.global),
      category: normalizeMetric(raw.category),
      intervalLevel: isFiniteNumber(raw.intervalLevel) ? raw.intervalLevel : null,
      label: asText(raw.label)
    };
  }

  function metricHasData(metric) {
    return metric && (
      isFiniteNumber(metric.medianAbsLogError) ||
      isFiniteNumber(metric.coverage) ||
      isFiniteNumber(metric.mape)
    );
  }

  function benchmarkHasData(benchmark) {
    return benchmark && (
      metricHasData(benchmark.selected) ||
      metricHasData(benchmark.category) ||
      metricHasData(benchmark.global)
    );
  }

  function readData() {
    var raw = globalThis.TOKEN_RADAR_DATA;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rows) || raw.rows.length === 0) {
      return null;
    }

    var usableRows = raw.rows.filter(function (row) {
      return row && typeof row === 'object' && typeof row.slug === 'string' && row.slug.trim();
    }).map(normalizeRow);

    if (usableRows.length === 0) return null;

    return {
      asOf: asText(raw.asOf),
      source: asText(raw.source),
      counts: normalizeCounts(raw.counts),
      benchmark: normalizeBenchmark(raw.benchmark),
      rows: usableRows
    };
  }

  function buildBandDomain(sourceRows) {
    var values = [];
    sourceRows.forEach(function (row) {
      if (isPositiveNumber(row.lowUsd)) values.push(row.lowUsd);
      if (isPositiveNumber(row.highUsd)) values.push(row.highUsd);
      if (isPositiveNumber(row.impliedValueUsd)) values.push(row.impliedValueUsd);
    });
    if (values.length < 2) return null;

    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    if (!isPositiveNumber(min) || !isPositiveNumber(max) || max <= min) return null;

    var logMin = Math.log10(min) - Math.log10(1.08);
    var logMax = Math.log10(max) + Math.log10(1.08);
    if (!isFinite(logMin) || !isFinite(logMax) || logMax <= logMin) return null;
    return { min: min, max: max, logMin: logMin, logMax: logMax };
  }

  function computeLocalDomain(values) {
    var usable = values.filter(isPositiveNumber);
    if (usable.length < 2) return null;
    var min = Math.min.apply(null, usable);
    var max = Math.max.apply(null, usable);
    if (max <= min) {
      min = min / 1.15;
      max = max * 1.15;
    }
    var logMin = Math.log10(min);
    var logMax = Math.log10(max);
    if (!isFinite(logMin) || !isFinite(logMax) || logMax <= logMin) return null;
    return { logMin: logMin, logMax: logMax };
  }

  function bandPosition(value, domain) {
    if (!isPositiveNumber(value) || !domain) return null;
    var percent = ((Math.log10(value) - domain.logMin) / (domain.logMax - domain.logMin)) * 100;
    return Math.max(0, Math.min(100, percent));
  }

  function countsText() {
    if (!data.counts) return '';
    var labels = [
      ['protocols', 'protocols'],
      ['candidates', 'candidates'],
      ['watchlist', 'watched'],
      ['peers', 'peers'],
      ['excluded', 'excluded']
    ];
    return labels.filter(function (pair) {
      return isFiniteNumber(data.counts[pair[0]]);
    }).map(function (pair) {
      return formatCount(data.counts[pair[0]]) + ' ' + pair[1];
    }).join(' · ');
  }

  function updateChrome() {
    if (!data) {
      mastheadMeta.textContent = 'No snapshot loaded';
      return;
    }
    var parts = [];
    parts.push(data.asOf ? 'Snapshot ' + data.asOf : 'Snapshot date not supplied');
    if (data.counts && isFiniteNumber(data.counts.protocols)) {
      parts.push(formatCount(data.counts.protocols) + ' protocols');
    }
    mastheadMeta.textContent = parts.join(' · ');
    footerSource.textContent = data.source
      ? 'Source: ' + data.source
      : 'No source string was supplied with this snapshot.';
  }

  function renderNoData(message) {
    view = 'board';
    mastheadMeta.textContent = 'No snapshot loaded';
    footerSource.textContent = 'The generated snapshot source will appear here when it is available.';

    var section = create('section', 'no-data');
    var title = create('h1', null, 'No snapshot loaded');
    title.id = 'page-title';
    title.tabIndex = -1;
    section.appendChild(title);

    if (message) {
      section.appendChild(create('p', null, message));
    } else {
      section.appendChild(create('p', null,
        'This local ledger reads a generated ../data.js file that assigns globalThis.TOKEN_RADAR_DATA. That file is not present in this build, so no valuation rows are shown.'));
    }

    var hint = create('p', null, 'Generate the snapshot beside this dashboard folder, then reload the page.');
    section.appendChild(hint);
    app.replaceChildren(section);
    announcer.textContent = 'No snapshot data available.';
  }

  function buildBenchMissing(sampleN, intervalLevel, reasonText) {
    var section = create('aside', 'bench bench-missing');
    section.setAttribute('aria-labelledby', 'bench-title');
    var head = create('div', 'bench__head');
    var title = create('h2', null, 'Held-out comparison');
    title.id = 'bench-title';
    var sampleParts = [];
    if (isFiniteNumber(sampleN)) sampleParts.push('n = ' + formatCount(sampleN));
    if (percentLevel(intervalLevel)) sampleParts.push(percentLevel(intervalLevel) + ' band');
    var sample = create('span', 'bench__sample', sampleParts.length ? sampleParts.join(' · ') : 'No sample supplied');
    append(head, title, sample);
    section.appendChild(head);
    section.appendChild(create('p', 'bench__label', reasonText ||
      'No held-out benchmark metrics were supplied with this snapshot. Per-row bands are still shown where the generated data provides them.'));
    return section;
  }

  function buildBenchmark() {
    var bench = data.benchmark;
    if (!bench) {
      return buildBenchMissing(null, null, 'No held-out benchmark block was supplied with this snapshot.');
    }
    if (!benchmarkHasData(bench)) {
      return buildBenchMissing(bench.sampleN, bench.intervalLevel,
        'The benchmark block is present, but no held-out metrics were supplied. No comparison is inferred.');
    }

    var section = create('aside', 'bench');
    section.setAttribute('aria-labelledby', 'bench-title');

    var head = create('div', 'bench__head');
    var title = create('h2', null, 'Held-out comparison');
    title.id = 'bench-title';
    var sampleParts = [];
    if (isFiniteNumber(bench.sampleN)) sampleParts.push('n = ' + formatCount(bench.sampleN));
    if (percentLevel(bench.intervalLevel)) sampleParts.push(percentLevel(bench.intervalLevel) + ' band');
    var sample = create('span', 'bench__sample',
      sampleParts.length ? sampleParts.join(' · ') : 'Sample not supplied');
    append(head, title, sample);
    section.appendChild(head);

    section.appendChild(create('p', 'bench__label',
      bench.label || 'Metrics compare implied market caps against realized peer market caps on a held-out split.'));

    var groups = [
      { label: 'Selected model', metric: bench.selected, isGlobal: false, isSelected: true },
      { label: 'Category baseline', metric: bench.category, isGlobal: false, isSelected: false },
      { label: 'Global, wide band', metric: bench.global, isGlobal: true, isSelected: false }
    ];
    var maxError = 0;
    groups.forEach(function (group) {
      if (isFiniteNumber(group.metric.medianAbsLogError)) {
        maxError = Math.max(maxError, group.metric.medianAbsLogError);
      }
    });

    var table = create('table', 'bench-table');
    var caption = create('caption', 'sr-only', 'Held-out benchmark comparison by model');
    table.appendChild(caption);
    var thead = create('thead');
    var headRow = create('tr');
    append(headRow,
      create('th', null, 'Model'),
      create('th', 'num', 'Median error'),
      create('th', 'num', 'Coverage'),
      create('th', 'num', 'MAPE'));
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = create('tbody');
    groups.forEach(function (group) {
      var tr = create('tr', group.isGlobal ? 'is-global' : (group.isSelected ? 'is-selected' : null));
      append(tr,
        create('td', 'model', group.label),
        create('td', 'num'),
        create('td', 'num', formatCoverage(group.metric.coverage)),
        create('td', 'num', formatCoverage(group.metric.mape)));
      var errorCell = tr.children[1];
      errorCell.appendChild(create('span', 'error-value', formatDecimal(group.metric.medianAbsLogError, 2)));
      if (isFiniteNumber(group.metric.medianAbsLogError) && maxError > 0) {
        var bar = create('div', 'bench-errorbar');
        var fill = create('span');
        fill.style.width = Math.max(2, Math.round((group.metric.medianAbsLogError / maxError) * 100)) + '%';
        bar.appendChild(fill);
        errorCell.appendChild(bar);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    section.appendChild(table);

    var noteText = 'Median error is the median absolute log error of the implied versus realized market cap. Held-out comparison, not a launch backtest. Coverage is the share of';
    if (isFiniteNumber(bench.sampleN)) noteText += ' ' + formatCount(bench.sampleN);
    noteText += ' held-out peers whose realized market cap fell inside the empirical band';
    if (percentLevel(bench.intervalLevel)) noteText += ' at the ' + percentLevel(bench.intervalLevel) + ' target';
    noteText += '. The global row is the broad pooled reference.';
    section.appendChild(create('p', 'bench-note', noteText));
    return section;
  }

  function buildIntro() {
    var section = create('section', 'intro');
    section.setAttribute('aria-labelledby', 'page-title');

    var main = create('div', 'intro__main');
    var title = create('h1', 'page-title', 'The tokenless, priced by peers.');
    title.id = 'page-title';
    title.tabIndex = -1;
    main.appendChild(title);

    var datelineParts = [];
    datelineParts.push(data.asOf ? 'Snapshot ' + data.asOf : 'Snapshot date not supplied');
    var counts = countsText();
    if (counts) datelineParts.push(counts);
    main.appendChild(create('p', 'dateline', datelineParts.join(' · ')));

    var lede = create('p', 'lede');
    append(lede,
      document.createTextNode('A cross-sectional valuation ledger for token-less protocols, benchmarked against tokenized peers in one frozen DefiLlama snapshot. Implied market caps are '),
      create('strong', null, 'benchmarks, not forecasts.'));
    main.appendChild(lede);

    append(section, main, buildBenchmark());
    return section;
  }

  function categoryOptions() {
    var categories = [];
    var seen = {};
    rows.forEach(function (row) {
      if (row.category && !seen[row.category]) {
        seen[row.category] = true;
        categories.push(row.category);
      }
    });
    categories.sort(function (a, b) { return a.localeCompare(b); });
    return categories;
  }

  function hasUncategorized() {
    return rows.some(function (row) { return !row.category; });
  }

  function tokenStatuses() {
    var values = [];
    var seen = {};
    rows.forEach(function (row) {
      if (row.tokenStatus && !seen[row.tokenStatus]) {
        seen[row.tokenStatus] = true;
        values.push(row.tokenStatus);
      }
    });
    values.sort(function (a, b) { return a.localeCompare(b); });
    return values;
  }

  function buildField(labelText, control, extraClass) {
    var field = create('div', 'field' + (extraClass ? ' ' + extraClass : ''));
    var label = create('label', null, labelText);
    label.htmlFor = control.id;
    append(field, label, control);
    return field;
  }

  function buildSelect(id, options, selectedValue) {
    var wrap = create('div', 'select-wrap');
    var select = create('select');
    select.id = id;
    options.forEach(function (option) {
      var item = create('option', null, option.label);
      item.value = option.value;
      if (option.value === selectedValue) item.selected = true;
      select.appendChild(item);
    });
    wrap.appendChild(select);
    return { wrap: wrap, select: select };
  }

  function buildControls() {
    var section = create('section', 'controls');
    section.setAttribute('aria-label', 'Filter and sort the valuation ledger');

    var searchInput = create('input');
    searchInput.type = 'search';
    searchInput.id = 'filter-q';
    searchInput.placeholder = 'Name, slug, chain, or evidence flag';
    searchInput.value = state.query;
    searchInput.autocomplete = 'off';
    var searchField = buildField('Search protocols', searchInput, 'field--search');
    section.appendChild(searchField);

    var categorySelectData = buildSelect('filter-category',
      [{ value: 'all', label: 'All categories' }].concat(categoryOptions().map(function (category) {
        return { value: category, label: category };
      })).concat(hasUncategorized() ? [{ value: '__none__', label: 'Uncategorized' }] : []),
      state.category);
    var categoryField = buildField('Category', categorySelectData.wrap, 'field--category');
    section.appendChild(categoryField);

    var evidenceOptions = [
      { value: 'all', label: 'Any evidence status' },
      { value: 'flagged', label: 'Flagged records' },
      { value: 'clear', label: 'No flags' },
      { value: 'farm:source-backed', label: 'Farm: source-backed' },
      { value: 'farm:verify-terms', label: 'Farm: verify terms' },
      { value: 'farm:research-only', label: 'Farm: research only' }
    ].concat(tokenStatuses().map(function (status) {
      return { value: 'status:' + status, label: 'Status: ' + status };
    }));
    var evidenceSelectData = buildSelect('filter-evidence', evidenceOptions, state.evidence);
    var evidenceField = buildField('Evidence', evidenceSelectData.wrap, 'field--evidence');
    section.appendChild(evidenceField);

    var sortSelectData = buildSelect('filter-sort',
      SORT_COLUMNS.map(function (column) {
        return { value: column.key, label: column.label };
      }),
      state.sortKey);
    var sortField = buildField('Sort by', sortSelectData.wrap, 'field--sort');
    section.appendChild(sortField);

    var checkField = create('div', 'field field--check');
    var checkbox = create('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'filter-watchlist';
    checkbox.checked = state.watchlistOnly;
    var watchCount = rows.filter(function (row) { return row.watchlist; }).length;
    var checkLabel = create('label', 'check-label', 'Watchlist only (' + watchCount + ')');
    checkLabel.htmlFor = checkbox.id;
    append(checkField, checkbox, checkLabel);
    section.appendChild(checkField);

    var reset = create('button', 'button-reset', 'Reset filters');
    reset.type = 'button';
    section.appendChild(reset);

    function onFilterChange() {
      state.page = 1;
      updateLedger(true);
      syncControls();
    }

    searchInput.addEventListener('input', function () {
      state.query = searchInput.value;
      state.page = 1;
      updateLedger(true);
    });

    categorySelectData.select.addEventListener('change', function () {
      state.category = categorySelectData.select.value;
      onFilterChange();
    });

    evidenceSelectData.select.addEventListener('change', function () {
      state.evidence = evidenceSelectData.select.value;
      onFilterChange();
    });

    sortSelectData.select.addEventListener('change', function () {
      state.sortKey = sortSelectData.select.value;
      state.sortDir = DEFAULT_DIRECTION[state.sortKey] || 'asc';
      state.page = 1;
      updateLedger(true);
      syncControls();
    });

    checkbox.addEventListener('change', function () {
      state.watchlistOnly = checkbox.checked;
      onFilterChange();
    });

    reset.addEventListener('click', function () {
      resetAll();
    });

    ledger = ledger || {};
    ledger.searchInput = searchInput;
    ledger.categorySelect = categorySelectData.select;
    ledger.evidenceSelect = evidenceSelectData.select;
    ledger.sortSelect = sortSelectData.select;
    ledger.watchlistInput = checkbox;

    return section;
  }

  function syncControls() {
    if (!ledger) return;
    if (ledger.searchInput) ledger.searchInput.value = state.query;
    if (ledger.categorySelect) ledger.categorySelect.value = state.category;
    if (ledger.evidenceSelect) ledger.evidenceSelect.value = state.evidence;
    if (ledger.sortSelect) ledger.sortSelect.value = state.sortKey;
    if (ledger.watchlistInput) ledger.watchlistInput.checked = state.watchlistOnly;
    updateSortIndicators();
  }

  function buildLedger() {
    var section = create('section', 'ledger-section');
    section.setAttribute('aria-labelledby', 'ledger-title');

    var head = create('div', 'ledger-head');
    var title = create('h2', null, 'Valuation ledger');
    title.id = 'ledger-title';
    var resultCount = create('p', 'result-count');
    resultCount.id = 'result-count';
    append(head, title, resultCount);
    section.appendChild(head);

    var axis = create('p', 'axis-note');
    axis.id = 'axis-note';
    if (bandDomain) {
      var level = percentLevel(data.benchmark && data.benchmark.intervalLevel);
      axis.textContent = 'Bars share one global log scale from ' + formatCompactUsd(bandDomain.min) +
        ' to ' + formatCompactUsd(bandDomain.max) + '. Each bar is a row’s empirical' +
        (level ? ' ' + level : '') + ' band; the vertical mark is the implied value.';
    } else {
      axis.textContent = 'Empirical band bars are unavailable in this build.';
    }
    section.appendChild(axis);

    var tableWrap = create('div', 'table-wrap');
    tableWrap.id = 'table-wrap';
    var table = create('table', 'ledger-table');
    var caption = create('caption', 'sr-only', 'Protocol valuation ledger');
    table.appendChild(caption);

    var thead = create('thead');
    var headerRow = create('tr');
    SORT_COLUMNS.forEach(function (column) {
      var th = create('th', column.className + (column.numeric ? ' num' : ''));
      th.scope = 'col';
      th.dataset.key = column.key;
      th.setAttribute('aria-sort', 'none');
      var button = create('button', 'sort-btn', column.label);
      button.type = 'button';
      button.dataset.sortKey = column.key;
      button.setAttribute('aria-label', 'Sort by ' + column.label.toLowerCase());
      var arrow = create('span', 'sort-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      button.appendChild(arrow);
      button.addEventListener('click', function () {
        setSort(column.key);
      });
      th.appendChild(button);
      if (column.key === 'bandWidth' && bandDomain) {
        var scale = create('span', 'col-scale');
        scale.setAttribute('aria-hidden', 'true');
        append(scale,
          create('span', null, formatCompactUsd(bandDomain.min)),
          create('span', null, 'log scale'),
          create('span', null, formatCompactUsd(bandDomain.max)));
        th.appendChild(scale);
      }
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = create('tbody');
    tbody.id = 'ledger-body';
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    section.appendChild(tableWrap);

    var empty = create('div', 'empty-state');
    empty.id = 'empty-state';
    empty.hidden = true;
    var emptyTitle = create('h3', null, 'No protocols match these filters.');
    var emptyText = create('p', null, 'The full snapshot is still loaded. Clear a filter or search for a different name.');
    var emptyReset = create('button', 'button-reset', 'Reset filters');
    emptyReset.type = 'button';
    emptyReset.addEventListener('click', resetAll);
    append(empty, emptyTitle, emptyText, emptyReset);
    section.appendChild(empty);

    var pager = create('div', 'pager');
    pager.id = 'pager';
    var pagerLabel = create('p', 'pager__label');
    pagerLabel.id = 'pager-label';
    var buttons = create('div', 'pager__buttons');
    var prev = create('button', null, 'Previous');
    prev.type = 'button';
    prev.id = 'pager-prev';
    var next = create('button', null, 'Next');
    next.type = 'button';
    next.id = 'pager-next';
    prev.addEventListener('click', function () {
      if (state.page > 1) {
        state.page -= 1;
        updateLedger(true);
      }
    });
    next.addEventListener('click', function () {
      var total = Math.max(1, Math.ceil(filteredRows().length / PAGE_SIZE));
      if (state.page < total) {
        state.page += 1;
        updateLedger(true);
      }
    });
    append(buttons, prev, next);
    append(pager, pagerLabel, buttons);
    section.appendChild(pager);

    var controlRefs = ledger || {};
    ledger = {
      section: section,
      tableWrap: tableWrap,
      table: table,
      tbody: tbody,
      resultCount: resultCount,
      axis: axis,
      empty: empty,
      emptyReset: emptyReset,
      pager: pager,
      pagerLabel: pagerLabel,
      prev: prev,
      next: next,
      searchInput: controlRefs.searchInput,
      categorySelect: controlRefs.categorySelect,
      evidenceSelect: controlRefs.evidenceSelect,
      sortSelect: controlRefs.sortSelect,
      watchlistInput: controlRefs.watchlistInput
    };
    return section;
  }

  function renderBoard() {
    var fragment = document.createDocumentFragment();
    fragment.appendChild(buildIntro());
    fragment.appendChild(buildControls());
    fragment.appendChild(buildLedger());
    app.replaceChildren(fragment);
    syncControls();
    updateLedger(false);
    updateChrome();
  }

  function setSort(key) {
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = DEFAULT_DIRECTION[key] || 'asc';
    }
    state.page = 1;
    updateLedger(true);
    syncControls();
  }

  function updateSortIndicators() {
    if (!ledger || !ledger.table) return;
    var headers = ledger.table.querySelectorAll('th[data-key]');
    Array.prototype.forEach.call(headers, function (th) {
      var active = th.dataset.key === state.sortKey;
      th.setAttribute('aria-sort', active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      var button = th.querySelector('.sort-btn');
      if (!button) return;
      button.classList.toggle('is-active', active);
      var arrow = button.querySelector('.sort-arrow');
      if (arrow) arrow.textContent = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '';
    });
  }

  function filteredRows() {
    var query = state.query.trim().toLowerCase();
    return rows.filter(function (row) {
      if (state.category !== 'all') {
        if (state.category === '__none__') {
          if (row.category) return false;
        } else if (row.category !== state.category) {
          return false;
        }
      }

      if (state.watchlistOnly && !row.watchlist) return false;

      if (state.evidence === 'flagged' && row.flags.length === 0) return false;
      if (state.evidence === 'clear' && row.flags.length > 0) return false;
      if (state.evidence.indexOf('status:') === 0) {
        var wantedStatus = state.evidence.slice('status:'.length);
        if (row.tokenStatus !== wantedStatus) return false;
      }
      if (state.evidence.indexOf('farm:') === 0) {
        var wantedFarmStatus = state.evidence.slice('farm:'.length);
        if (!row.farm || row.farm.status !== wantedFarmStatus) return false;
      }

      if (query) {
        var haystack = [
          row.name,
          row.slug,
          row.category || '',
          row.chains.join(' '),
          row.tokenStatus,
          row.flags.map(flagLabel).join(' '),
          row.farm ? row.farm.status : ''
        ].join(' ').toLowerCase();
        if (haystack.indexOf(query) === -1) return false;
      }

      return true;
    });
  }

  function rowBandWidth(row) {
    if (!isPositiveNumber(row.lowUsd) || !isPositiveNumber(row.highUsd) || row.highUsd <= row.lowUsd) {
      return null;
    }
    return Math.log(row.highUsd / row.lowUsd);
  }

  function compareRows(left, right, key) {
    var leftValue;
    var rightValue;
    switch (key) {
      case 'rank':
        leftValue = left.rank;
        rightValue = right.rank;
        break;
      case 'name':
        leftValue = left.name;
        rightValue = right.name;
        break;
      case 'category':
        leftValue = left.category || '';
        rightValue = right.category || '';
        break;
      case 'tvlUsd':
        leftValue = left.tvlUsd;
        rightValue = right.tvlUsd;
        break;
      case 'change7d':
        leftValue = left.change7d;
        rightValue = right.change7d;
        break;
      case 'impliedValueUsd':
        leftValue = left.impliedValueUsd;
        rightValue = right.impliedValueUsd;
        break;
      case 'bandWidth':
        leftValue = rowBandWidth(left);
        rightValue = rowBandWidth(right);
        break;
      case 'peerCount':
        leftValue = left.peerCount;
        rightValue = right.peerCount;
        break;
      case 'evidence':
        leftValue = left.flags.length;
        rightValue = right.flags.length;
        break;
      default:
        leftValue = left.rank;
        rightValue = right.rank;
    }

    var leftMissing = leftValue === null || leftValue === undefined || leftValue === '';
    var rightMissing = rightValue === null || rightValue === undefined || rightValue === '';
    if (leftMissing && rightMissing) {
      return left.name.localeCompare(right.name);
    }
    if (leftMissing) return 1;
    if (rightMissing) return -1;

    var comparison;
    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      comparison = leftValue - rightValue;
    } else {
      comparison = String(leftValue).localeCompare(String(rightValue), 'en', { sensitivity: 'base' });
    }
    if (comparison === 0) {
      comparison = left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
    }
    return state.sortDir === 'desc' ? -comparison : comparison;
  }

  function sortedFilteredRows() {
    return filteredRows().slice().sort(function (a, b) {
      return compareRows(a, b, state.sortKey);
    });
  }

  function sortDescription() {
    var column = SORT_COLUMNS.filter(function (item) { return item.key === state.sortKey; })[0];
    var label = column ? column.label : 'Rank';
    if (state.sortKey === 'name' || state.sortKey === 'category') {
      return label.toLowerCase() + (state.sortDir === 'asc' ? ', A to Z' : ', Z to A');
    }
    if (state.sortKey === 'rank') {
      return 'rank, ' + (state.sortDir === 'asc' ? 'low to high' : 'high to low');
    }
    if (state.sortKey === 'evidence') {
      return 'evidence, ' + (state.sortDir === 'asc' ? 'fewest flags first' : 'most flags first');
    }
    if (state.sortKey === 'bandWidth') {
      return 'band width, ' + (state.sortDir === 'asc' ? 'narrow to wide' : 'wide to narrow');
    }
    if (state.sortKey === 'peerCount') {
      return 'peers, ' + (state.sortDir === 'asc' ? 'fewest first' : 'most first');
    }
    if (state.sortKey === 'impliedValueUsd') {
      return 'implied cap, ' + (state.sortDir === 'asc' ? 'low to high' : 'high to low');
    }
    return label + ', ' + (state.sortDir === 'asc' ? 'low to high' : 'high to low');
  }

  function createBandCell(row) {
    var td = create('td', 'col-band cell-band');
    var track = create('div', 'band-track');
    var rangePercent = null;
    var midPercent = null;

    if (bandDomain && isPositiveNumber(row.lowUsd) && isPositiveNumber(row.highUsd)) {
      var low = bandPosition(row.lowUsd, bandDomain);
      var high = bandPosition(row.highUsd, bandDomain);
      midPercent = bandPosition(row.impliedValueUsd, bandDomain);
      if (low !== null && high !== null) {
        rangePercent = {
          left: Math.min(low, high),
          width: Math.max(1, Math.abs(high - low))
        };
      }
    }

    if (rangePercent) {
      var range = create('span', 'band-range');
      range.style.left = rangePercent.left.toFixed(2) + '%';
      range.style.width = rangePercent.width.toFixed(2) + '%';
      track.appendChild(range);
    } else {
      track.className += ' band-track--empty';
    }

    if (midPercent !== null) {
      var mid = create('span', 'band-mid');
      mid.style.left = midPercent.toFixed(2) + '%';
      track.appendChild(mid);
    }

    var text;
    if (isPositiveNumber(row.lowUsd) && isPositiveNumber(row.highUsd)) {
      text = formatCompactUsd(row.lowUsd) + '–' + formatCompactUsd(row.highUsd);
    } else {
      text = 'No band supplied';
    }

    append(td, track, create('span', 'band-text', text));
    td.dataset.label = 'Empirical band';
    return td;
  }

  function createEvidenceCell(row) {
    var td = create('td', 'col-evidence cell-evidence');
    var evidence = create('div', 'evidence' + (row.flags.length ? ' evidence--flagged' : ''));
    evidence.appendChild(create('span', 'evidence-dot'));
    var textWrap = create('span');
    var countLabel = row.flags.length === 0
      ? 'Clear'
      : row.flags.length + (row.flags.length === 1 ? ' flag' : ' flags');
    textWrap.appendChild(create('span', 'evidence-label', countLabel));
    if (row.flags.length > 0) {
      var sub = flagLabel(row.flags[0]);
      if (row.flags.length > 1) sub += ' +' + (row.flags.length - 1) + ' more';
      textWrap.appendChild(create('span', 'evidence-sub', sub));
    } else if (row.tokenStatus) {
      textWrap.appendChild(create('span', 'evidence-sub', row.tokenStatus));
    }
    evidence.appendChild(textWrap);
    td.appendChild(evidence);
    td.dataset.label = 'Evidence';
    return td;
  }

  function buildRow(row) {
    var tr = document.createElement('tr');
    tr.dataset.slug = row.slug;

    var rank = create('td', 'col-rank cell-rank', row.rank === null ? '—' : '#' + row.rank);
    tr.appendChild(rank);

    var nameCell = create('td', 'col-name cell-name');
    var link = create('a', 'name-link', row.name);
    link.href = '#/protocol/' + encodeURIComponent(row.slug);
    link.setAttribute('aria-label', 'View valuation detail for ' + row.name);
    nameCell.appendChild(link);
    var meta = create('div', 'name-meta');
    meta.appendChild(create('span', null, row.slug));
    if (row.chains.length) {
      var chainText = row.chains.slice(0, 2).join(' · ');
      if (row.chains.length > 2) chainText += ' +' + (row.chains.length - 2);
      meta.appendChild(create('span', null, chainText));
    }
    if (row.watchlist) meta.appendChild(create('span', 'watch', 'Watched'));
    nameCell.appendChild(meta);
    tr.appendChild(nameCell);

    tr.appendChild(create('td', 'col-category cell-category' + (row.category ? '' : ' cell-empty'),
      row.category || 'Uncategorized'));

    tr.appendChild(create('td', 'col-tvl cell-tvl num cell-num', formatCompactUsd(row.tvlUsd)));

    var change = create('td', 'col-change cell-change num cell-num' + (isFiniteNumber(row.change7d) ? ' ' + changeClass(row.change7d) : ' cell-empty'),
      formatChange(row.change7d));
    tr.appendChild(change);

    tr.appendChild(create('td', 'col-implied cell-implied num cell-num cell-implied-value',
      formatCompactUsd(row.impliedValueUsd)));

    tr.appendChild(createBandCell(row));

    tr.appendChild(create('td', 'col-peers cell-peers num cell-num',
      isFiniteNumber(row.peerCount) ? formatCount(row.peerCount) : '—'));

    tr.appendChild(createEvidenceCell(row));

    return tr;
  }

  function updateLedger(announce) {
    if (!ledger || !ledger.tbody) return;

    var filtered = sortedFilteredRows();
    var totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;

    var start = (state.page - 1) * PAGE_SIZE;
    var pageRows = filtered.slice(start, start + PAGE_SIZE);

    var fragment = document.createDocumentFragment();
    pageRows.forEach(function (row) {
      fragment.appendChild(buildRow(row));
    });
    ledger.tbody.replaceChildren(fragment);

    ledger.resultCount.textContent = filtered.length + ' of ' + rows.length +
      ' protocols · sorted by ' + sortDescription();

    var isEmpty = filtered.length === 0;
    ledger.tableWrap.hidden = isEmpty;
    ledger.empty.hidden = !isEmpty;
    ledger.pager.hidden = isEmpty || totalPages <= 1;

    if (isEmpty) {
      ledger.emptyText = 'The full snapshot holds ' + rows.length + ' protocols. Clear a filter or search a different name.';
      var emptyParagraph = ledger.empty.querySelector('p');
      if (emptyParagraph) emptyParagraph.textContent = ledger.emptyText;
    }

    ledger.pagerLabel.textContent = 'Page ' + state.page + ' of ' + totalPages;
    ledger.prev.disabled = state.page <= 1;
    ledger.next.disabled = state.page >= totalPages;

    updateSortIndicators();

    if (announce) {
      announcer.textContent = isEmpty
        ? 'No protocols match these filters.'
        : filtered.length + ' protocols match. Page ' + state.page + ' of ' + totalPages + '.';
    }
  }

  function resetAll() {
    state.query = '';
    state.category = 'all';
    state.watchlistOnly = false;
    state.evidence = 'all';
    state.sortKey = 'rank';
    state.sortDir = 'asc';
    state.page = 1;
    syncControls();
    updateLedger(true);
    if (ledger && ledger.searchInput) ledger.searchInput.focus();
  }

  function buildFactList(row) {
    var dl = create('dl', 'facts');
    function add(term, value, className) {
      append(dl, create('dt', null, term), create('dd', className || null, value));
    }
    add('Category', row.category || 'Uncategorized');
    add('Chains', row.chains.length ? row.chains.join(' · ') : 'Not supplied');
    add('TVL', formatFullUsd(row.tvlUsd));
    add('7d change', formatChange(row.change7d));
    add('Listed at', row.listedAt || 'Not supplied');
    add('Peer examples', isFiniteNumber(row.peerCount) ? formatCount(row.peerCount) : 'Not supplied');
    add('Token status', row.tokenStatus || 'Not supplied');
    add('Watchlist', row.watchlist ? 'Watched' : 'Not watched', row.watchlist ? 'watch' : null);
    return dl;
  }

  function buildFlags(row) {
    if (row.flags.length === 0) {
      return create('p', 'section-note', 'No evidence flags were recorded for this protocol.');
    }
    var list = create('ul', 'flags');
    row.flags.forEach(function (flag) {
      var item = create('li');
      item.appendChild(create('span', 'flag-dot'));
      item.appendChild(create('span', null, flagLabel(flag)));
      list.appendChild(item);
    });
    return list;
  }

  function buildPeers(row) {
    var section = create('section');
    section.appendChild(create('h2', null, 'Peer comparison'));
    var note = row.peers.length
      ? 'Source peers from the frozen snapshot; examples are not a recommendation.'
      : 'No peer examples were supplied for this row.';
    section.appendChild(create('p', 'section-note', note));

    if (row.peers.length === 0) return section;

    var table = create('table', 'peers');
    var caption = create('caption', 'sr-only', 'Peer market-cap comparison for ' + row.name);
    table.appendChild(caption);
    var thead = create('thead');
    var headerRow = create('tr');
    append(headerRow,
      create('th', null, 'Peer'),
      create('th', 'num', 'TVL'),
      create('th', 'num', 'Market cap'),
      create('th', 'num', 'MC / TVL'));
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = create('tbody');
    row.peers.forEach(function (peer) {
      var tr = create('tr');
      var ratio = isPositiveNumber(peer.marketCapUsd) && isPositiveNumber(peer.tvlUsd)
        ? (peer.marketCapUsd / peer.tvlUsd).toFixed(2) + '×'
        : '—';
      append(tr,
        create('td', 'peer-slug', peer.slug),
        create('td', 'num', formatCompactUsd(peer.tvlUsd)),
        create('td', 'num', formatCompactUsd(peer.marketCapUsd)),
        create('td', 'num', ratio));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    section.appendChild(table);

    if (isFiniteNumber(row.peerCount) && row.peerCount > row.peers.length) {
      section.appendChild(create('p', 'section-note',
        'Showing ' + row.peers.length + ' of ' + formatCount(row.peerCount) + ' peers in this build.'));
    }
    return section;
  }

  function buildFarm(row) {
    var section = create('section');
    section.appendChild(create('h2', null, 'Farm checks'));

    if (!row.farm) {
      section.appendChild(create('p', 'section-note',
        'No farm evidence block was supplied for this protocol. No checks are inferred.'));
      return section;
    }

    var statusText = FARM_STATUS_LABELS[row.farm.status] || sentenceCase(row.farm.status.replace(/-/g, ' ')) || 'Status not supplied';
    var status = create('p', 'farm-status farm-status--' + (row.farm.status || 'research-only'), statusText);
    section.appendChild(status);
    section.appendChild(create('p', 'section-note',
      'Status is shown as supplied by the generated snapshot. This page makes no remote calls and verifies no terms.'));

    var stepsBlock = create('div', 'farm-block');
    stepsBlock.appendChild(create('h3', null, 'Steps'));
    if (row.farm.steps.length) {
      var list = create('ol', 'farm-steps');
      row.farm.steps.forEach(function (step) {
        list.appendChild(create('li', null, step));
      });
      stepsBlock.appendChild(list);
    } else {
      stepsBlock.appendChild(create('p', 'section-note', 'No farm steps were supplied.'));
    }
    section.appendChild(stepsBlock);

    var sourcesBlock = create('div', 'farm-block');
    sourcesBlock.appendChild(create('h3', null, 'Sources'));
    if (row.farm.sources.length) {
      var sources = create('ul', 'farm-sources');
      row.farm.sources.forEach(function (source) {
        sources.appendChild(create('li', null, source));
      });
      sourcesBlock.appendChild(sources);
    } else {
      sourcesBlock.appendChild(create('p', 'section-note', 'No source notes were supplied.'));
    }
    section.appendChild(sourcesBlock);

    return section;
  }

  function buildBenchmarkContext() {
    var section = create('section');
    section.appendChild(create('h2', null, 'Held-out context'));

    var bench = data.benchmark;
    if (!benchmarkHasData(bench)) {
      section.appendChild(create('p', 'section-note',
        'No held-out benchmark metrics were supplied with this snapshot. No comparison is inferred.'));
      return section;
    }

    var box = create('div', 'aside-note');
    var globalText = create('p');
    globalText.appendChild(create('strong', null, 'Global wide band. '));
    var globalParts = [];
    if (isFiniteNumber(bench.global.coverage)) {
      globalParts.push('Covered ' + formatCoverage(bench.global.coverage) + ' of held-out peers');
    }
    if (isFiniteNumber(bench.sampleN)) {
      globalParts.push('n = ' + formatCount(bench.sampleN));
    }
    if (isFiniteNumber(bench.global.medianAbsLogError)) {
      globalParts.push('median absolute log error ' + formatDecimal(bench.global.medianAbsLogError, 2));
    }
    globalText.appendChild(document.createTextNode(
      globalParts.length ? globalParts.join(' · ') + '.' : 'Metrics were not supplied for the pooled baseline.'));
    box.appendChild(globalText);
    var selectedText = create('p');
    var selectedParts = [];
    if (isFiniteNumber(bench.selected.coverage)) selectedParts.push('coverage ' + formatCoverage(bench.selected.coverage));
    if (isFiniteNumber(bench.selected.medianAbsLogError)) selectedParts.push('median absolute log error ' + formatDecimal(bench.selected.medianAbsLogError, 2));
    var level = percentLevel(bench.intervalLevel);
    selectedText.textContent = 'Selected model' + (level ? ' at the ' + level + ' empirical level' : '') +
      ': ' + (selectedParts.length ? selectedParts.join(' · ') : 'no metrics supplied') + '.';
    box.appendChild(selectedText);

    if (bench.label) {
      box.appendChild(create('p', null, bench.label));
    }
    section.appendChild(box);
    section.appendChild(create('p', 'section-note',
      'This is a held-out cross-sectional comparison, not a launch backtest or a probability of future market cap.'));
    return section;
  }

  function buildBandChart(row) {
    var section = create('section', 'detail-band');
    section.setAttribute('aria-labelledby', 'band-title');

    var head = create('div', 'section-head');
    var title = create('h2', null, 'Empirical valuation band');
    title.id = 'band-title';
    var legendText = [];
    var level = percentLevel(data.benchmark && data.benchmark.intervalLevel);
    if (level) legendText.push(level + ' interval');
    var multiple = formatMultiple(row.lowUsd, row.highUsd);
    if (multiple) legendText.push(multiple + ' range');
    append(head, title, create('span', null, legendText.length ? legendText.join(' · ') : 'Interval not supplied'));
    section.appendChild(head);

    var domain = computeLocalDomain([row.lowUsd, row.highUsd]);
    var lowPos = bandPosition(row.lowUsd, domain);
    var highPos = bandPosition(row.highUsd, domain);
    var midPos = bandPosition(row.impliedValueUsd, domain);

    if (lowPos !== null && highPos !== null) {
      var chart = create('div', 'band-chart');
      var track = create('div', 'band-chart__track');
      var range = create('span', 'band-chart__range');
      range.style.left = Math.min(lowPos, highPos).toFixed(2) + '%';
      range.style.width = Math.max(1, Math.abs(highPos - lowPos)).toFixed(2) + '%';
      track.appendChild(range);
      if (midPos !== null) {
        var mid = create('span', 'band-chart__mid');
        mid.style.left = midPos.toFixed(2) + '%';
        track.appendChild(mid);
      }
      chart.appendChild(track);

      var labels = create('div', 'band-chart__legend');
      var lowItem = create('span');
      append(lowItem, document.createTextNode('Low '), create('strong', null, formatFullUsd(row.lowUsd)));
      var highItem = create('span');
      append(highItem, document.createTextNode('High '), create('strong', null, formatFullUsd(row.highUsd)));
      append(labels, lowItem, highItem);
      chart.appendChild(labels);
      section.appendChild(chart);
    } else {
      section.appendChild(create('p', 'section-note',
        'No usable low and high values were supplied for this row, so the interval cannot be drawn.'));
    }

    section.appendChild(create('p', 'method-note',
      'The vertical marker is the implied market cap. The band is an empirical interval derived from out-of-fold peer residuals. It is a cross-sectional benchmark, not a price forecast, launch backtest, or probability.'));
    return section;
  }

  function renderDetailMissing(slug) {
    var article = create('article', 'detail');
    var back = create('a', 'back-link', '← Back to ledger');
    back.href = '#/';
    article.appendChild(back);

    var section = create('section', 'no-data');
    var title = create('h1', null, 'Protocol not found');
    title.id = 'detail-title';
    title.tabIndex = -1;
    section.appendChild(title);
    section.appendChild(create('p', null,
      'No row with the slug “' + slug + '” is present in this snapshot. The ledger has not been changed.'));
    var backAgain = create('a', 'back-link', 'Return to the valuation ledger');
    backAgain.href = '#/';
    section.appendChild(backAgain);
    article.appendChild(section);
    app.replaceChildren(article);
    announcer.textContent = 'Protocol not found.';
  }

  function renderDetail(slug) {
    var row = rows.filter(function (item) { return item.slug === slug; })[0];
    if (!row) {
      renderDetailMissing(slug);
      return;
    }

    var article = create('article', 'detail');
    var back = create('a', 'back-link', '← Back to ledger');
    back.href = '#/';
    article.appendChild(back);

    var head = create('header', 'detail-head');
    var headMain = create('div');
    var title = create('h1', 'detail-title', row.name);
    title.id = 'detail-title';
    title.tabIndex = -1;
    headMain.appendChild(title);

    var meta = create('p', 'detail-meta');
    append(meta,
      create('span', null, row.rank === null ? 'Rank not supplied' : 'Rank #' + row.rank),
      create('span', null, row.slug),
      create('span', null, row.category || 'Uncategorized'),
      create('span', null, row.chains.length ? row.chains.join(' · ') : 'Chains not supplied'));
    if (row.watchlist) meta.appendChild(create('span', 'watch', 'Watched'));
    headMain.appendChild(meta);

    var value = create('div', 'detail-value');
    value.appendChild(create('span', 'detail-value__label', 'Implied market cap'));
    value.appendChild(create('strong', null, formatFullUsd(row.impliedValueUsd)));
    var rangeText = isPositiveNumber(row.lowUsd) && isPositiveNumber(row.highUsd)
      ? formatCompactUsd(row.lowUsd) + ' – ' + formatCompactUsd(row.highUsd)
      : 'No empirical band supplied';
    value.appendChild(create('span', 'detail-value__range', rangeText));
    append(head, headMain, value);
    article.appendChild(head);

    article.appendChild(buildBandChart(row));

    var columns = create('div', 'detail-columns');
    var main = create('div', 'detail-main');
    main.appendChild(buildPeers(row));
    main.appendChild(buildFarm(row));

    var aside = create('aside', 'detail-aside');
    var factsSection = create('section');
    factsSection.appendChild(create('h2', null, 'Snapshot facts'));
    factsSection.appendChild(buildFactList(row));
    aside.appendChild(factsSection);

    var evidenceSection = create('section');
    evidenceSection.appendChild(create('h2', null, 'Evidence'));
    evidenceSection.appendChild(create('p', 'section-note',
      'Flags and token status are shown as supplied by the generated snapshot; this page does not score them.'));
    evidenceSection.appendChild(buildFlags(row));
    aside.appendChild(evidenceSection);
    aside.appendChild(buildBenchmarkContext());

    append(columns, main, aside);
    article.appendChild(columns);
    app.replaceChildren(article);
    announcer.textContent = row.name + ' valuation detail.';
  }

  function focusHeading() {
    var heading = app.querySelector('h1');
    if (heading) heading.focus({ preventScroll: true });
  }

  function isRouteHash(hash) {
    return hash === '' || hash === '#/' || hash.indexOf('#/protocol/') === 0;
  }

  function navigateTo(hash) {
    if (location.hash !== hash) {
      history.pushState(null, '', hash);
    }
    handleRoute({ initial: false });
  }

  function handleRoute(options) {
    var settings = options || {};
    var match = /^#\/protocol\/(.+)$/.exec(location.hash);
    var slug = null;
    if (match) {
      slug = match[1];
      try {
        slug = decodeURIComponent(slug);
      } catch (error) {
        slug = match[1];
      }
    }

    var route = match ? 'detail:' + slug : 'board';
    if (route === lastRenderedRoute) return;
    lastRenderedRoute = route;

    var wasView = view;
    if (view === 'board') lastBoardScroll = window.scrollY;

    if (match) {
      view = 'detail';
      renderDetail(slug);
      window.scrollTo(0, 0);
      if (!settings.initial) focusHeading();
      return;
    }

    view = 'board';
    renderBoard();
    if (!settings.initial && wasView === 'detail') {
      window.scrollTo(0, lastBoardScroll);
      focusHeading();
    }
  }

  function init() {
    var raw = globalThis.TOKEN_RADAR_DATA;
    data = readData();
    if (!data) {
      renderNoData(raw
        ? 'A generated data file was found, but it does not contain a readable rows array. No valuation rows are shown.'
        : null);
      return;
    }

    rows = data.rows;
    bandDomain = buildBandDomain(rows);
    updateChrome();

    window.addEventListener('hashchange', function () {
      if (isRouteHash(location.hash)) handleRoute({ initial: false });
    });

    window.addEventListener('popstate', function () {
      if (isRouteHash(location.hash)) handleRoute({ initial: false });
    });

    document.addEventListener('click', function (event) {
      if (!(event.target instanceof Element)) return;
      var link = event.target.closest('a[href^="#/"]');
      if (!link) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      navigateTo(link.getAttribute('href'));
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && /^#\/protocol\//.test(location.hash)) {
        event.preventDefault();
        navigateTo('#/');
      }
    });

    handleRoute({ initial: true });
  }

  init();
})();
