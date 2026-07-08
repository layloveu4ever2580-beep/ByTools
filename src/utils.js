/**
 * StratOptimizer - Utility Functions
 */

const Utils = {
  /**
   * Generate all parameter combinations using cartesian product
   * Uses iterative approach for speed over recursive
   */
  generateCombinations(params) {
    const ranges = params.map(p => {
      const values = [];
      const start = parseFloat(p.start);
      const end = parseFloat(p.end);
      const step = parseFloat(p.step);
      if (isNaN(start) || isNaN(end) || isNaN(step) || step <= 0 || start > end) return [];
      // Use integer math to avoid floating point issues
      const precision = Math.max(
        Utils.getDecimalPlaces(p.start),
        Utils.getDecimalPlaces(p.step)
      );
      const multiplier = Math.pow(10, precision);
      const iStart = Math.round(start * multiplier);
      const iEnd = Math.round(end * multiplier);
      const iStep = Math.round(step * multiplier);
      for (let i = iStart; i <= iEnd; i += iStep) {
        values.push(parseFloat((i / multiplier).toFixed(precision)));
      }
      return values;
    });

    // Cartesian product - iterative for performance
    let combos = [[]];
    for (const range of ranges) {
      if (range.length === 0) return []; // If any dimension is empty, there are no combinations
      const newCombos = [];
      for (const combo of combos) {
        for (const val of range) {
          newCombos.push([...combo, val]);
        }
      }
      combos = newCombos;
    }
    return combos;
  },

  getDecimalPlaces(numStr) {
    const str = String(numStr);
    const dotIndex = str.indexOf('.');
    return dotIndex === -1 ? 0 : str.length - dotIndex - 1;
  },

  /**
   * Format number with appropriate precision
   */
  formatNumber(val, decimals = 2) {
    if (val === null || val === undefined || val === '' || val === 'N/A') return 'N/A';
    const num = parseFloat(val);
    if (isNaN(num)) return String(val);
    if (Math.abs(num) >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (Math.abs(num) >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toFixed(decimals);
  },

  /**
   * Format duration in human readable form
   */
  formatDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (minutes < 60) return minutes + 'm ' + secs + 's';
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return hours + 'h ' + mins + 'm';
  },

  /**
   * Estimate total optimization time
   */
  estimateTime(combinationCount, delayMs) {
    return combinationCount * delayMs;
  },

  /**
   * Create a unique report ID
   */
  generateReportId() {
    return 'report-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
  },

  /**
   * Show toast notification
   */
  showToast(message, type = 'info', duration = 3000) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  /**
   * Parse a metric value from TradingView strategy tester
   */
  parseMetricValue(text) {
    if (!text || text === '—' || text === 'N/A') return null;
    // Remove currency symbols, commas, percentage signs, whitespace
    const cleaned = text.replace(/[$€£¥,\s%]/g, '').trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  },

  /**
   * Determine if higher is better for a given metric
   */
  isHigherBetter(metric) {
    const lowerIsBetter = ['maxDrawdown'];
    return !lowerIsBetter.includes(metric);
  },

  /**
   * Convert results to CSV string
   */
  toCSV(headers, rows) {
    const escape = (val) => {
      const str = String(val ?? '');
      return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [headers.map(escape).join(',')];
    for (const row of rows) {
      lines.push(headers.map((_, i) => escape(row[i] ?? '')).join(','));
    }
    return lines.join('\n');
  },

  /**
   * Download a string as a file
   */
  downloadFile(content, filename, mimeType = 'text/csv') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  /**
   * Debounce function
   */
  debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }
};
