/**
 * StratOptimizer - Core Optimization Engine (v2 — fast path)
 *
 * Speed improvements over v1:
 *   1. Talks to a persistent content script via chrome.tabs.sendMessage
 *      instead of chrome.scripting.executeScript per iteration
 *      (~80ms round-trip overhead eliminated)
 *   2. Content script sets values via native setter in one synchronous pass
 *      (~50ms vs ~500ms keyboard simulation)
 *   3. MutationObserver detects recalculation end instead of blind setTimeout
 *   4. Results are buffered in memory and flushed to IndexedDB in batches
 *      (every 500ms or 10 rows — single transaction with put())
 *   5. Progress callbacks are throttled to 200ms to avoid UI jank
 */

const Optimizer = {
  isRunning: false,
  shouldStop: false,
  currentTabId: null,
  startTime: null,
  completedCount: 0,
  totalCount: 0,
  results: [],            // in-memory mirror for best-result tracking
  onProgress: null,
  onComplete: null,
  onError: null,
  onResult: null,        // optional: called with each result row (remote streaming)
  _lastProgressUpdate: 0,

  /**
   * Send a message to the content script in the TradingView tab.
   * Returns the response or throws on error.
   */
  _sendToContent(message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(this.currentTabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  },

  /**
   * Start optimization
   */
  async start(params, config, callbacks) {
    if (this.isRunning) throw new Error('Optimization already running');

    this.isRunning = true;
    this.shouldStop = false;
    this.results = [];
    this.completedCount = 0;
    this._lastProgressUpdate = 0;
    this.onProgress = callbacks.onProgress;
    this.onComplete = callbacks.onComplete;
    this.onError = callbacks.onError;
    this.onResult = callbacks.onResult;

    const combinations = Utils.generateCombinations(params);
    this.totalCount = combinations.length;
    this.startTime = Date.now();

    if (combinations.length === 0) {
      this.isRunning = false;
      throw new Error('No valid parameter combinations generated');
    }

    const reportId = Utils.generateReportId();

    try {
      // --- Find TradingView tabs ---
      const tabs = await chrome.tabs.query({ url: 'https://*.tradingview.com/*' });
      if (tabs.length === 0) throw new Error('No TradingView tab found. Open TradingView first.');

      const maxTabs = config.maxTabs || 1;
      const workerTabs = [];

      for (const t of tabs) {
        if (workerTabs.length >= maxTabs) break;
        try {
          const prep = await new Promise((resolve) => {
            chrome.tabs.sendMessage(t.id, { type: 'PREPARE_RUN' }, (resp) => {
              if (chrome.runtime.lastError) resolve({ ok: false });
              else resolve(resp);
            });
          });
          if (prep && prep.ok) {
            workerTabs.push(t.id);
          }
        } catch (e) {}
      }

      if (workerTabs.length === 0) {
        throw new Error('No TradingView tab with Strategy Tester settings dialog found.');
      }

      let nextComboIndex = 0;
      let activeWorkers = 0;

      // --- Main worker pool loop ---
      await new Promise((resolveAll) => {
        const runWorker = async (tabId) => {
          while (nextComboIndex < combinations.length && !this.shouldStop) {
            const i = nextComboIndex++;
            const combo = combinations[i];
            
            const paramValues = params.map((p, idx) => ({
              name: p.name,
              index: p.inputIndex,
              value: combo[idx],
            }));

            // Also include locked params so ALL values are set each iteration
            if (config.lockedParams) {
              for (const lp of config.lockedParams) {
                paramValues.push({
                  name: lp.name,
                  index: lp.index,
                  value: lp.value,
                });
              }
            }

            let iterResult;
            try {
              iterResult = await new Promise((resolve, reject) => {
                chrome.tabs.sendMessage(tabId, {
                  type: 'RUN_ITERATION',
                  paramValues,
                  maxWait: config.delay,
                }, (resp) => {
                  if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                  else if (resp && resp.error) reject(new Error(resp.error));
                  else resolve(resp);
                });
              });
            } catch (err) {
              iterResult = { error: err.message };
            }

            // Build row
            const row = {
              reportId,
              index: i + 1,
              params: combo,
              paramNames: params.map(p => p.name),
              ...iterResult,
            };

            // In-memory for best-tracking
            this.results.push(row);

            // Buffer to IndexedDB (batched write)
            Storage.bufferResult(reportId, row);

            // Optional: stream this row to a remote consumer (Option 1 runner)
            if (this.onResult) { try { this.onResult(row); } catch (_) {} }

            this.completedCount++;

            // Throttled progress callback (every 200ms max)
            const now = Date.now();
            if (now - this._lastProgressUpdate >= 200 || this.completedCount === this.totalCount) {
              this._lastProgressUpdate = now;
              const elapsed = now - this.startTime;
              const avgTime = elapsed / this.completedCount;
              const remaining = (this.totalCount - this.completedCount) * avgTime;

              if (this.onProgress) {
                this.onProgress({
                  completed: this.completedCount,
                  total: this.totalCount,
                  percent: (this.completedCount / this.totalCount) * 100,
                  elapsed,
                  eta: remaining,
                  speed: (this.completedCount / (elapsed / 1000)).toFixed(2),
                  bestResult: this.getBestResult(config.metric),
                });
              }
            }
          }
          activeWorkers--;
          if (activeWorkers === 0) resolveAll();
        };

        for (const tid of workerTabs) {
          activeWorkers++;
          runWorker(tid);
        }
      });

      // --- Flush remaining buffered writes ---
      await Storage.forceFlush();

      // --- Build & save report metadata ---
      const duration = Date.now() - this.startTime;
      const best = this.getBestResult(config.metric);

      const report = {
        id: reportId,
        strategyName: config.strategyName || 'Unknown Strategy',
        symbol: config.symbol || 'N/A',
        interval: config.interval || 'N/A',
        date: new Date().toISOString(),
        optimizeMetric: config.metric,
        totalCombinations: this.totalCount,
        completedCombinations: this.completedCount,
        duration,
        parameters: params.map(p => ({ name: p.name, start: p.start, end: p.end, step: p.step })),
        bestMetricValue: best ? best[config.metric + '_num'] ?? best[config.metric] : null,
        bestParams: best ? best.params : null,
        stopped: this.shouldStop,
      };

      await Storage.saveReportMeta(report);

      if (this.onComplete) this.onComplete(report);

      // Notification
      try {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'StratOptimizer',
          message: this.shouldStop
            ? `Stopped. ${this.completedCount}/${this.totalCount} completed.`
            : `Done! ${this.totalCount} combos in ${Utils.formatDuration(duration)}.`,
        });
      } catch (_) {}

    } catch (error) {
      // Flush whatever we have so partial results aren't lost
      try { await Storage.forceFlush(); } catch (_) {}
      if (this.onError) this.onError(error);
    } finally {
      this.isRunning = false;
      this.shouldStop = false;
    }
  },

  /**
   * Best result from in-memory array
   */
  getBestResult(metric) {
    if (this.results.length === 0) return null;
    const numKey = metric + '_num';
    const higherBetter = Utils.isHigherBetter(metric);
    let best = null;
    for (const r of this.results) {
      if (r.error || r[numKey] == null) continue;
      if (!best || (higherBetter ? r[numKey] > best[numKey] : r[numKey] < best[numKey])) {
        best = r;
      }
    }
    return best;
  },

  stop() {
    this.shouldStop = true;
  },
};
