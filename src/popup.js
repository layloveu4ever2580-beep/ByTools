/**
 * StratOptimizer - Main Popup Controller (v3)
 *
 * New in v3:
 *   - All parameters pre-loaded with lock/unlock toggle
 *   - Locked = fixed value (not optimized), Unlocked = min/max/step fields
 *   - Hardcoded strategy parameters from Pine Script
 *   - No dependency on TradingView dialog detection for parameter listing
 */

(async function () {
  'use strict';

  // --- State ---
  let parameters = [];
  let currentReportId = null;
  let settings = await Storage.getSettings();

  // --- DOM helpers ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // =========================================================================
  //  Default strategy parameters (from Pine Script)
  // =========================================================================

  const DEFAULT_PARAMS = [
    { name: 'EMA 1 Length',           defaultValue: '20',     inputIndex: 0, type: 'int' },
    { name: 'EMA 2 Length',           defaultValue: '50',     inputIndex: 1, type: 'int' },
    { name: 'EMA 3 Length',           defaultValue: '100',    inputIndex: 2, type: 'int' },
    { name: 'EMA 4 Length',           defaultValue: '200',    inputIndex: 3, type: 'int' },
    { name: 'Entry Level (Fib)',      defaultValue: '0.786',  inputIndex: 4, type: 'float' },
    { name: 'Take Profit Level (Fib)',defaultValue: '1.638',  inputIndex: 5, type: 'float' },
    { name: 'Stop Loss Level (Fib)',  defaultValue: '-0.315', inputIndex: 6, type: 'float' },
  ];

  // =========================================================================
  //  Tab navigation
  // =========================================================================

  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const tabEl = document.getElementById('tab-' + btn.dataset.tab);
      if (tabEl) tabEl.classList.add('active');
      if (btn.dataset.tab === 'reports') loadReportsList();
    });
  });

  function showTab(tabName) {
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-content').forEach(c => c.classList.remove('active'));
    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (btn) btn.classList.add('active');
    const tabEl = document.getElementById('tab-' + tabName);
    if (tabEl) tabEl.classList.add('active');
  }

  function showReportDetail() {
    $$('.tab-content').forEach(c => c.classList.remove('active'));
    $('#tab-report-detail').classList.add('active');
  }

  // =========================================================================
  //  Content script helper
  // =========================================================================

  async function getTVTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tvTab = tabs.find(t => t.url && t.url.includes('tradingview.com'));
    if (!tvTab) return null;
    await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'ENSURE_CONTENT_SCRIPT', tabId: tvTab.id },
        () => resolve()
      );
    });
    return tvTab;
  }

  function sendToTab(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  // =========================================================================
  //  Parameter management (lock/unlock model)
  // =========================================================================

  function initParameters() {
    parameters = DEFAULT_PARAMS.map((p, i) => ({
      id: 'param-' + i,
      name: p.name,
      inputIndex: p.inputIndex,
      type: p.type,
      locked: true,
      fixedValue: p.defaultValue,
      start: '',
      end: '',
      step: '',
    }));
    renderParameters();
    updateCombinationCount();
  }

  function toggleLock(id) {
    const param = parameters.find(p => p.id === id);
    if (!param) return;
    param.locked = !param.locked;
    renderParameters();
    updateCombinationCount();
  }

  function removeParameter(id) {
    parameters = parameters.filter(p => p.id !== id);
    renderParameters();
    updateCombinationCount();
  }

  function addParameter() {
    const idx = parameters.length;
    parameters.push({
      id: 'param-custom-' + Date.now(),
      name: '',
      inputIndex: null,
      type: 'float',
      locked: false,
      fixedValue: '',
      start: '',
      end: '',
      step: '',
    });
    renderParameters();
    updateCombinationCount();
  }

  function renderParameters() {
    const container = $('#params-container');
    const empty = $('#params-empty');

    if (parameters.length === 0) {
      container.innerHTML = '';
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';

    container.innerHTML = parameters.map(p => {
      if (p.locked) {
        return `
          <div class="param-card" data-id="${p.id}">
            <div class="param-card-header">
              <span class="param-name-label">${p.name || 'Parameter'}</span>
            </div>
            <div class="param-card-body param-locked-body">
              <div class="param-field">
                <span class="param-field-label">FIXED VALUE</span>
                <input type="text" class="param-input param-fixed" value="${p.fixedValue}" data-field="fixedValue" placeholder="Value">
              </div>
              <button class="btn-lock locked" data-id="${p.id}" title="Locked — click to unlock for optimization">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              </button>
              <button class="btn-remove-param" data-id="${p.id}" title="Remove">×</button>
            </div>
          </div>`;
      } else {
        return `
          <div class="param-card unlocked" data-id="${p.id}">
            <div class="param-card-header">
              <span class="param-name-label">${p.name || 'Parameter'}</span>
            </div>
            <div class="param-card-body param-unlocked-body">
              <div class="param-field">
                <span class="param-field-label">MIN</span>
                <input type="text" class="param-input" value="${p.start}" data-field="start" placeholder="Min">
              </div>
              <div class="param-field">
                <span class="param-field-label">MAX</span>
                <input type="text" class="param-input" value="${p.end}" data-field="end" placeholder="Max">
              </div>
              <div class="param-field">
                <span class="param-field-label">STEP</span>
                <input type="text" class="param-input" value="${p.step}" data-field="step" placeholder="Step">
              </div>
              <button class="btn-lock unlocked" data-id="${p.id}" title="Unlocked — click to lock with fixed value">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
                </svg>
              </button>
              <button class="btn-remove-param" data-id="${p.id}" title="Remove">×</button>
            </div>
          </div>`;
      }
    }).join('');

    // Bind events
    container.querySelectorAll('.param-card input').forEach(input => {
      input.addEventListener('input', (e) => {
        const card = e.target.closest('.param-card');
        const param = parameters.find(p => p.id === card.dataset.id);
        if (param) {
          param[e.target.dataset.field] = e.target.value;
          updateCombinationCount();
        }
      });
    });

    container.querySelectorAll('.btn-lock').forEach(btn => {
      btn.addEventListener('click', () => toggleLock(btn.dataset.id));
    });

    container.querySelectorAll('.btn-remove-param').forEach(btn => {
      btn.addEventListener('click', () => removeParameter(btn.dataset.id));
    });
  }

  function updateCombinationCount() {
    const comboInfo = $('#combo-info');
    const comboSummary = $('#combo-summary');
    const unlockedParams = parameters.filter(p => !p.locked);
    const validUnlockedParams = unlockedParams.filter(p => p.start && p.end && p.step);
    const totalParams = parameters.length;

    if (validUnlockedParams.length === 0 || validUnlockedParams.length !== unlockedParams.length) {
      if (comboInfo) comboInfo.style.display = 'none';
      if (comboSummary) comboSummary.style.display = 'none';
      $('#btn-optimize').disabled = true;
      return;
    }

    const combos = Utils.generateCombinations(validUnlockedParams);
    const delay = parseInt($('#opt-delay').value) || 1500;
    const est = Utils.estimateTime(combos.length, delay);

    if (comboInfo) {
      $('#combo-count').textContent = `${combos.length.toLocaleString()} combinations`;
      $('#combo-time').textContent = `~${Utils.formatDuration(est)}`;
      comboInfo.style.display = 'flex';
    }

    if (comboSummary) {
      $('#combo-summary-text').textContent = `Optimizing ${unlockedParams.length} of ${totalParams} parameters`;
      comboSummary.style.display = 'block';
    }

    $('#btn-optimize').disabled = false;
  }

  // =========================================================================
  //  Detect strategy (updates current values from TradingView)
  // =========================================================================

  async function detectStrategy() {
    try {
      const tvTab = await getTVTab();
      if (!tvTab) { Utils.showToast('No TradingView tab found', 'error'); return; }

      const info = await sendToTab(tvTab.id, { type: 'DETECT_STRATEGY' });

      const infoEl = $('#strategy-info .info-label');
      if (info.strategyName) {
        infoEl.textContent = `${info.strategyName} · ${info.symbol} · ${info.interval}`;
        infoEl.classList.add('detected');
      }

      // Update fixed values from detected params if available
      if (info.params && info.params.length > 0) {
        info.params.forEach((detected, i) => {
          if (i < parameters.length && detected.currentValue) {
            parameters[i].fixedValue = detected.currentValue;
            parameters[i].inputIndex = detected.inputIndex;
            if (detected.name) parameters[i].name = detected.name;
          }
        });
        renderParameters();
        Utils.showToast(`Updated ${info.params.length} parameter values`, 'success');
      } else {
        Utils.showToast('Could not detect parameters. Values kept from defaults.', 'info');
      }
    } catch (err) {
      Utils.showToast('Detection failed: ' + err.message, 'error');
    }
  }

  // =========================================================================
  //  Optimization
  // =========================================================================

  async function startOptimization() {
    const unlockedParams = parameters.filter(p => !p.locked);
    const validUnlockedParams = unlockedParams.filter(p => p.start && p.end && p.step);

    if (unlockedParams.length === 0) {
      Utils.showToast('Unlock at least one parameter to optimize', 'error');
      return;
    }

    if (validUnlockedParams.length !== unlockedParams.length) {
      Utils.showToast('Please set min, max, and step for all unlocked parameters', 'error');
      return;
    }

    // Build the full param set: unlocked ones get optimized, locked ones get their fixed value
    const lockedParams = parameters.filter(p => p.locked);

    const metric = $('#opt-metric').value;
    const delay = parseInt($('#opt-delay').value) || 1500;
    const infoText = $('#strategy-info .info-label').textContent;
    const parts = infoText.split(' · ');

    const config = {
      metric,
      delay,
      maxTabs: settings.maxTabs || 1,
      strategyName: parts[0] || 'Unknown Strategy',
      symbol: parts[1] || 'N/A',
      interval: parts[2] || 'N/A',
      lockedParams: lockedParams.map(p => ({
        name: p.name,
        index: p.inputIndex,
        value: p.fixedValue,
      })),
    };

    $('#progress-section').style.display = 'block';
    $('#btn-optimize').style.display = 'none';
    $('#btn-stop').style.display = 'flex';

    try {
      await Optimizer.start(unlockedParams, config, {
        onProgress: (progress) => {
          $('#progress-bar').style.width = progress.percent.toFixed(1) + '%';
          $('#progress-text').textContent = `${progress.completed} / ${progress.total}`;
          $('#progress-eta').textContent = `ETA: ${Utils.formatDuration(progress.eta)}`;
          $('#progress-speed').textContent = `${progress.speed} it/s`;

          if (progress.bestResult) {
            $('#current-best').style.display = 'block';
            const bv = progress.bestResult[metric + '_num'] ?? progress.bestResult[metric];
            $('#best-value').textContent = `${Utils.formatNumber(bv)} (${progress.bestResult.params.join(', ')})`;
          }
        },
        onComplete: (report) => {
          Utils.showToast(
            report.stopped
              ? `Stopped. ${report.completedCombinations} results saved.`
              : `Done! ${report.totalCombinations} combos in ${Utils.formatDuration(report.duration)}`,
            'success'
          );
          resetOptimizationUI();
        },
        onError: (error) => {
          Utils.showToast('Error: ' + error.message, 'error');
          resetOptimizationUI();
        },
      });
    } catch (err) {
      Utils.showToast('Error: ' + err.message, 'error');
      resetOptimizationUI();
    }
  }

  function stopOptimization() {
    Optimizer.stop();
    Utils.showToast('Stopping...', 'info');
  }

  function resetOptimizationUI() {
    $('#progress-section').style.display = 'none';
    $('#btn-optimize').style.display = 'flex';
    $('#btn-stop').style.display = 'none';
    $('#progress-bar').style.width = '0%';
    $('#current-best').style.display = 'none';
  }

  // =========================================================================
  //  Reports
  // =========================================================================

  async function loadReportsList() {
    const index = await Storage.getReportsIndex();
    const container = $('#reports-list');
    const empty = $('#reports-empty');
    const q = ($('#report-search').value || '').toLowerCase();

    let filtered = index;
    if (q) {
      filtered = index.filter(r =>
        r.strategyName.toLowerCase().includes(q) ||
        r.symbol.toLowerCase().includes(q)
      );
    }

    if (filtered.length === 0) {
      container.innerHTML = '';
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    container.innerHTML = filtered.map(r => {
      const date = new Date(r.date).toLocaleDateString();
      const bestVal = r.bestMetricValue != null ? Utils.formatNumber(r.bestMetricValue) : 'N/A';
      const pos = r.bestMetricValue != null && r.bestMetricValue > 0;
      return `
        <div class="report-card" data-id="${r.id}">
          <div class="report-card-info">
            <div class="report-card-title">${r.strategyName}</div>
            <div class="report-card-meta">${r.symbol} · ${r.interval} · ${date} · ${r.completedCombinations} combos · ${Utils.formatDuration(r.duration)}</div>
          </div>
          <div class="report-card-stats">
            <div class="report-stat">
              <span class="report-stat-label">Best ${ResultTable.METRIC_LABELS[r.optimizeMetric] || r.optimizeMetric}</span>
              <span class="report-stat-value ${pos ? 'positive' : 'negative'}">${bestVal}</span>
            </div>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.report-card').forEach(card => {
      card.addEventListener('click', () => openReportDetail(card.dataset.id));
    });
  }

  async function openReportDetail(reportId) {
    const report = await Storage.getReport(reportId);
    if (!report) { Utils.showToast('Report not found', 'error'); return; }

    currentReportId = reportId;
    showReportDetail();

    const summary = $('#report-summary');
    const best = report.bestMetricValue;
    const bestFmt = best != null ? Utils.formatNumber(best) : 'N/A';
    const pos = best != null && best > 0;

    summary.innerHTML = `
      <div class="summary-card">
        <div class="summary-card-label">Best ${ResultTable.METRIC_LABELS[report.optimizeMetric] || report.optimizeMetric}</div>
        <div class="summary-card-value ${pos ? 'positive' : 'negative'}">${bestFmt}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">Combinations</div>
        <div class="summary-card-value">${report.completedCombinations}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">Duration</div>
        <div class="summary-card-value">${Utils.formatDuration(report.duration)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">Strategy</div>
        <div class="summary-card-value" style="font-size:10px;">${report.strategyName}</div>
      </div>`;

    ResultTable.init(report, settings.pageSize);
    bindTableEvents();
  }

  function bindTableEvents() {
    $('#result-thead').addEventListener('click', (e) => {
      const th = e.target.closest('th');
      if (th && th.dataset.col) ResultTable.sortBy(th.dataset.col);
    });

    const tableSearch = $('#table-search');
    tableSearch.value = '';
    tableSearch.addEventListener('input', Utils.debounce(() => {
      ResultTable.setSearch(tableSearch.value);
    }, 200));

    $('#table-sort-col').addEventListener('change', (e) => {
      if (e.target.value) ResultTable.sortBy(e.target.value);
    });

    $('#btn-sort-dir').addEventListener('click', () => {
      ResultTable.sortDirection = ResultTable.sortDirection === 'asc' ? 'desc' : 'asc';
      $('#btn-sort-dir').textContent = ResultTable.sortDirection === 'asc' ? '↑' : '↓';
      ResultTable.applyFilterAndSort();
      ResultTable.render();
    });

    $('#toggle-heatmap').addEventListener('change', (e) => {
      ResultTable.toggleHeatmap(e.target.checked);
    });

    $('#table-pagination').addEventListener('click', (e) => {
      const btn = e.target.closest('.page-btn');
      if (btn) ResultTable.goToPage(parseInt(btn.dataset.page));
    });
  }

  // =========================================================================
  //  Event bindings
  // =========================================================================

  $('#btn-add-param').addEventListener('click', addParameter);

  $('#btn-reset-params').addEventListener('click', () => {
    initParameters();
  });

  $('#btn-detect').addEventListener('click', detectStrategy);
  $('#btn-optimize').addEventListener('click', startOptimization);
  $('#btn-stop').addEventListener('click', stopOptimization);

  $('#btn-test-scrape').addEventListener('click', async () => {
    try {
      const tvTab = await getTVTab();
      if (!tvTab) { Utils.showToast('No TradingView tab found', 'error'); return; }
      const result = await sendToTab(tvTab.id, { type: 'DEBUG_SCRAPE' });
      const output = $('#scrape-output');
      output.style.display = 'block';
      if (result && Object.keys(result).length > 0) {
        output.textContent = JSON.stringify(result, null, 2);
        Utils.showToast(`Found ${Object.keys(result).length} metrics`, 'success');
      } else {
        output.textContent = 'No metrics found. Make sure the Strategy Tester panel is open at the bottom of the chart.';
        Utils.showToast('No metrics found', 'error');
      }
    } catch (err) {
      const output = $('#scrape-output');
      output.style.display = 'block';
      output.textContent = 'Error: ' + err.message;
      Utils.showToast('Scrape failed: ' + err.message, 'error');
    }
  });

  $('#btn-debug-dom').addEventListener('click', async () => {
    try {
      const tvTab = await getTVTab();
      if (!tvTab) { Utils.showToast('No TradingView tab found', 'error'); return; }
      const result = await sendToTab(tvTab.id, { type: 'DEBUG_DOM' });
      const output = $('#scrape-output');
      output.style.display = 'block';
      output.textContent = JSON.stringify(result, null, 2);
      if (!result || !result.foundTexts || result.foundTexts.length === 0) {
        Utils.showToast('No strategy text found in DOM — metrics may be in an iframe', 'error');
      } else {
        Utils.showToast(`Found ${result.foundTexts.length} matching text nodes`, 'success');
      }
    } catch (err) {
      const output = $('#scrape-output');
      output.style.display = 'block';
      output.textContent = 'Error: ' + err.message;
    }
  });
  $('#opt-delay').addEventListener('input', updateCombinationCount);
  $('#report-search').addEventListener('input', Utils.debounce(loadReportsList, 200));

  $('#btn-back-reports').addEventListener('click', () => { showTab('reports'); loadReportsList(); });

  $('#btn-export-csv').addEventListener('click', () => {
    Utils.downloadFile(ResultTable.exportCSV(), `stratoptimizer-${currentReportId}.csv`);
    Utils.showToast('CSV exported', 'success');
  });

  $('#btn-export-json').addEventListener('click', () => {
    Utils.downloadFile(ResultTable.exportJSON(), `stratoptimizer-${currentReportId}.json`, 'application/json');
    Utils.showToast('JSON exported', 'success');
  });

  $('#btn-delete-report').addEventListener('click', async () => {
    if (!currentReportId) return;
    await Storage.deleteReport(currentReportId);
    Utils.showToast('Report deleted', 'success');
    showTab('reports'); loadReportsList();
  });

  $('#btn-export-all').addEventListener('click', async () => {
    const index = await Storage.getReportsIndex();
    const all = [];
    for (const entry of index) {
      const r = await Storage.getReport(entry.id);
      if (r) all.push(r);
    }
    Utils.downloadFile(JSON.stringify(all, null, 2), 'stratoptimizer-all-reports.json', 'application/json');
    Utils.showToast('All reports exported', 'success');
  });

  $('#btn-clear-reports').addEventListener('click', async () => {
    if (!confirm('Delete all optimization reports? This cannot be undone.')) return;
    await Storage.clearAllReports();
    Utils.showToast('All reports cleared', 'success');
    loadReportsList();
  });

  // --- Settings ---
  $('#setting-delay').value = settings.defaultDelay;
  $('#setting-max-tabs').value = settings.maxTabs;
  $('#setting-autosave').checked = settings.autoSave;
  $('#setting-notifications').checked = settings.notifications;
  $('#setting-page-size').value = settings.pageSize;
  $('#opt-delay').value = settings.defaultDelay;

  $('#btn-save-settings').addEventListener('click', async () => {
    settings = {
      defaultDelay: parseInt($('#setting-delay').value) || 1500,
      maxTabs: parseInt($('#setting-max-tabs').value) || 1,
      autoSave: $('#setting-autosave').checked,
      notifications: $('#setting-notifications').checked,
      pageSize: parseInt($('#setting-page-size').value) || 50,
    };
    await Storage.saveSettings(settings);
    $('#opt-delay').value = settings.defaultDelay;
    Utils.showToast('Settings saved', 'success');
  });

  // --- Init ---
  initParameters();

})();
