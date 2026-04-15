import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, DollarSign, TrendingUp, Activity, Waves, Loader2, Plus, Trash2, Coins, Target, Clock, Zap, BarChart3, CalendarDays } from 'lucide-react';
import './App.css';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

function App() {
  const [trades, setTrades] = useState([]);
  const [settings, setSettings] = useState({ targetProfit: 100, theme: 'light', timezone: 'UTC' });
  const [filter, setFilter] = useState('All');
  const [lastSync, setLastSync] = useState(new Date().toLocaleTimeString());
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [leverageConfig, setLeverageConfig] = useState({});
  const [showLeverage, setShowLeverage] = useState(false);
  const [newSymbol, setNewSymbol] = useState('');
  const [newLeverage, setNewLeverage] = useState(10);
  const [leverageLoading, setLeverageLoading] = useState(false);
  const [showTpTargets, setShowTpTargets] = useState(false);
  const [tpTargets, setTpTargets] = useState({});
  const [tpSaving, setTpSaving] = useState(false);
  const [tpSymbolInputs, setTpSymbolInputs] = useState({});

  const fetchTrades = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/trades`);
      if (!res.ok) throw new Error(`Failed to fetch trades (${res.status})`);
      const data = await res.json();
      setTrades(data);
      setLastSync(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/settings`);
      if (!res.ok) return;
      const data = await res.json();
      if (data) {
        setSettings(data);
        if (data.tpTargets) setTpTargets(data.tpTargets);
      }
    } catch (err) {
      console.error('Failed to fetch settings', err);
    }
  }, []);

  useEffect(() => {
    fetchTrades();
    fetchSettings();
    fetchLeverage();
  }, [fetchTrades, fetchSettings]);

  const fetchLeverage = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/leverage`);
      if (!res.ok) return;
      const data = await res.json();
      setLeverageConfig(data);
    } catch (err) {
      console.error('Failed to fetch leverage config', err);
    }
  };

  const addLeverage = async (e) => {
    e.preventDefault();
    if (!newSymbol.trim()) return;
    setLeverageLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/leverage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: newSymbol.trim(), leverage: newLeverage }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to add symbol');
      }
      const data = await res.json();
      setLeverageConfig(data);
      setNewSymbol('');
      setNewLeverage(10);
    } catch (err) {
      setError(err.message);
    } finally {
      setLeverageLoading(false);
    }
  };

  const deleteLeverage = async (symbol) => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/leverage/${symbol}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete symbol');
      }
      const data = await res.json();
      setLeverageConfig(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const updateTpTarget = (key, field, value) => {
    setTpTargets(prev => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  };

  const addSymbolToTimeframe = (timeframeKey) => {
    const raw = (tpSymbolInputs[timeframeKey] || '').trim().toUpperCase();
    if (!raw) return;
    setTpTargets(prev => {
      const updated = { ...prev };
      // Remove symbol from ALL other timeframes first
      for (const k of Object.keys(updated)) {
        if (k !== timeframeKey) {
          updated[k] = {
            ...updated[k],
            symbols: (updated[k].symbols || []).filter(s => s !== raw),
          };
        }
      }
      // Add to this timeframe if not already there
      const current = updated[timeframeKey]?.symbols || [];
      if (!current.includes(raw)) {
        updated[timeframeKey] = {
          ...updated[timeframeKey],
          symbols: [...current, raw],
        };
      }
      return updated;
    });
    setTpSymbolInputs(prev => ({ ...prev, [timeframeKey]: '' }));
  };

  const removeSymbolFromTimeframe = (timeframeKey, symbol) => {
    setTpTargets(prev => ({
      ...prev,
      [timeframeKey]: {
        ...prev[timeframeKey],
        symbols: (prev[timeframeKey].symbols || []).filter(s => s !== symbol),
      },
    }));
  };

  // Build a lookup: symbol → timeframe key for display
  const symbolTimeframeMap = {};
  Object.entries(tpTargets).forEach(([key, cfg]) => {
    (cfg.symbols || []).forEach(sym => { symbolTimeframeMap[sym] = key; });
  });

  const saveTpTargets = async () => {
    setTpSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, tpTargets }),
      });
      if (!res.ok) throw new Error('Failed to save TP targets');
      const data = await res.json();
      setSettings(data);
      if (data.tpTargets) setTpTargets(data.tpTargets);
    } catch (err) {
      setError(err.message);
    } finally {
      setTpSaving(false);
    }
  };

  const syncTrades = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/sync-trades`, { method: 'POST' });
      if (!res.ok) throw new Error(`Sync failed (${res.status})`);
      await fetchTrades();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const toggleTheme = async () => {
    const newTheme = settings.theme === 'light' ? 'dark' : 'light';
    const updated = { ...settings, theme: newTheme };
    setSettings(updated);
    try {
      await fetch(`${API_BASE_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
    } catch (err) {
      console.error('Failed to persist theme', err);
    }
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '—';
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  // Derived stats
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const now = new Date();
  const thisMonthTrades = trades.filter(t => {
    if (!t.timestamp) return false;
    const d = new Date(t.timestamp);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const thisMonthPnl = thisMonthTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const closedTrades = trades.filter(t => t.status === 'Closed');
  const realizedPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const wins = closedTrades.filter(t => t.pnl > 0).length;
  const losses = closedTrades.filter(t => t.pnl <= 0).length;
  const winRate = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(1) : '0.0';
  const activePositions = trades.filter(t => t.status === 'Open').length;

  const filteredTrades = trades.filter(t => {
    if (filter === 'All') return true;
    return t.status.toLowerCase() === filter.toLowerCase();
  });

  return (
    <div className={`app-container ${settings.theme || 'light'}`}>
      <header className="page-header">
        <div>
          <h1 className="logo-text">Bybit Money Management Bot</h1>
          <p className="subtitle">Position sizing & trade monitoring</p>
        </div>
        <div className="header-actions">
          <div className="connection-status">
            <span className="dot connected"></span> Connected
          </div>
          <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
            {settings.theme === 'dark' ? '🌙' : '☀️'}
          </button>
          <button className="btn-leverage" onClick={() => setShowLeverage(!showLeverage)}>
            <Coins size={18} /> Leverage
          </button>
          <button className="btn-tp-targets" onClick={() => setShowTpTargets(!showTpTargets)}>
            <Target size={18} /> TP Targets
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError(null)} aria-label="Dismiss error">✕</button>
        </div>
      )}

      {showLeverage && (
        <section className="leverage-panel card">
          <h2>Leverage Config</h2>
          <p className="leverage-subtitle">Manage trading pairs and their leverage multipliers</p>

          <form onSubmit={addLeverage} className="leverage-form">
            <div className="leverage-form-row">
              <input
                type="text"
                placeholder="Symbol (e.g. BTCUSDT)"
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
                className="leverage-input symbol-input"
                required
              />
              <input
                type="number"
                placeholder="Leverage"
                min="1"
                max="100"
                value={newLeverage}
                onChange={(e) => setNewLeverage(parseInt(e.target.value) || 1)}
                className="leverage-input leverage-num-input"
                required
              />
              <button type="submit" className="btn-add-leverage" disabled={leverageLoading}>
                {leverageLoading ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                Add
              </button>
            </div>
          </form>

          <div className="leverage-grid">
            {Object.entries(leverageConfig)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([symbol, leverage]) => (
                <div key={symbol} className="leverage-item">
                  <div className="leverage-item-info">
                    <span className="leverage-symbol">{symbol}</span>
                    <span className="leverage-value">{leverage}x</span>
                  </div>
                  <button
                    className="btn-delete-leverage"
                    onClick={() => deleteLeverage(symbol)}
                    aria-label={`Remove ${symbol}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            {Object.keys(leverageConfig).length === 0 && (
              <p className="leverage-empty">No symbols configured yet. Add one above.</p>
            )}
          </div>
        </section>
      )}

      {showTpTargets && (
        <section className="tp-targets-panel card">
          <div className="tp-targets-header">
            <div>
              <h2>Take Profit Targets</h2>
              <p className="tp-targets-subtitle">Configure different TP amounts for each trading timeframe</p>
            </div>
            <button className="btn-save-tp" onClick={saveTpTargets} disabled={tpSaving}>
              {tpSaving ? <Loader2 size={14} className="spin" /> : null}
              Save Targets
            </button>
          </div>

          <div className="tp-targets-grid">
            {Object.entries(tpTargets).map(([key, config]) => {
              const icons = { scalp: <Zap size={20} />, day: <BarChart3 size={20} />, swing: <CalendarDays size={20} /> };
              const colors = { scalp: 'tp-scalp', day: 'tp-day', swing: 'tp-swing' };
              const descriptions = {
                scalp: 'Quick entries on 1m–15m charts. Small targets, fast exits.',
                day: 'Intraday setups on 15m–4h charts. Balanced risk/reward.',
                swing: 'Multi-day holds on 4h–1D charts. Larger targets, wider stops.',
              };
              const symbols = config.symbols || [];
              return (
                <div key={key} className={`tp-target-card ${colors[key] || 'tp-default'} ${config.enabled ? '' : 'tp-disabled'}`}>
                  <div className="tp-target-card-header">
                    <div className="tp-target-icon">{icons[key] || <Clock size={20} />}</div>
                    <div className="tp-target-title-row">
                      <h3 className="tp-target-title">{config.label || key}</h3>
                      <label className="tp-toggle">
                        <input
                          type="checkbox"
                          checked={config.enabled}
                          onChange={(e) => updateTpTarget(key, 'enabled', e.target.checked)}
                        />
                        <span className="tp-toggle-slider"></span>
                      </label>
                    </div>
                  </div>
                  <p className="tp-target-desc">{descriptions[key] || 'Custom timeframe target.'}</p>

                  <div className="tp-target-input-group">
                    <label className="tp-target-label">Target Profit ($)</label>
                    <div className="tp-target-input-wrapper">
                      <span className="tp-input-prefix">$</span>
                      <input
                        type="number"
                        min="1"
                        step="0.5"
                        value={config.targetProfit}
                        onChange={(e) => updateTpTarget(key, 'targetProfit', parseFloat(e.target.value) || 0)}
                        className="tp-target-input"
                        disabled={!config.enabled}
                      />
                    </div>
                  </div>

                  <div className="tp-symbols-section">
                    <div className="section-divider">
                      <span className="section-divider-text">Assigned Symbols</span>
                    </div>
                    <div className="tp-symbols-add-row">
                      <input
                        type="text"
                        placeholder="e.g. BTCUSDT"
                        value={tpSymbolInputs[key] || ''}
                        onChange={(e) => setTpSymbolInputs(prev => ({ ...prev, [key]: e.target.value.toUpperCase() }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSymbolToTimeframe(key); } }}
                        className="tp-symbol-input"
                        disabled={!config.enabled}
                      />
                      <button
                        type="button"
                        className={`btn-add-tp-symbol ${colors[key] || 'tp-default'}`}
                        onClick={() => addSymbolToTimeframe(key)}
                        disabled={!config.enabled}
                      >
                        <Plus size={14} /> Add
                      </button>
                    </div>
                    <div className="tp-symbol-chips">
                      {symbols.length === 0 && (
                        <span className="tp-symbol-empty">No symbols assigned — uses global target</span>
                      )}
                      {symbols.map(sym => (
                        <span key={sym} className={`tp-symbol-chip ${colors[key] || 'tp-default'}`}>
                          {sym}
                          <button
                            type="button"
                            className="tp-symbol-chip-remove"
                            onClick={() => removeSymbolFromTimeframe(key, sym)}
                            aria-label={`Remove ${sym} from ${config.label}`}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {Object.keys(tpTargets).length === 0 && (
            <p className="tp-targets-empty">No TP targets configured. Save settings to initialize defaults.</p>
          )}
        </section>
      )}

      <main className="dashboard-content">
        <div className="stats-row">
          <div className="stat-card">
            <div>
              <h3>Total PnL</h3>
              <div className={`stat-value ${totalPnl >= 0 ? 'positive' : 'negative'}`}>
                ${totalPnl.toFixed(2)}
              </div>
              <p className="sub-text">Realized: ${realizedPnl.toFixed(2)}</p>
            </div>
            <div className="icon-wrapper blue-icon"><DollarSign size={24} /></div>
          </div>

          <div className="stat-card">
            <div>
              <h3>This Month</h3>
              <div className={`stat-value ${thisMonthPnl >= 0 ? 'positive' : 'negative'}`}>
                ${thisMonthPnl.toFixed(2)}
              </div>
              <p className="sub-text">{thisMonthTrades.length} trades</p>
            </div>
            <div className="icon-wrapper green-icon"><TrendingUp size={24} /></div>
          </div>

          <div className="stat-card">
            <div>
              <h3>Win Rate</h3>
              <div className="stat-value neutral">{winRate}%</div>
              <p className="sub-text">{wins}W / {losses}L ({closedTrades.length} closed)</p>
            </div>
            <div className="icon-wrapper purple-icon"><Activity size={24} /></div>
          </div>

          <div className="stat-card">
            <div>
              <h3>Active Positions</h3>
              <div className="stat-value neutral">{activePositions}</div>
              <p className="sub-text">{trades.length} total trades</p>
            </div>
            <div className="icon-wrapper blue-icon"><Waves size={24} /></div>
          </div>
        </div>

        <section className="history-section card">
          <div className="history-header">
            <h2>Trade History</h2>
            <div className="history-actions">
              <div className="tabs" role="tablist">
                {['All', 'Open', 'Closed', 'Failed'].map(tab => (
                  <button
                    key={tab}
                    role="tab"
                    aria-selected={filter === tab}
                    className={`tab-btn ${filter === tab ? 'active' : ''}`}
                    onClick={() => setFilter(tab)}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <span className="sync-time">Synced {lastSync}</span>
              <button className="btn-sync" onClick={syncTrades} disabled={syncing}>
                {syncing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Sync
              </button>
            </div>
          </div>

          {loading ? (
            <div className="loading-state"><Loader2 size={24} className="spin" /> Loading trades...</div>
          ) : (
            <div className="table-responsive">
              <table className="trades-table">
                <thead>
                  <tr>
                    <th>TICKER</th>
                    <th>ACTION</th>
                    <th>ENTRY</th>
                    <th>EXIT</th>
                    <th>TP / SL</th>
                    <th>TARGET $</th>
                    <th>TF</th>
                    <th>QTY</th>
                    <th>LEV</th>
                    <th>PNL</th>
                    <th>STATUS</th>
                    <th>TIME</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTrades.map((t, idx) => {
                    const tfKey = t.timeframe || symbolTimeframeMap[t.ticker] || 'global';
                    const tfLabels = { scalp: 'Scalp', day: 'Day', swing: 'Swing', global: 'Global' };
                    const tfColors = { scalp: 'tf-badge-scalp', day: 'tf-badge-day', swing: 'tf-badge-swing', global: 'tf-badge-global' };
                    const displayTarget = t.targetProfit ?? settings.targetProfit;
                    return (
                    <tr key={t.id || idx}>
                      <td className="font-medium">{t.ticker}</td>
                      <td>
                        <span className={`badge ${t.side?.toLowerCase() === 'buy' ? 'bg-green' : 'bg-red'}`}>
                          {t.side?.toUpperCase() || 'BUY'}
                        </span>
                      </td>
                      <td>{t.entry}</td>
                      <td>{t.exitPrice ? t.exitPrice : '—'}</td>
                      <td>{t.tp} / {t.sl}</td>
                      <td>${displayTarget}</td>
                      <td><span className={`badge tf-badge ${tfColors[tfKey] || 'tf-badge-global'}`}>{tfLabels[tfKey] || tfKey}</span></td>
                      <td>{t.quantity?.toFixed(4)}</td>
                      <td>{t.leverage || '—'}x</td>
                      <td className={t.pnl >= 0 ? (t.pnl === 0 ? 'text-neutral' : 'text-green') : 'text-red'}>
                        ${t.pnl?.toFixed(2) ?? '0.00'}
                        {t.status === 'Closed' && t.closedAt ? <span className="pnl-realized"> ✓</span> : ''}
                      </td>
                      <td>
                        <span className={`status-text ${t.status?.toLowerCase()}`}>{t.status}</span>
                      </td>
                      <td className="text-sm text-gray">
                        {t.status === 'Closed' && t.closedAt ? formatTime(t.closedAt) : formatTime(t.timestamp)}
                      </td>
                    </tr>
                    );
                  })}
                  {filteredTrades.length === 0 && (
                    <tr>
                      <td colSpan="12" className="empty-state">No trades found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
