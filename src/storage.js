/**
 * StratOptimizer - Hybrid Storage Layer
 * 
 * IndexedDB for bulk result data (batched writes, concurrent reads)
 * chrome.storage.local for small config (settings, params, report index)
 * 
 * Write buffer flushes every 500ms or 10 results — whichever comes first.
 * All result rows go into a single object store with a compound index
 * on (reportId, index) for fast range queries.
 */

const Storage = {
  DB_NAME: 'StratOptimizerDB',
  DB_VERSION: 1,
  STORE_RESULTS: 'results',
  STORE_REPORTS: 'reports',

  KEYS: {
    REPORTS_INDEX: 'strat-reports-index',
    PARAMS_PREFIX: 'strat-params-',
    SETTINGS: 'strat-settings',
  },

  DEFAULT_SETTINGS: {
    defaultDelay: 1500,
    maxTabs: 1,
    autoSave: true,
    notifications: true,
    pageSize: 50,
  },

  // --- Write buffer state ---
  _db: null,
  _writeBuffer: [],          // pending result rows
  _flushTimer: null,
  _flushInterval: 500,       // ms
  _flushThreshold: 10,       // rows

  // =========================================================================
  //  IndexedDB bootstrap
  // =========================================================================

  /** Open (or create) the database. Cached after first call. */
  async getDB() {
    if (this._db) return this._db;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        // results store — one row per iteration
        if (!db.objectStoreNames.contains(this.STORE_RESULTS)) {
          const store = db.createObjectStore(this.STORE_RESULTS, { keyPath: 'id', autoIncrement: true });
          store.createIndex('byReport', 'reportId', { unique: false });
          store.createIndex('byReportIndex', ['reportId', 'index'], { unique: false });
        }

        // reports store — report metadata (no result rows)
        if (!db.objectStoreNames.contains(this.STORE_REPORTS)) {
          db.createObjectStore(this.STORE_REPORTS, { keyPath: 'id' });
        }
      };

      req.onsuccess = (e) => {
        this._db = e.target.result;
        resolve(this._db);
      };

      req.onerror = (e) => reject(e.target.error);
    });
  },

  // =========================================================================
  //  Buffered result writer
  // =========================================================================

  /** Queue a single result row. Flushes automatically. */
  bufferResult(reportId, row) {
    this._writeBuffer.push({ reportId, ...row });

    if (this._writeBuffer.length >= this._flushThreshold) {
      this.flushResults();
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this.flushResults(), this._flushInterval);
    }
  },

  /** Flush all buffered rows in one IndexedDB transaction. */
  async flushResults() {
    clearTimeout(this._flushTimer);
    this._flushTimer = null;

    const batch = this._writeBuffer.splice(0);   // drain
    if (batch.length === 0) return;

    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_RESULTS, 'readwrite');
      const store = tx.objectStore(this.STORE_RESULTS);

      for (const row of batch) {
        store.put(row);                           // prepared-statement equivalent
      }

      tx.oncomplete = () => resolve();
      tx.onerror = (e) => {
        console.error('Flush failed, re-queuing', e.target.error);
        this._writeBuffer.unshift(...batch);      // put them back
        reject(e.target.error);
      };
    });
  },

  /** Force-flush (call before building final report). */
  async forceFlush() {
    await this.flushResults();
  },

  // =========================================================================
  //  Report CRUD  (metadata in IndexedDB, index mirror in chrome.storage)
  // =========================================================================

  async saveReportMeta(report) {
    const db = await this.getDB();

    // Strip heavy result rows — they live in the results store
    const meta = { ...report };
    delete meta.results;

    await new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_REPORTS, 'readwrite');
      tx.objectStore(this.STORE_REPORTS).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });

    // Also update the lightweight chrome.storage index for fast popup listing
    const index = await this.getReportsIndex();
    index.unshift({
      id: report.id,
      strategyName: report.strategyName,
      symbol: report.symbol,
      interval: report.interval,
      date: report.date,
      totalCombinations: report.totalCombinations,
      completedCombinations: report.completedCombinations,
      bestMetricValue: report.bestMetricValue,
      optimizeMetric: report.optimizeMetric,
      duration: report.duration,
    });
    await chrome.storage.local.set({ [this.KEYS.REPORTS_INDEX]: index });
  },

  /** Read report metadata (no result rows). */
  async getReportMeta(reportId) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_REPORTS, 'readonly');
      const req = tx.objectStore(this.STORE_REPORTS).get(reportId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  /** Read all result rows for a report. Uses index range scan. */
  async getReportResults(reportId) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_RESULTS, 'readonly');
      const idx = tx.objectStore(this.STORE_RESULTS).index('byReport');
      const req = idx.getAll(IDBKeyRange.only(reportId));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  /** Convenience: get full report (meta + results merged). */
  async getReport(reportId) {
    const [meta, results] = await Promise.all([
      this.getReportMeta(reportId),
      this.getReportResults(reportId),
    ]);
    if (!meta) return null;
    meta.results = results;
    return meta;
  },

  async deleteReport(reportId) {
    const db = await this.getDB();

    // Delete results
    await new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_RESULTS, 'readwrite');
      const store = tx.objectStore(this.STORE_RESULTS);
      const idx = store.index('byReport');
      const req = idx.openCursor(IDBKeyRange.only(reportId));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });

    // Delete meta
    await new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_REPORTS, 'readwrite');
      tx.objectStore(this.STORE_REPORTS).delete(reportId);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });

    // Update chrome.storage index
    const index = await this.getReportsIndex();
    const filtered = index.filter(r => r.id !== reportId);
    await chrome.storage.local.set({ [this.KEYS.REPORTS_INDEX]: filtered });
  },

  async clearAllReports() {
    const db = await this.getDB();

    await new Promise((resolve, reject) => {
      const tx = db.transaction([this.STORE_RESULTS, this.STORE_REPORTS], 'readwrite');
      tx.objectStore(this.STORE_RESULTS).clear();
      tx.objectStore(this.STORE_REPORTS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });

    await chrome.storage.local.remove(this.KEYS.REPORTS_INDEX);
  },

  // =========================================================================
  //  Lightweight chrome.storage helpers (settings, params, report index)
  // =========================================================================

  async getReportsIndex() {
    const result = await chrome.storage.local.get(this.KEYS.REPORTS_INDEX);
    return result[this.KEYS.REPORTS_INDEX] || [];
  },

  async getSettings() {
    const result = await chrome.storage.local.get(this.KEYS.SETTINGS);
    return { ...this.DEFAULT_SETTINGS, ...(result[this.KEYS.SETTINGS] || {}) };
  },

  async saveSettings(settings) {
    await chrome.storage.local.set({ [this.KEYS.SETTINGS]: settings });
  },

  async getParams(strategyKey) {
    const key = this.KEYS.PARAMS_PREFIX + strategyKey;
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  },

  async saveParams(strategyKey, params) {
    const key = this.KEYS.PARAMS_PREFIX + strategyKey;
    await chrome.storage.local.set({ [key]: params });
  },
};
