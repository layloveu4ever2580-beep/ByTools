/**
 * StratOptimizer - Remote Runner (Option 1 bridge)
 *
 * Turns this desktop extension into a headless "runner" for the ByTools
 * dashboard. It polls the ByTools backend for queued optimization jobs,
 * runs each one with the existing Optimizer (all TradingView DOM work stays
 * here on the desktop), and streams progress + result rows back to the
 * backend so they can be viewed from a phone.
 *
 * Runs in the popup context alongside Optimizer/Storage/Utils — keep the
 * popup open while a job is running (same constraint as a normal local run).
 *
 * Load AFTER optimizer.js:
 *   <script src="src/remote.js"></script>
 */

const RemoteRunner = {
  backendUrl: '',
  secret: '',
  runnerId: '',
  pollMs: 4000,

  _running: false,        // poller active
  _busy: false,           // currently executing a job
  _currentJobId: null,
  _resultBuffer: [],

  onLog: null,            // (msg, level) => {}
  onState: null,          // ({ polling, busy, jobId }) => {}

  // ── helpers ──
  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.secret) h['X-Opt-Secret'] = this.secret;
    return h;
  },

  _url(path) {
    return this.backendUrl.replace(/\/+$/, '') + path;
  },

  log(msg, level = 'info') {
    if (this.onLog) this.onLog(msg, level);
    console.log('[RemoteRunner]', msg);
  },

  _emit() {
    if (this.onState) {
      this.onState({ polling: this._running, busy: this._busy, jobId: this._currentJobId });
    }
  },

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  },

  async _fetch(path, opts = {}) {
    const res = await fetch(this._url(path), {
      ...opts,
      headers: { ...this._headers(), ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${res.status} ${txt}`.trim());
    }
    return res.json();
  },

  // ── lifecycle ──
  start(cfg) {
    if (this._running) return;
    this.backendUrl = (cfg.backendUrl || '').trim();
    this.secret = (cfg.secret || '').trim();
    this.runnerId = cfg.runnerId || ('runner-' + Math.random().toString(36).slice(2, 8));
    if (!this.backendUrl) { this.log('Backend URL is required', 'error'); return; }
    this._running = true;
    this.log('Runner connected to ' + this.backendUrl);
    this._emit();
    this._poll();
  },

  stop() {
    this._running = false;
    this.log('Runner disconnected');
    this._emit();
  },

  async _poll() {
    while (this._running) {
      if (!this._busy) {
        try {
          const { job } = await this._fetch('/api/opt/claim', {
            method: 'POST',
            body: JSON.stringify({ runnerId: this.runnerId }),
          });
          if (job) {
            await this._runJob(job);
          } else {
            await this._heartbeat();
          }
        } catch (e) {
          this.log('Poll error: ' + e.message, 'error');
        }
      }
      await this._sleep(this.pollMs);
    }
  },

  async _heartbeat() {
    try { await this._fetch('/api/opt/heartbeat', { method: 'POST', body: '{}' }); }
    catch (_) { /* ignore */ }
  },

  // ── run one job with the existing Optimizer ──
  async _runJob(job) {
    this._busy = true;
    this._currentJobId = job.id;
    this._resultBuffer = [];
    this._emit();
    this.log(`Running job ${job.id}: ${job.config.symbol} · ${job.config.interval}`);

    const metric = job.config.metric;
    const unlocked = job.parameters.filter((p) => !p.locked).map((p) => ({
      name: p.name, inputIndex: p.inputIndex, start: p.start, end: p.end, step: p.step,
    }));
    const lockedParams = job.parameters.filter((p) => p.locked).map((p) => ({
      name: p.name, index: p.inputIndex, value: p.fixedValue,
    }));
    const config = {
      metric,
      delay: job.config.delay,
      maxTabs: 1,
      strategyName: job.config.strategyName,
      symbol: job.config.symbol,
      interval: job.config.interval,
      lockedParams,
    };

    let lastProgressPost = 0;

    const flush = async (force = false) => {
      if (this._resultBuffer.length === 0) return;
      if (!force && this._resultBuffer.length < 10) return;
      const rows = this._resultBuffer.splice(0);
      try {
        const resp = await this._fetch(`/api/opt/jobs/${job.id}/results`, {
          method: 'POST', body: JSON.stringify({ rows }),
        });
        if (resp.stopRequested) Optimizer.stop();
      } catch (e) {
        this.log('Result upload failed: ' + e.message, 'error');
        this._resultBuffer.unshift(...rows); // retry next flush
      }
    };

    try {
      await Optimizer.start(unlocked, config, {
        onResult: (row) => {
          this._resultBuffer.push(this._slimRow(row));
          if (this._resultBuffer.length >= 10) flush();
        },
        onProgress: async (p) => {
          const now = Date.now();
          if (now - lastProgressPost < 500) return;
          lastProgressPost = now;
          const best = p.bestResult
            ? { params: p.bestResult.params, value: p.bestResult[metric + '_num'] ?? p.bestResult[metric] }
            : null;
          try {
            const resp = await this._fetch(`/api/opt/jobs/${job.id}/progress`, {
              method: 'POST',
              body: JSON.stringify({
                progress: {
                  completed: p.completed, total: p.total, percent: p.percent,
                  elapsed: p.elapsed, eta: p.eta, speed: p.speed,
                },
                best,
              }),
            });
            if (resp.stopRequested) Optimizer.stop();
          } catch (_) { /* progress is best-effort */ }
        },
        onComplete: async (report) => {
          await flush(true);
          const best = report.bestParams
            ? { params: report.bestParams, value: report.bestMetricValue }
            : null;
          try {
            await this._fetch(`/api/opt/jobs/${job.id}/complete`, {
              method: 'POST',
              body: JSON.stringify({
                stopped: report.stopped,
                duration: report.duration,
                completed: report.completedCombinations,
                best,
              }),
            });
          } catch (e) {
            this.log('Complete post failed: ' + e.message, 'error');
          }
          this.log(`Job ${job.id} finished (${report.completedCombinations}/${report.totalCombinations})`);
        },
        onError: async (err) => {
          await flush(true);
          try {
            await this._fetch(`/api/opt/jobs/${job.id}/complete`, {
              method: 'POST', body: JSON.stringify({ error: err.message }),
            });
          } catch (_) { /* ignore */ }
          this.log('Job error: ' + err.message, 'error');
        },
      });
    } catch (e) {
      try {
        await this._fetch(`/api/opt/jobs/${job.id}/complete`, {
          method: 'POST', body: JSON.stringify({ error: e.message }),
        });
      } catch (_) { /* ignore */ }
      this.log('Run failed: ' + e.message, 'error');
    } finally {
      this._busy = false;
      this._currentJobId = null;
      this._emit();
    }
  },

  // Keep only params + metric values so we don't ship bulky duplicate fields.
  _slimRow(row) {
    const out = { index: row.index, params: row.params };
    if (row.error) { out.error = row.error; return out; }
    const metrics = [
      'netProfit', 'totalTrades', 'percentProfitable', 'profitFactor',
      'maxDrawdown', 'sharpeRatio', 'sortinoRatio', 'avgTrade', 'avgBarsInTrade',
    ];
    for (const m of metrics) {
      if (row[m] !== undefined) out[m] = row[m];
      if (row[m + '_num'] !== undefined) out[m + '_num'] = row[m + '_num'];
    }
    return out;
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Self-contained popup UI
//  Injects a compact "Remote Runner" panel into the popup so no popup.html
//  markup edits are required. Config (backend URL + secret) is persisted in
//  chrome.storage.local under 'strat-remote-config'.
// ═══════════════════════════════════════════════════════════════════════════

RemoteRunner.initUI = async function () {
  const host = document.getElementById('app') || document.body;
  if (!host || document.getElementById('remote-runner-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'remote-runner-panel';
  panel.style.cssText =
    'border-top:1px solid var(--border,#2a2e39);padding:10px 12px;font-size:12px;' +
    'background:var(--bg-secondary,#1e222d);color:var(--text-primary,#d1d4dc);';
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <strong style="font-size:12px;">☁ Remote Runner</strong>
      <span id="rr-state" style="font-size:11px;color:#787b86;">idle</span>
    </div>
    <input id="rr-url" placeholder="Backend URL (https://your-app.onrender.com)"
      style="width:100%;margin-bottom:6px;padding:6px 8px;border-radius:6px;border:1px solid #2a2e39;background:#131722;color:#d1d4dc;font-size:12px;">
    <input id="rr-secret" type="password" placeholder="OPT_SECRET (optional)"
      style="width:100%;margin-bottom:6px;padding:6px 8px;border-radius:6px;border:1px solid #2a2e39;background:#131722;color:#d1d4dc;font-size:12px;">
    <div style="display:flex;gap:6px;">
      <button id="rr-connect" style="flex:1;padding:7px;border:none;border-radius:6px;background:#2962ff;color:#fff;font-weight:600;cursor:pointer;">Connect</button>
      <button id="rr-disconnect" style="flex:1;padding:7px;border:none;border-radius:6px;background:#f23645;color:#fff;font-weight:600;cursor:pointer;display:none;">Disconnect</button>
    </div>
    <pre id="rr-log" style="margin:8px 0 0;max-height:80px;overflow-y:auto;font-size:10px;color:#787b86;white-space:pre-wrap;"></pre>
  `;
  host.appendChild(panel);

  const $ = (id) => document.getElementById(id);
  const urlInput = $('rr-url');
  const secretInput = $('rr-secret');
  const connectBtn = $('rr-connect');
  const disconnectBtn = $('rr-disconnect');
  const stateEl = $('rr-state');
  const logEl = $('rr-log');

  // Restore saved config
  try {
    const saved = (await chrome.storage.local.get('strat-remote-config'))['strat-remote-config'];
    if (saved) { urlInput.value = saved.backendUrl || ''; secretInput.value = saved.secret || ''; }
  } catch (_) { /* ignore */ }

  this.onLog = (msg) => {
    const line = new Date().toLocaleTimeString() + '  ' + msg;
    logEl.textContent = (line + '\n' + logEl.textContent).slice(0, 2000);
  };

  this.onState = ({ polling, busy, jobId }) => {
    stateEl.textContent = !polling ? 'idle' : (busy ? `running ${jobId || ''}` : 'polling…');
    stateEl.style.color = !polling ? '#787b86' : (busy ? '#2962ff' : '#26a69a');
    connectBtn.style.display = polling ? 'none' : 'block';
    disconnectBtn.style.display = polling ? 'block' : 'none';
    urlInput.disabled = polling;
    secretInput.disabled = polling;
  };

  connectBtn.addEventListener('click', async () => {
    const backendUrl = urlInput.value.trim();
    const secret = secretInput.value.trim();
    if (!backendUrl) { this.log('Enter a backend URL', 'error'); return; }
    try {
      await chrome.storage.local.set({ 'strat-remote-config': { backendUrl, secret } });
    } catch (_) { /* ignore */ }
    this.start({ backendUrl, secret });
  });

  disconnectBtn.addEventListener('click', () => this.stop());
};

// Auto-init once the popup DOM is ready.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => RemoteRunner.initUI());
  } else {
    RemoteRunner.initUI();
  }
}
