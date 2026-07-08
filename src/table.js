/**
 * StratOptimizer - Professional Result Table Engine
 * Handles sorting, filtering, pagination, heatmaps, and export
 */

const ResultTable = {
  data: [],
  filteredData: [],
  columns: [],
  paramNames: [],
  metricColumns: [],
  sortColumn: null,
  sortDirection: 'desc',
  currentPage: 1,
  pageSize: 50,
  heatmapEnabled: false,
  optimizeMetric: 'netProfit',
  searchQuery: '',

  METRIC_LABELS: {
    netProfit: 'Net Profit',
    totalTrades: 'Total Trades',
    percentProfitable: '% Profitable',
    profitFactor: 'Profit Factor',
    maxDrawdown: 'Max Drawdown',
    sharpeRatio: 'Sharpe Ratio',
    sortinoRatio: 'Sortino Ratio',
    avgTrade: 'Avg Trade',
    avgBarsInTrade: 'Avg Bars',
  },

  /**
   * Initialize table with report data
   */
  init(report, pageSize = 50) {
    this.pageSize = pageSize;
    this.currentPage = 1;
    this.optimizeMetric = report.optimizeMetric;
    this.sortColumn = report.optimizeMetric;
    this.sortDirection = Utils.isHigherBetter(report.optimizeMetric) ? 'desc' : 'asc';

    // Extract param names
    this.paramNames = report.parameters.map(p => p.name);

    // Determine which metric columns have data
    this.metricColumns = [];
    const metricKeys = Object.keys(this.METRIC_LABELS);
    for (const key of metricKeys) {
      const hasData = report.results.some(r => r[key] !== undefined && r[key] !== null);
      if (hasData) this.metricColumns.push(key);
    }

    // Build column definitions
    this.columns = [
      { key: '#', label: '#', type: 'index' },
      ...this.paramNames.map((name, i) => ({ key: `param_${i}`, label: name, type: 'param' })),
      ...this.metricColumns.map(key => ({ key, label: this.METRIC_LABELS[key], type: 'metric' })),
    ];

    // Transform data into flat rows
    this.data = report.results.map((r, idx) => {
      const row = { _index: idx + 1, _original: r };
      this.paramNames.forEach((_, i) => {
        row[`param_${i}`] = r.params[i];
      });
      for (const key of this.metricColumns) {
        row[key] = r[key + '_num'] ?? Utils.parseMetricValue(r[key]);
        row[key + '_display'] = r[key] || 'N/A';
      }
      row._error = r.error || null;
      return row;
    });

    this.applyFilterAndSort();
    this.render();
    this.renderSortOptions();
  },

  /**
   * Apply search filter and sort
   */
  applyFilterAndSort() {
    let data = [...this.data];

    // Filter by search
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      data = data.filter(row => {
        // Search in params
        for (let i = 0; i < this.paramNames.length; i++) {
          if (String(row[`param_${i}`]).includes(q)) return true;
        }
        // Search in metrics
        for (const key of this.metricColumns) {
          if (String(row[key + '_display']).toLowerCase().includes(q)) return true;
        }
        return false;
      });
    }

    // Sort
    if (this.sortColumn) {
      const col = this.sortColumn;
      const dir = this.sortDirection === 'asc' ? 1 : -1;
      data.sort((a, b) => {
        let va = a[col];
        let vb = b[col];
        if ((va === null || va === undefined) && (vb === null || vb === undefined)) return 0;
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
    }

    this.filteredData = data;
    this.currentPage = 1;
  },

  /**
   * Render the table
   */
  render() {
    const thead = document.getElementById('result-thead');
    const tbody = document.getElementById('result-tbody');
    if (!thead || !tbody) return;

    // Header
    thead.innerHTML = '<tr>' + this.columns.map(col => {
      const isSorted = this.sortColumn === col.key;
      const arrow = isSorted ? (this.sortDirection === 'asc' ? '↑' : '↓') : '';
      const cls = isSorted ? 'sorted' : '';
      return `<th class="${cls}" data-col="${col.key}">${col.label} <span class="sort-arrow">${arrow}</span></th>`;
    }).join('') + '</tr>';

    // Body - paginated
    const start = (this.currentPage - 1) * this.pageSize;
    const end = Math.min(start + this.pageSize, this.filteredData.length);
    const pageData = this.filteredData.slice(start, end);

    // Calculate heatmap ranges if enabled
    let heatmapRanges = {};
    if (this.heatmapEnabled) {
      for (const key of this.metricColumns) {
        const values = this.filteredData.map(r => r[key]).filter(v => v !== null && v !== undefined);
        if (values.length > 0) {
          heatmapRanges[key] = {
            min: Math.min(...values),
            max: Math.max(...values),
          };
        }
      }
    }

    // Find best row
    const bestIdx = this.findBestRowIndex();

    tbody.innerHTML = pageData.map((row, pageIdx) => {
      const globalIdx = start + pageIdx;
      const isBest = globalIdx === bestIdx;
      const rowClass = isBest ? 'best-row' : '';

      const cells = this.columns.map(col => {
        if (col.type === 'index') {
          return `<td>${row._index}</td>`;
        }
        if (col.type === 'param') {
          return `<td>${row[col.key]}</td>`;
        }
        // Metric cell
        const val = row[col.key];
        const display = row[col.key + '_display'] || Utils.formatNumber(val);
        let heatClass = '';
        if (this.heatmapEnabled && val !== null && val !== undefined && heatmapRanges[col.key]) {
          heatClass = this.getHeatmapClass(val, heatmapRanges[col.key], col.key);
        }
        return `<td class="${heatClass}">${display}</td>`;
      }).join('');

      return `<tr class="${rowClass}">${cells}</tr>`;
    }).join('');

    // Pagination
    this.renderPagination();
  },

  /**
   * Find the index of the best row in filtered data
   */
  findBestRowIndex() {
    const metric = this.optimizeMetric;
    const higherBetter = Utils.isHigherBetter(metric);
    let bestIdx = -1;
    let bestVal = null;

    this.filteredData.forEach((row, idx) => {
      const val = row[metric];
      if (val === null || val === undefined) return;
      if (bestVal === null || (higherBetter ? val > bestVal : val < bestVal)) {
        bestVal = val;
        bestIdx = idx;
      }
    });

    return bestIdx;
  },

  /**
   * Get heatmap CSS class for a value
   */
  getHeatmapClass(value, range, metricKey) {
    if (range.max === range.min) return 'heatmap-neutral';
    const normalized = (value - range.min) / (range.max - range.min);
    const higherBetter = Utils.isHigherBetter(metricKey);
    const score = higherBetter ? normalized : 1 - normalized;

    if (score >= 0.8) return 'heatmap-best';
    if (score >= 0.6) return 'heatmap-good';
    if (score >= 0.4) return 'heatmap-neutral';
    if (score >= 0.2) return 'heatmap-bad';
    return 'heatmap-worst';
  },

  /**
   * Render sort dropdown options
   */
  renderSortOptions() {
    const select = document.getElementById('table-sort-col');
    if (!select) return;
    select.innerHTML = '<option value="">Sort by...</option>' +
      this.columns.filter(c => c.type !== 'index').map(c =>
        `<option value="${c.key}" ${c.key === this.sortColumn ? 'selected' : ''}>${c.label}</option>`
      ).join('');
  },

  /**
   * Render pagination controls
   */
  renderPagination() {
    const container = document.getElementById('table-pagination');
    if (!container) return;

    const totalPages = Math.ceil(this.filteredData.length / this.pageSize);
    if (totalPages <= 1) {
      container.innerHTML = `<span>${this.filteredData.length} results</span>`;
      return;
    }

    const start = (this.currentPage - 1) * this.pageSize + 1;
    const end = Math.min(this.currentPage * this.pageSize, this.filteredData.length);

    let btns = '';
    const maxVisible = 5;
    let startPage = Math.max(1, this.currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) {
      startPage = Math.max(1, endPage - maxVisible + 1);
    }

    if (startPage > 1) btns += `<button class="page-btn" data-page="1">1</button>`;
    if (startPage > 2) btns += `<span>...</span>`;

    for (let i = startPage; i <= endPage; i++) {
      btns += `<button class="page-btn ${i === this.currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }

    if (endPage < totalPages - 1) btns += `<span>...</span>`;
    if (endPage < totalPages) btns += `<button class="page-btn" data-page="${totalPages}">${totalPages}</button>`;

    container.innerHTML = `
      <span>${start}-${end} of ${this.filteredData.length}</span>
      <div class="pagination-btns">${btns}</div>
    `;
  },

  /**
   * Sort by column
   */
  sortBy(colKey) {
    if (this.sortColumn === colKey) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortColumn = colKey;
      this.sortDirection = 'desc';
    }
    this.applyFilterAndSort();
    this.render();
  },

  /**
   * Set search filter
   */
  setSearch(query) {
    this.searchQuery = query;
    this.applyFilterAndSort();
    this.render();
  },

  /**
   * Toggle heatmap
   */
  toggleHeatmap(enabled) {
    this.heatmapEnabled = enabled;
    this.render();
  },

  /**
   * Go to page
   */
  goToPage(page) {
    this.currentPage = page;
    this.render();
  },

  /**
   * Export current view as CSV
   */
  exportCSV() {
    const headers = this.columns.map(c => c.label);
    const rows = this.filteredData.map(row =>
      this.columns.map(col => {
        if (col.type === 'index') return row._index;
        if (col.type === 'param') return row[col.key];
        return row[col.key + '_display'] || row[col.key] || '';
      })
    );
    return Utils.toCSV(headers, rows);
  },

  /**
   * Export current view as JSON
   */
  exportJSON() {
    return JSON.stringify(this.filteredData.map(row => {
      const obj = { index: row._index };
      this.paramNames.forEach((name, i) => { obj[name] = row[`param_${i}`]; });
      this.metricColumns.forEach(key => { obj[key] = row[key]; });
      return obj;
    }), null, 2);
  },
};
