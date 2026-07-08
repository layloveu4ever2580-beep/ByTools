import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Play, Square, Trash2, RefreshCw, Lock, Unlock, Loader2,
  ChevronLeft, Download, Wifi, WifiOff, Plus,
} from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// Mirrors the extension's DEFAULT_PARAMS (popup.js) so the desktop runner can
// map inputIndex → TradingView dialog inputs 1:1.
const DEFAULT_PARAMS = [
  { name: 'EMA 1 Length', inputIndex: 0, type: 'int', fixedValue: '20' },
  { name: 'EMA 2 Length', inputIndex: 1, type: 'int', fixedValue: '50' },
  { name: 'EMA 3 Length', inputIndex: 2, type: 'int', fixedValue: '100' },
  { name: 'EMA 4 Length', inputIndex: 3, type: 'int', fixedValue: '200' },
  { name: 'Entry Level (Fib)', inputIndex: 4, type: 'float', fixedValue: '0.786' },
  { name: 'Take Profit Level (Fib)', inputIndex: 5, type: 'float', fixedValue: '1.638' },
  { name: 'Stop Loss Level (Fib)', inputIndex: 6, type: 'float', fixedValue: '-0.315' },
];

const METRICS = [
  { value: 'netProfit', label: 'Net Profit' },
  { value: 'percentProfitable', label: 'Percent Profitable' },
  { value: 'profitFactor', label: 'Profit Factor' },
  { value: 'maxDrawdown', label: 'Max Drawdown (lowest)' },
  { value: 'sharpeRatio', label: 'Sharpe Ratio' },
  { value: 'sortinoRatio', label: 'Sortino Ratio' },
  { value: 'totalTrades', label: 'Total Trades' },
];

const METRIC_LABELS = Object.fromEntries(METRICS.map((m) => [m.value, m.label]));
const RESULT_METRICS = ['netProfit', 'profitFactor', 'percentProfitable', 'maxDrawdown', 'totalTrades'];

const decimals = (s) => {
  const str = String(s);
  const dot = str.indexOf('.');
  return dot === -1 ? 0 : str.length - dot - 1;
};

function rangeLen(start, end, step) {
  const s = parseFloat(start), e = parseFloat(end), st = parseFloat(step);
  if (isNaN(s) || isNaN(e) || isNaN(st) || st <= 0 || s > e) return 0;
  const prec = Math.max(decimals(start), decimals(step));
  const mult = Math.pow(10, prec);
  const iStart = Math.round(s * mult), iEnd = Math.round(e * mult), iStep = Math.round(st * mult);
  if (iStep <= 0) return 0;
  return Math.floor((iEnd - iStart) / iStep) + 1;
}

function countCombos(params) {
  const unlocked = params.filter((p) => !p.locked);
  if (unlocked.length === 0) return 0;
  let total = 1;
  for (const p of unlocked) {
    const n = rangeLen(p.start, p.end, p.step);
    if (n === 0) return 0;
    total *= n;
  }
  return total;
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), sec = s % 60;
  if (m < 60) return `${m}m ${sec}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtNum(v) {
  if (v == null || v === '' || v === 'N/A') return 'N/A';
  const n = parseFloat(v);
  if (isNaN(n)) return String(v);
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}

export default function Optimizer() {
  const [view, setView] = useState('create'); // 'create' | 'detail'
  const [status, setStatus] = useState({ runnerOnline: false, authRequired: false });
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const [config, setConfig] = useState({
    strategyName: '4 EMA Fib Strategy',
    symbol: 'BTCUSDT',
    interval: '60',
    metric: 'netProfit',
    delay: 1500,
  });

  const [params, setParams] = useState(
    DEFAULT_PARAMS.map((p, i) => ({
      id: 'p' + i, ...p, locked: true, start: '', end: '', step: '',
    }))
  );

  const [selectedId, setSelectedId] = useState(null);
  const [job, setJob] = useState(null);
  const [results, setResults] = useState([]);
  const [sortDir, setSortDir] = useState('desc');
  const pollRef = useRef(null);

  const combos = countCombos(params);
  const estMs = combos * (config.delay || 1500);

  // ── Fetching ──
  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE_URL}/api/opt/status`);
      if (r.ok) setStatus(await r.json());
    } catch { /* ignore */ }
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE_URL}/api/opt/jobs`);
      if (r.ok) setJobs(await r.json());
    } catch { /* ignore */ }
  }, []);

  const fetchJob = useCallback(async (id) => {
    try {
      const r = await fetch(`${API_BASE_URL}/api/opt/jobs/${id}`);
      if (r.ok) setJob(await r.json());
    } catch { /* ignore */ }
  }, []);

  const fetchResults = useCallback(async (id) => {
    try {
      const r = await fetch(`${API_BASE_URL}/api/opt/jobs/${id}/results?limit=5000`);
      if (r.ok) { const d = await r.json(); setResults(d.rows || []); }
    } catch { /* ignore */ }
  }, []);

  // Poll status + job list every 5s
  useEffect(() => {
    fetchStatus();
    fetchJobs();
    const t = setInterval(() => { fetchStatus(); fetchJobs(); }, 5000);
    return () => clearInterval(t);
  }, [fetchStatus, fetchJobs]);

  // Poll the open job's progress + results while it's active
  useEffect(() => {
    if (view !== 'detail' || !selectedId) return;
    fetchJob(selectedId);
    fetchResults(selectedId);
    pollRef.current = setInterval(() => {
      fetchJob(selectedId);
      fetchResults(selectedId);
    }, 3000);
    return () => clearInterval(pollRef.current);
  }, [view, selectedId, fetchJob, fetchResults]);

  // Stop polling results once the job is finished (one final fetch already ran)
  useEffect(() => {
    if (job && ['completed', 'stopped', 'error', 'interrupted'].includes(job.status) && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [job]);

  // ── Param editing ──
  const updateParam = (id, field, value) =>
    setParams((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));

  const toggleLock = (id) =>
    setParams((prev) => prev.map((p) => (p.id === id ? { ...p, locked: !p.locked } : p)));

  const resetParams = () =>
    setParams(DEFAULT_PARAMS.map((p, i) => ({ id: 'p' + i, ...p, locked: true, start: '', end: '', step: '' })));

  // ── Actions ──
  const createJob = async () => {
    const unlocked = params.filter((p) => !p.locked);
    if (unlocked.length === 0) { setError('Unlock at least one parameter to optimize'); return; }
    if (unlocked.some((p) => rangeLen(p.start, p.end, p.step) === 0)) {
      setError('Set a valid min/max/step for every unlocked parameter'); return;
    }
    setCreating(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE_URL}/api/opt/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, parameters: params }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to create job');
      await fetchJobs();
      openJob(data.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const openJob = (id) => { setSelectedId(id); setJob(null); setResults([]); setView('detail'); };
  const backToList = () => { setView('create'); setSelectedId(null); setJob(null); setResults([]); };

  const stopJob = async (id) => {
    try { await fetch(`${API_BASE_URL}/api/opt/jobs/${id}/stop`, { method: 'POST' }); fetchJob(id); }
    catch { /* ignore */ }
  };

  const deleteJob = async (id) => {
    if (!confirm('Delete this optimization job and its results?')) return;
    try {
      await fetch(`${API_BASE_URL}/api/opt/jobs/${id}`, { method: 'DELETE' });
      await fetchJobs();
      if (selectedId === id) backToList();
    } catch { /* ignore */ }
  };

  // ── Export ──
  const sortedResults = (() => {
    if (!job) return results;
    const key = job.config.metric + '_num';
    const arr = [...results].filter((r) => !r.error);
    arr.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortDir === 'desc' ? bv - av : av - bv;
    });
    return arr;
  })();

  const bestRowIndex = (() => {
    if (!job || sortedResults.length === 0) return null;
    const higherBetter = job.config.metric !== 'maxDrawdown';
    // After sorting, best is first row when sortDir matches "better" direction.
    return (sortDir === 'desc') === higherBetter ? sortedResults[0].index : null;
  })();

  const download = (content, filename, mime) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const exportCSV = () => {
    if (!job) return;
    const paramNames = job.parameters.filter((p) => !p.locked).map((p) => p.name);
    const headers = ['#', ...paramNames, ...RESULT_METRICS.map((m) => METRIC_LABELS[m] || m)];
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.map(esc).join(',')];
    for (const r of sortedResults) {
      const row = [r.index, ...(r.params || []), ...RESULT_METRICS.map((m) => r[m] ?? r[m + '_num'] ?? '')];
      lines.push(row.map(esc).join(','));
    }
    download(lines.join('\n'), `${job.id}.csv`, 'text/csv');
  };

  const exportJSON = () => {
    if (!job) return;
    download(JSON.stringify({ job, results: sortedResults }, null, 2), `${job.id}.json`, 'application/json');
  };

  const statusBadge = (s) => {
    const map = {
      pending: 'opt-badge-pending', running: 'opt-badge-running',
      completed: 'opt-badge-done', stopped: 'opt-badge-stopped',
      error: 'opt-badge-error', interrupted: 'opt-badge-error',
    };
    return <span className={`opt-status-badge ${map[s] || ''}`}>{s}</span>;
  };

  // ═══════════════ Render ═══════════════
  return (
    <div className="optimizer">
      <div className="opt-runner-status">
        {status.runnerOnline ? (
          <span className="opt-runner online"><Wifi size={14} /> Desktop runner connected</span>
        ) : (
          <span className="opt-runner offline"><WifiOff size={14} /> No desktop runner — start the extension on your PC</span>
        )}
        {!status.authRequired && (
          <span className="opt-runner-hint">Tip: set OPT_SECRET to secure the runner endpoints</span>
        )}
      </div>

      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {view === 'create' && (
        <>
          <section className="card">
            <div className="section-header">
              <h2>New Optimization</h2>
              <button className="btn-sync" onClick={resetParams} type="button">
                <RefreshCw size={14} /> Reset
              </button>
            </div>

            <div className="opt-config-grid">
              <label className="opt-field">
                <span>Symbol</span>
                <input value={config.symbol} onChange={(e) => setConfig({ ...config, symbol: e.target.value.toUpperCase() })} />
              </label>
              <label className="opt-field">
                <span>Interval</span>
                <input value={config.interval} onChange={(e) => setConfig({ ...config, interval: e.target.value })} />
              </label>
              <label className="opt-field">
                <span>Optimize For</span>
                <select value={config.metric} onChange={(e) => setConfig({ ...config, metric: e.target.value })}>
                  {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
              <label className="opt-field">
                <span>Step Delay (ms)</span>
                <input type="number" min="500" max="30000" step="100" value={config.delay}
                  onChange={(e) => setConfig({ ...config, delay: parseInt(e.target.value) || 1500 })} />
              </label>
            </div>
          </section>

          <section className="card">
            <div className="section-header">
              <h2>Parameters</h2>
              <span className="opt-combo-count">
                {combos > 0 ? `${combos.toLocaleString()} combos · ~${fmtDuration(estMs)}` : 'Unlock params to optimize'}
              </span>
            </div>

            <div className="opt-params">
              {params.map((p) => (
                <div key={p.id} className={`opt-param-card ${p.locked ? 'locked' : 'unlocked'}`}>
                  <div className="opt-param-head">
                    <span className="opt-param-name">{p.name}</span>
                    <button className="opt-lock-btn" onClick={() => toggleLock(p.id)} type="button"
                      title={p.locked ? 'Locked — click to optimize' : 'Unlocked — click to fix'}>
                      {p.locked ? <Lock size={15} /> : <Unlock size={15} />}
                    </button>
                  </div>
                  {p.locked ? (
                    <div className="opt-param-body">
                      <label className="opt-mini-field">
                        <span>FIXED</span>
                        <input value={p.fixedValue} onChange={(e) => updateParam(p.id, 'fixedValue', e.target.value)} />
                      </label>
                    </div>
                  ) : (
                    <div className="opt-param-body opt-range">
                      <label className="opt-mini-field"><span>MIN</span>
                        <input value={p.start} placeholder="min" onChange={(e) => updateParam(p.id, 'start', e.target.value)} /></label>
                      <label className="opt-mini-field"><span>MAX</span>
                        <input value={p.end} placeholder="max" onChange={(e) => updateParam(p.id, 'end', e.target.value)} /></label>
                      <label className="opt-mini-field"><span>STEP</span>
                        <input value={p.step} placeholder="step" onChange={(e) => updateParam(p.id, 'step', e.target.value)} /></label>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button className="btn-opt-start" onClick={createJob} disabled={creating || combos === 0}>
              {creating ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
              Queue Optimization
            </button>
            {!status.runnerOnline && combos > 0 && (
              <p className="opt-queue-note">Job will be queued and start automatically once your desktop runner connects.</p>
            )}
          </section>

          <section className="card">
            <div className="section-header"><h2>Jobs</h2></div>
            {jobs.length === 0 ? (
              <p className="empty-state">No optimization jobs yet.</p>
            ) : (
              <div className="opt-job-list">
                {jobs.map((j) => (
                  <div key={j.id} className="opt-job-card" onClick={() => openJob(j.id)}>
                    <div className="opt-job-main">
                      <div className="opt-job-title">
                        {j.config.symbol} · {j.config.interval} {statusBadge(j.status)}
                      </div>
                      <div className="opt-job-meta">
                        {METRIC_LABELS[j.config.metric]} · {j.completedCombinations}/{j.totalCombinations} combos
                        {j.best ? ` · best ${fmtNum(j.best.value)}` : ''}
                      </div>
                    </div>
                    <button className="opt-icon-btn danger" onClick={(e) => { e.stopPropagation(); deleteJob(j.id); }}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {view === 'detail' && (
        <section className="card">
          <div className="section-header">
            <button className="btn-sync opt-back" onClick={backToList} type="button">
              <ChevronLeft size={15} /> Back
            </button>
            <div className="opt-detail-actions">
              <button className="opt-icon-btn" onClick={exportCSV} title="Export CSV"><Download size={15} /> CSV</button>
              <button className="opt-icon-btn" onClick={exportJSON} title="Export JSON"><Download size={15} /> JSON</button>
              {job && ['pending', 'running'].includes(job.status) && (
                <button className="opt-icon-btn danger" onClick={() => stopJob(job.id)}><Square size={14} /> Stop</button>
              )}
              {job && <button className="opt-icon-btn danger" onClick={() => deleteJob(job.id)}><Trash2 size={15} /></button>}
            </div>
          </div>

          {!job ? (
            <div className="loading-state"><Loader2 size={22} className="spin" /> Loading…</div>
          ) : (
            <>
              <div className="opt-detail-head">
                <div className="opt-detail-title">{job.config.symbol} · {job.config.interval} {statusBadge(job.status)}</div>
                <div className="opt-detail-sub">{job.config.strategyName} · optimizing {METRIC_LABELS[job.config.metric]}</div>
              </div>

              <div className="opt-progress-wrap">
                <div className="opt-progress-bar">
                  <div className="opt-progress-fill" style={{ width: `${(job.progress?.percent || 0).toFixed(1)}%` }} />
                </div>
                <div className="opt-progress-stats">
                  <span>{job.completedCombinations} / {job.totalCombinations}</span>
                  <span>{job.progress?.speed ? `${job.progress.speed} it/s` : ''}</span>
                  <span>{job.progress?.eta != null ? `ETA ${fmtDuration(job.progress.eta)}` : ''}</span>
                </div>
              </div>

              {job.best && (
                <div className="opt-best">
                  <span className="opt-best-label">Best {METRIC_LABELS[job.config.metric]}</span>
                  <span className="opt-best-value">{fmtNum(job.best.value)}</span>
                  <span className="opt-best-params">[{(job.best.params || []).join(', ')}]</span>
                </div>
              )}

              <div className="opt-results-head">
                <h3>Results ({sortedResults.length})</h3>
                <button className="btn-sync" onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))} type="button">
                  {sortDir === 'desc' ? '↓' : '↑'} {METRIC_LABELS[job.config.metric]}
                </button>
              </div>

              {sortedResults.length === 0 ? (
                <p className="empty-state">No results yet. They stream in as the runner works.</p>
              ) : (
                <div className="opt-results-scroll">
                  <table className="opt-results-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        {job.parameters.filter((p) => !p.locked).map((p) => <th key={p.name}>{p.name}</th>)}
                        {RESULT_METRICS.map((m) => <th key={m}>{METRIC_LABELS[m]}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedResults.slice(0, 500).map((r) => (
                        <tr key={r.index} className={r.index === bestRowIndex ? 'opt-best-row' : ''}>
                          <td>{r.index}</td>
                          {(r.params || []).map((v, i) => <td key={i}>{v}</td>)}
                          {RESULT_METRICS.map((m) => <td key={m}>{r[m] ?? fmtNum(r[m + '_num'])}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
