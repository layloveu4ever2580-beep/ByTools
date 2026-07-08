/**
 * StratOptimizer - Content Script v4
 * 
 * Key change: Instead of clicking OK (which closes the dialog),
 * we set input values and press Enter to trigger recalculation
 * while keeping the dialog open.
 */

(function () {
  'use strict';

  let cachedDialog = null;
  let cachedInputs = [];
  let inputSetter = null;

  try {
    inputSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
  } catch (_) {}

  const METRIC_PATTERNS = [
    { key: 'netProfit',          patterns: ['net profit', 'net p/l'] },
    { key: 'totalTrades',       patterns: ['total closed trades', 'total trades'] },
    { key: 'percentProfitable', patterns: ['percent profitable', 'win rate'] },
    { key: 'profitFactor',      patterns: ['profit factor'] },
    { key: 'maxDrawdown',       patterns: ['max drawdown', 'maximum drawdown'] },
    { key: 'sharpeRatio',       patterns: ['sharpe ratio'] },
    { key: 'sortinoRatio',      patterns: ['sortino ratio'] },
    { key: 'avgTrade',          patterns: ['avg trade', 'average trade'] },
    { key: 'avgBarsInTrade',    patterns: ['avg bars in trade', 'avg # bars'] },
  ];

  // =========================================================================
  //  Dialog & input discovery
  // =========================================================================

  function findDialog() {
    if (cachedDialog && cachedDialog.isConnected) return cachedDialog;
    cachedDialog =
      document.querySelector('[data-name="indicator-properties-dialog"]') ||
      document.querySelector('[data-dialog-name*="indicator"]') ||
      document.querySelector('[data-dialog-name*="strategy"]') ||
      document.querySelector('[data-name="strategy-properties-dialog"]');
    if (!cachedDialog) {
      const dialogs = document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="modal"]');
      for (const d of dialogs) {
        const inputs = d.querySelectorAll('input:not([type="checkbox"]):not([type="hidden"]):not([type="radio"])');
        if (inputs.length >= 3) { cachedDialog = d; break; }
      }
    }
    return cachedDialog;
  }

  function indexInputs(dialog) {
    if (!dialog) return [];
    const tabs = dialog.querySelectorAll('[class*="tab"], [role="tab"], button[class*="Tab"], [data-value]');
    for (const tab of tabs) {
      const txt = tab.textContent.trim().toLowerCase();
      if (txt === 'inputs' || txt === 'input') { tab.click(); break; }
    }
    const all = dialog.querySelectorAll(
      'input[type="text"], input[type="number"], input:not([type="checkbox"]):not([type="hidden"]):not([type="radio"]):not([type="search"])'
    );
    cachedInputs = Array.from(all).filter(inp => {
      const v = inp.value.trim();
      return v === '' || !isNaN(parseFloat(v));
    });
    return cachedInputs;
  }

  // =========================================================================
  //  Value injection — set value + press Enter (no OK click needed)
  // =========================================================================

  function setInputValue(target, value) {
    const strVal = String(value);
    
    // Focus
    target.focus();
    target.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    
    // Select all text
    target.select();
    
    // Set value via native setter
    if (inputSetter) inputSetter.call(target, strVal);
    else target.value = strVal;
    
    // Fire input + change events
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    
    // Press Enter to confirm the value (triggers TV recalculation)
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    
    // Blur
    target.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  }

  function setAllValues(paramValues) {
    for (const pv of paramValues) {
      let target = null;

      if (pv.index != null && cachedInputs[pv.index] && cachedInputs[pv.index].isConnected) {
        target = cachedInputs[pv.index];
      }

      if (!target && pv.index != null && cachedDialog) {
        indexInputs(cachedDialog);
        if (cachedInputs[pv.index]) target = cachedInputs[pv.index];
      }

      if (!target && cachedDialog) {
        // Fallback by label name
        const rows = cachedDialog.querySelectorAll('[class*="cell-"], [class*="row"], [class*="item-"], [class*="inputGroup"], [class*="property"]');
        for (const row of rows) {
          const label = row.querySelector('[class*="first-"], [class*="label"], [class*="title"], span:first-child');
          if (label && label.textContent.trim() === pv.name) {
            target = row.querySelector('input:not([type="checkbox"]):not([type="hidden"]):not([type="radio"]):not([type="search"])');
            if (target) break;
          }
        }
      }

      if (!target) {
        console.warn('[StratOptimizer] Input not found:', pv.name, 'index:', pv.index);
        continue;
      }

      setInputValue(target, pv.value);
    }
  }

  // =========================================================================
  //  Wait for recalculation — simple timeout (reliable)
  // =========================================================================

  function waitForRecalculation(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // =========================================================================
  //  Result scraping — scoped to the Strategy Tester panel + spatial matching
  // =========================================================================

  /**
   * Locate the Strategy Tester / backtesting panel so we don't accidentally
   * scrape numbers from the watchlist, symbol quote, or chart OHLC.
   * Falls back to the smallest element that contains several metric labels,
   * and finally to document.body.
   */
  function findTesterContainer() {
    const selectors = [
      '[data-name="backtesting-content-wrapper"]',
      '[class*="backtesting"]',
      '[class*="reportContainer"]',
      '[class*="report-container"]',
      '[class*="strategyTester"]',
      '[class*="strategy-tester"]',
      '[data-name="backtesting"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().width > 0) return el;
    }

    // Fallback: element that contains the most distinct metric labels (smallest wins ties)
    const probes = ['net profit', 'profit factor', 'max drawdown', 'total closed trades', 'percent profitable'];
    const counts = new Map();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = w.nextNode()) {
      const lt = node.textContent.trim().toLowerCase();
      const matched = probes.find(p => lt === p || lt.startsWith(p));
      if (!matched) continue;
      let el = node.parentElement;
      for (let depth = 0; depth < 8 && el && el !== document.body; depth++) {
        let set = counts.get(el);
        if (!set) { set = new Set(); counts.set(el, set); }
        set.add(matched);
        el = el.parentElement;
      }
    }
    let best = null, bestSize = 0, bestArea = Infinity;
    for (const [el, set] of counts) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (set.size > bestSize || (set.size === bestSize && area < bestArea)) {
        bestSize = set.size; best = el; bestArea = area;
      }
    }
    return best || document.body;
  }

  // Exact label → metric key map. Exact matching avoids false positives like
  // "Max drawdown as % of initial capital" being matched as "Max drawdown".
  const METRIC_LABELS_MAP = {
    'net profit': 'netProfit',
    'net p/l': 'netProfit',
    'total closed trades': 'totalTrades',
    'total trades': 'totalTrades',
    'percent profitable': 'percentProfitable',
    'profitable trades': 'percentProfitable',
    'win rate': 'percentProfitable',
    'profit factor': 'profitFactor',
    'max drawdown': 'maxDrawdown',
    'maximum drawdown': 'maxDrawdown',
    'sharpe ratio': 'sharpeRatio',
    'sortino ratio': 'sortinoRatio',
    'avg trade': 'avgTrade',
    'average trade': 'avgTrade',
    'avg bars in trades': 'avgBarsInTrade',
    'average bars in trades': 'avgBarsInTrade',
    'avg # bars in trades': 'avgBarsInTrade',
  };

  // Return the shallowest numeric leaf text inside `container` that is not part
  // of `excludeEl` (the label). Used to read a card's value from its title.
  function findNumericLeaf(container, excludeEl) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || el.children.length > 0) continue;
      if (excludeEl && excludeEl.contains(el)) continue;
      const t = node.textContent.trim();
      if (t.length > 0 && t.length <= 30 && /^[$€£¥\u2212\-]?\s*\d/.test(t)) return t;
    }
    return null;
  }

  // The value lives in the same "card" as the title. Climb up a few levels and
  // return the numeric value found at the shallowest level (closest to label).
  function findCardValue(labelEl) {
    let card = labelEl;
    for (let i = 0; i < 3 && card.parentElement; i++) {
      card = card.parentElement;
      const v = findNumericLeaf(card, labelEl);
      if (v) return v;
    }
    return null;
  }

  function scrapeResults() {
    const results = {};
    try {
      const root = findTesterContainer();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const allLeafTexts = [];
      let n;
      while (n = walker.nextNode()) {
        const t = n.textContent.trim();
        if (t.length < 1 || t.length > 60) continue;
        const el = n.parentElement;
        if (!el || el.children.length > 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        allLeafTexts.push({ text: t, lowerText: t.toLowerCase(), element: el, rect });
      }

      // --- Pass 1: exact label → in-card value (TradingView metric cards) ---
      for (const entry of allLeafTexts) {
        const key = METRIC_LABELS_MAP[entry.lowerText];
        if (!key || results[key]) continue;
        const val = findCardValue(entry.element);
        if (val) results[key] = val;
      }

      // --- Pass 2: spatial fallback for any metric still missing ---
      const isNumeric = (txt) => /^[$€£¥\u2212\-]?\s*\d/.test(txt);
      for (const metric of METRIC_PATTERNS) {
        if (results[metric.key]) continue;
        for (const pattern of metric.patterns) {
          const labelEntries = allLeafTexts.filter(e =>
            e.lowerText === pattern || e.lowerText.startsWith(pattern)
          );
          for (const labelEntry of labelEntries) {
            const labelRect = labelEntry.rect;

            let bestVal = null;
            let bestDist = Infinity;

            for (const candidate of allLeafTexts) {
              if (candidate === labelEntry) continue;
              if (!isNumeric(candidate.text)) continue;
              const r = candidate.rect;

              const dyRow = r.top - labelRect.top;       // same-row vertical offset
              const dxRight = r.left - labelRect.right;  // gap to the right of the label
              const dxAlign = r.left - labelRect.left;   // left-edge alignment
              const dyBelow = r.top - labelRect.bottom;  // gap below the label

              let dist = Infinity;
              // Layout A: value to the right on the same row (summary/table layout)
              if (Math.abs(dyRow) < 16 && dxRight > -10 && dxRight < 260) {
                dist = Math.abs(dyRow) * 4 + dxRight;
              }
              // Layout B: value directly below the label (card/overview layout).
              // Offset so a same-row value (Layout A) is preferred when both exist.
              else if (dyBelow > -6 && dyBelow < 56 && Math.abs(dxAlign) < 140) {
                dist = 600 + dyBelow + Math.abs(dxAlign) * 2;
              }

              if (dist < bestDist) { bestDist = dist; bestVal = candidate.text; }
            }
            if (bestVal) { results[metric.key] = bestVal; break; }
          }
        }
      }
    } catch (err) {
      console.error('[StratOptimizer] Scrape error:', err);
    }
    return results;
  }

  // =========================================================================
  //  Strategy detection
  // =========================================================================

  function detectStrategyInfo() {
    const info = { strategyName: '', symbol: '', interval: '', params: [] };
    const strategyEl =
      document.querySelector('[class*="strategyGroup"] [class*="title"]') ||
      document.querySelector('[data-name="legend-source-item"] [class*="title"]') ||
      document.querySelector('[class*="legend"] [class*="title"]');
    if (strategyEl) info.strategyName = strategyEl.textContent.trim();

    const symbolEl = document.querySelector('#header-toolbar-symbol-search') ||
      document.querySelector('[id*="header-toolbar-symbol"]');
    if (symbolEl) info.symbol = symbolEl.textContent.trim();

    const intervalEl = document.querySelector('#header-toolbar-intervals [class*="value"]') ||
      document.querySelector('[data-name="time-interval-button"]');
    if (intervalEl) info.interval = intervalEl.textContent.trim();

    const dialog = findDialog();
    if (dialog) {
      const inputs = indexInputs(dialog);
      const rows = dialog.querySelectorAll('[class*="cell-"], [class*="row"], [class*="item-"], [class*="inputGroup"], [class*="property"]');
      let idx = 0;
      const seen = new Set();
      rows.forEach(row => {
        const label = row.querySelector('[class*="first-"], [class*="label"], [class*="title"], span:first-child');
        const input = row.querySelector('input:not([type="checkbox"]):not([type="hidden"]):not([type="radio"]):not([type="search"])');
        if (label && input && !seen.has(input)) {
          const val = input.value.trim();
          if (val === '' || !isNaN(parseFloat(val))) {
            seen.add(input);
            info.params.push({ name: label.textContent.trim(), currentValue: val, inputIndex: idx });
            idx++;
          }
        }
      });
      if (info.params.length === 0) {
        inputs.forEach((inp, i) => {
          info.params.push({ name: `Param ${i + 1}`, currentValue: inp.value, inputIndex: i });
        });
      }
    }
    return info;
  }

  // =========================================================================
  //  Message handler
  // =========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {

      case 'DETECT_STRATEGY':
        sendResponse(detectStrategyInfo());
        break;

      case 'PREPARE_RUN': {
        cachedDialog = null;
        cachedInputs = [];
        const dialog = findDialog();
        if (!dialog) {
          sendResponse({ ok: false, error: 'Strategy settings dialog not found.' });
          return;
        }
        const inputs = indexInputs(dialog);
        console.log('[StratOptimizer] Prepared — found', inputs.length, 'inputs');
        sendResponse({ ok: true, inputCount: inputs.length });
        break;
      }

      case 'RUN_ITERATION': {
        const { paramValues, maxWait } = msg;

        const run = async () => {
          try {
            let dialog = findDialog();
            if (!dialog) {
              cachedDialog = null;
              dialog = findDialog();
            }
            if (!dialog) {
              return { error: 'Dialog closed. Keep strategy settings open during optimization.' };
            }

            // Re-index if inputs are stale
            if (cachedInputs.length === 0 || !cachedInputs[0]?.isConnected) {
              indexInputs(dialog);
            }

            // Set all values (Enter key triggers recalc, dialog stays open)
            setAllValues(paramValues);

            // Wait for TradingView to recalculate
            await waitForRecalculation(maxWait);

            // Scrape results
            const raw = scrapeResults();
            const parsed = {};
            for (const [key, val] of Object.entries(raw)) {
              parsed[key] = val;
              let cleaned = String(val).replace(/\u2212/g, '-').replace(/[$€£¥,\s%]/g, '').replace(/[a-zA-Z]/g, '').trim();
              const num = parseFloat(cleaned);
              parsed[key + '_num'] = isNaN(num) ? null : num;
            }

            return parsed;
          } catch (err) {
            console.error('[StratOptimizer] Iteration error:', err);
            return { error: err.message };
          }
        };

        run().then(result => {
          try { sendResponse(result); } catch (_) {}
        });
        return true;
      }

      case 'PING':
        sendResponse({ alive: true });
        break;

      case 'DEBUG_SCRAPE':
        sendResponse(scrapeResults());
        break;

      case 'DEBUG_DOM': {
        const foundTexts = [];
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n;
          while (n = walker.nextNode()) {
            const t = n.textContent.trim();
            if (t.length < 1 || t.length > 60) continue;
            const el = n.parentElement;
            if (!el || el.children.length > 0) continue;
            const lower = t.toLowerCase();
            if (
              lower.includes('net profit') || lower.includes('profit factor') ||
              lower.includes('max drawdown') || lower.includes('sharpe') ||
              lower.includes('sortino') || lower.includes('trades') ||
              lower.includes('profitable')
            ) {
              foundTexts.push({ text: t, tag: el.tagName, class: el.className });
            }
          }
        } catch (err) {
          console.error('[StratOptimizer] DEBUG_DOM error:', err);
        }
        sendResponse({ foundTexts });
        break;
      }

      default:
        sendResponse({ error: 'Unknown message type: ' + msg.type });
    }
  });

  console.log('[StratOptimizer] Content script v4 loaded');
})();
