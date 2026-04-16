import os
import json
import time
import logging
import threading
from flask import Flask, request, jsonify, send_from_directory
from pybit.unified_trading import HTTP
from dotenv import load_dotenv
from flask_cors import CORS
from leverage_config import LEVERAGE_CONFIG, save_leverage_config

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# ── Trade persistence ──
_DATA_DIR = "/app/data" if os.path.isdir("/app/data") else os.path.dirname(__file__)
_TRADES_FILE = os.path.join(_DATA_DIR, "trades_history.json")
_trades_lock = threading.Lock()


def _load_trades():
    """Load trades from disk on startup."""
    if os.path.exists(_TRADES_FILE):
        try:
            with open(_TRADES_FILE, "r") as f:
                data = json.load(f)
                if isinstance(data, list):
                    logger.info(f"Loaded {len(data)} trades from disk")
                    return data
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"Failed to load trades file: {e}")
    return []


def _save_trades():
    """Persist trades list to disk (call after any mutation)."""
    with _trades_lock:
        try:
            with open(_TRADES_FILE, "w") as f:
                json.dump(trades, f, indent=2)
        except IOError as e:
            logger.error(f"Failed to save trades: {e}")

# CORS: allow same-origin (no restriction needed) or explicit origins
_raw_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
if _raw_origins in ("same-origin", "*", ""):
    CORS(app)
else:
    CORS(app, origins=_raw_origins.split(","))

BYBIT_API_KEY = os.getenv("BYBIT_API_KEY", "")
BYBIT_API_SECRET = os.getenv("BYBIT_API_SECRET", "")
BYBIT_TESTNET = os.getenv("BYBIT_TESTNET", "false").lower() == "true"
PORT = int(os.getenv("PORT", 5001))
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "")

_session = None


def get_session():
    global _session
    if _session is None:
        _session = HTTP(
            testnet=BYBIT_TESTNET,
            api_key=BYBIT_API_KEY,
            api_secret=BYBIT_API_SECRET,
        )
    return _session


def bybit_call(fn, *args, retries=3, **kwargs):
    """Call a Bybit API function with retry on rate limit."""
    for attempt in range(retries):
        try:
            result = fn(*args, **kwargs)
            ret_code = result.get("retCode", 0) if isinstance(result, dict) else 0
            if ret_code in (10006, 403):
                wait = 2 ** attempt + 1
                logger.warning(f"Rate limited (retCode={ret_code}), retry {attempt+1}/{retries} in {wait}s")
                time.sleep(wait)
                continue
            return result
        except Exception as e:
            err_str = str(e)
            if "rate limit" in err_str.lower() or "403" in err_str or "10006" in err_str:
                wait = 2 ** attempt + 1
                logger.warning(f"Rate limited, retry {attempt+1}/{retries} in {wait}s")
                time.sleep(wait)
                continue
            raise
    return fn(*args, **kwargs)


_symbol_cache = {}


def get_symbol_info(symbol):
    if symbol in _symbol_cache:
        return _symbol_cache[symbol]
    try:
        info = bybit_call(get_session().get_instruments_info, category="linear", symbol=symbol)
        instrument = info["result"]["list"][0]
        lot_filter = instrument["lotSizeFilter"]
        min_qty = float(lot_filter["minOrderQty"])
        qty_step = float(lot_filter["qtyStep"])
        _symbol_cache[symbol] = (min_qty, qty_step)
        return min_qty, qty_step
    except Exception:
        return 0.001, 0.001


def get_tick_size(symbol):
    try:
        info = bybit_call(get_session().get_instruments_info, category="linear", symbol=symbol)
        return float(info["result"]["list"][0]["priceFilter"]["tickSize"])
    except Exception:
        return 0.01


def round_price(price, tick_size):
    return round(round(price / tick_size) * tick_size, 8)


def round_qty(qty, min_qty, qty_step):
    if qty < min_qty:
        qty = min_qty
    steps = int(qty / qty_step)
    return round(steps * qty_step, 8)


# ── Settings persistence ──
_SETTINGS_FILE = os.path.join(_DATA_DIR, "settings.json")

_DEFAULT_SETTINGS = {
    "targetProfit": 40.0,
    "theme": "dark",
    "timezone": "UTC",
    "tpTargets": {
        "scalp": {"label": "Scalp (1m–15m)", "targetProfit": 10.0, "enabled": True, "symbols": []},
        "day": {"label": "Day Trade (15m–4h)", "targetProfit": 40.0, "enabled": True, "symbols": []},
        "swing": {"label": "Swing (4h–1D)", "targetProfit": 100.0, "enabled": True, "symbols": []},
    },
}


def _load_settings():
    """Load settings from disk, falling back to defaults."""
    if os.path.exists(_SETTINGS_FILE):
        try:
            with open(_SETTINGS_FILE, "r") as f:
                data = json.load(f)
                logger.info(f"Loaded settings from disk")
                # Merge with defaults so new keys are always present
                merged = dict(_DEFAULT_SETTINGS)
                merged.update(data)
                if "tpTargets" in data:
                    merged["tpTargets"] = data["tpTargets"]
                return merged
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"Failed to load settings file: {e}")
    return dict(_DEFAULT_SETTINGS)


def _save_settings():
    """Persist settings to disk."""
    try:
        with open(_SETTINGS_FILE, "w") as f:
            json.dump(settings, f, indent=2)
    except IOError as e:
        logger.error(f"Failed to save settings: {e}")


settings = _load_settings()
trades = _load_trades()

# Track TP limit orders: { symbol: { "orderId": "...", "side": "Sell", "qty": "..." } }
_tp_orders = {}

# Pending entries waiting for fill to place TP limit
# { orderId: { "symbol", "tp_side", "tp_price", "qty" } }
_pending_entries = {}

# ── Multi-confirmation tracking ──
# Tracks active positions awaiting a 2nd confirmation entry.
# { symbol: {
#     "trade_num": 1 or 2,
#     "trade1_entry": float,   # Trade 1 limit price (becomes SL after Trade 2 fills)
#     "trade1_sl": float,      # Trade 1 original SL
#     "trade1_tp": float,      # Trade 1 TP (used until Trade 2 overrides)
#     "trade1_qty": float,
#     "trade1_order_id": str,
#     "side": "Buy" or "Sell",
# } }
_active_positions = {}


def _check_order_status(session, symbol, order_id):
    """Check if an order was filled, cancelled, or is still open.
    Returns: 'Filled', 'Cancelled', 'Open', or 'Unknown'
    """
    # First check open orders
    try:
        resp = bybit_call(session.get_open_orders,
                          category="linear", symbol=symbol,
                          orderId=order_id)
        order_list = resp.get("result", {}).get("list", [])
        if order_list:
            st = order_list[0].get("orderStatus", "")
            if st in ("Cancelled", "Rejected", "Deactivated"):
                return "Cancelled"
            if st == "Filled":
                return "Filled"
            # New, PartiallyFilled, etc — still active
            return "Open"
    except Exception as e:
        logger.warning(f"[monitor] get_open_orders error for {order_id}: {e}")

    # Order not in open orders — check order history for definitive status
    try:
        resp = bybit_call(session.get_order_history,
                          category="linear", symbol=symbol,
                          orderId=order_id)
        order_list = resp.get("result", {}).get("list", [])
        if order_list:
            st = order_list[0].get("orderStatus", "")
            if st == "Filled":
                return "Filled"
            if st in ("Cancelled", "Rejected", "Deactivated"):
                return "Cancelled"
            return st or "Unknown"
    except Exception as e:
        logger.warning(f"[monitor] get_order_history error for {order_id}: {e}")

    return "Unknown"


def _place_tp_limit(session, symbol, side, qty, price, retry=True):
    """Place a reduce-only limit order as TP. Returns orderId or None."""
    logger.info(f"[TP] Placing {side} reduce-only limit: {symbol} qty={qty} @ {price}")
    try:
        tp_ord = bybit_call(session.place_order,
                            category="linear", symbol=symbol,
                            side=side, orderType="Limit", qty=str(qty),
                            price=str(price), reduceOnly=True,
                            timeInForce="GTC")
        logger.info(f"[TP] Response: retCode={tp_ord.get('retCode')} retMsg={tp_ord.get('retMsg')}")
        if tp_ord.get("retCode") == 0:
            return tp_ord["result"].get("orderId", "")
        # Retry once after a short pause
        if retry:
            logger.info(f"[TP] Retrying TP limit for {symbol} in 1s...")
            time.sleep(1)
            return _place_tp_limit(session, symbol, side, qty, price, retry=False)
        # Last resort: fall back to trading stop
        logger.warning(f"[TP] Limit failed for {symbol}, falling back to trading stop")
        try:
            bybit_call(session.set_trading_stop,
                       category="linear", symbol=symbol,
                       takeProfit=str(price), positionIdx=0)
            logger.info(f"[TP] Trading stop TP set for {symbol} @ {price}")
        except Exception as e2:
            logger.error(f"[TP] Trading stop also failed for {symbol}: {e2}")
        return None
    except Exception as e:
        logger.error(f"[TP] Exception placing TP for {symbol}: {e}")
        if retry:
            time.sleep(1)
            return _place_tp_limit(session, symbol, side, qty, price, retry=False)
        return None


def background_monitor():
    """Background loop every 3s:
    1. Check pending entries — if filled, place TP reduce-only limit
    2. Cancel orphaned TP orders when SL hits (position gone)
    3. Periodically sync closed PnL from Bybit (every 60s)
    """
    _last_pnl_sync = 0
    while True:
        try:
            time.sleep(3)
            session = get_session()

            # ── Check pending entries for fills ──
            if _pending_entries:
                for order_id in list(_pending_entries.keys()):
                    info = _pending_entries.get(order_id)
                    if not info:
                        continue
                    sym = info["symbol"]

                    status = _check_order_status(session, sym, order_id)

                    if status == "Open":
                        continue  # still waiting

                    if status in ("Cancelled", "Rejected", "Deactivated"):
                        logger.info(f"[monitor] Entry {order_id} {sym} was {status}")
                        _pending_entries.pop(order_id, None)
                        for t in trades:
                            if t["id"] == order_id and t["status"] == "Open":
                                t["status"] = "Cancelled"
                        _save_trades()
                        continue

                    if status == "Filled":
                        _pending_entries.pop(order_id, None)

                        # Get actual position size for TP qty
                        try:
                            pos = bybit_call(session.get_positions,
                                             category="linear", symbol=sym)
                            pos_list = pos.get("result", {}).get("list", [])
                            pos_size = 0.0
                            for p in pos_list:
                                s = float(p.get("size", 0))
                                if s > 0:
                                    pos_size = s
                                    break
                        except Exception as e:
                            logger.error(f"[monitor] Position check error for {sym}: {e}")
                            pos_size = float(info.get("qty", 0))

                        if pos_size <= 0:
                            # Position already closed (SL hit instantly)
                            logger.info(f"[monitor] Entry filled but no position for {sym} (SL hit?)")
                            for t in trades:
                                if t["id"] == order_id and t["status"] == "Open":
                                    t["status"] = "Closed"
                            _save_trades()
                            # Clean up active position tracking
                            _active_positions.pop(sym, None)
                            continue

                        is_trade2 = info.get("is_trade2", False)

                        if is_trade2:
                            # ═══ Trade 2 filled — upgrade the position ═══
                            trade1_sl = info.get("trade1_sl", 0)
                            logger.info(f"[monitor] TRADE 2 filled for {sym}. "
                                        f"Upgrading: SL→{trade1_sl} (Trade1 SL), TP→{info['tp_price']}")

                            # 1. Cancel Trade 1's TP limit order
                            existing_tp = _tp_orders.get(sym)
                            if existing_tp:
                                try:
                                    logger.info(f"[monitor] Cancelling Trade 1 TP order "
                                                f"{existing_tp['orderId']} for {sym}")
                                    bybit_call(session.cancel_order,
                                               category="linear", symbol=sym,
                                               orderId=existing_tp["orderId"])
                                except Exception as e:
                                    logger.warning(f"[monitor] Cancel Trade1 TP failed {sym}: {e}")
                                _tp_orders.pop(sym, None)

                            # 2. Update SL on the whole position to Trade 1's original SL
                            tick_size = get_tick_size(sym)
                            new_sl = round_price(trade1_sl, tick_size)
                            try:
                                logger.info(f"[monitor] Setting position SL for {sym} → {new_sl}")
                                bybit_call(session.set_trading_stop,
                                           category="linear", symbol=sym,
                                           stopLoss=str(new_sl), positionIdx=0)
                            except Exception as e:
                                logger.error(f"[monitor] Failed to update SL for {sym}: {e}")

                            # 3. Place new TP at Trade 2's target for FULL position qty
                            tp_qty = str(pos_size)
                            tp_order_id = _place_tp_limit(
                                session, sym, info["tp_side"],
                                tp_qty, info["tp_price"]
                            )
                            if tp_order_id:
                                _tp_orders[sym] = {
                                    "orderId": tp_order_id,
                                    "side": info["tp_side"],
                                    "qty": tp_qty,
                                    "price": info["tp_price"],
                                }
                                logger.info(f"[monitor] Trade 2 TP placed for {sym}: "
                                            f"{tp_order_id} @ {info['tp_price']} qty={tp_qty}")

                            # Update trade records with new TP (SL stays at Trade 1's SL)
                            for t in trades:
                                if t["ticker"] == sym and t["status"] == "Open":
                                    t["sl"] = trade1_sl
                                    t["tp"] = info["tp_price"]
                            _save_trades()

                            # Mark position as fully set up (both trades in)
                            if sym in _active_positions:
                                _active_positions[sym]["trade_num"] = 2
                                _active_positions[sym]["fully_entered"] = True

                        else:
                            # ═══ Trade 1 filled — place TP as before ═══
                            tp_qty = str(pos_size)
                            tp_order_id = _place_tp_limit(
                                session, sym, info["tp_side"],
                                tp_qty, info["tp_price"]
                            )
                            if tp_order_id:
                                _tp_orders[sym] = {
                                    "orderId": tp_order_id,
                                    "side": info["tp_side"],
                                    "qty": tp_qty,
                                    "price": info["tp_price"],
                                }
                                logger.info(f"[monitor] Trade 1 TP placed for {sym}: {tp_order_id}")
                        continue

                    # status == "Unknown" — order might still be processing
                    logger.debug(f"[monitor] Entry {order_id} {sym} status unknown, will retry")

            # ── Cancel orphaned TP orders (SL hit — position gone) ──
            if _tp_orders:
                try:
                    positions = bybit_call(session.get_positions,
                                           category="linear", settleCoin="USDT")
                    if positions.get("retCode") == 0:
                        pos_list = positions.get("result", {}).get("list", [])
                        open_syms = {p.get("symbol") for p in pos_list
                                     if float(p.get("size", 0)) > 0}
                        for sym in [s for s in list(_tp_orders.keys()) if s not in open_syms]:
                            tp_info = _tp_orders.pop(sym, None)
                            if tp_info:
                                try:
                                    logger.info(f"[monitor] Position gone for {sym}, cancelling TP {tp_info['orderId']}")
                                    bybit_call(session.cancel_order,
                                               category="linear", symbol=sym,
                                               orderId=tp_info["orderId"])
                                except Exception as e:
                                    logger.warning(f"[monitor] Cancel TP failed {sym}: {e}")
                                # Mark trade as Closed
                                for t in trades:
                                    if t["ticker"] == sym and t["status"] == "Open":
                                        t["status"] = "Closed"
                                # Clean up active position tracking
                                _active_positions.pop(sym, None)
                                _save_trades()
                except Exception as e:
                    logger.warning(f"[monitor] Orphan check error: {e}")

            # ── Check if TP limit orders themselves got filled ──
            if _tp_orders:
                for sym in list(_tp_orders.keys()):
                    tp_info = _tp_orders.get(sym)
                    if not tp_info:
                        continue
                    tp_status = _check_order_status(session, sym, tp_info["orderId"])
                    if tp_status == "Filled":
                        logger.info(f"[monitor] TP filled for {sym}")
                        _tp_orders.pop(sym, None)
                        for t in trades:
                            if t["ticker"] == sym and t["status"] == "Open":
                                t["status"] = "Closed"
                        _save_trades()
                    elif tp_status in ("Cancelled", "Rejected"):
                        logger.info(f"[monitor] TP order {tp_status} for {sym}")
                        _tp_orders.pop(sym, None)

            # ── Periodically sync closed PnL (every 60s) ──
            now = time.time()
            if now - _last_pnl_sync > 60:
                _last_pnl_sync = now
                has_unsettled = any(
                    t["status"] == "Closed" and not t.get("closedAt")
                    for t in trades
                )
                if has_unsettled:
                    try:
                        _sync_closed_pnl(session)
                        _save_trades()
                    except Exception as e:
                        logger.warning(f"[monitor] Closed PnL sync error: {e}")

        except Exception as e:
            logger.warning(f"[monitor] Loop error: {e}")


_monitor_thread = threading.Thread(target=background_monitor, daemon=True)
_monitor_thread.start()


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200


@app.route("/api/test-bybit", methods=["GET"])
def test_bybit():
    results = {}
    session = get_session()
    try:
        resp = session.get_server_time()
        results["server_time"] = {"status": "ok", "retCode": resp.get("retCode")}
    except Exception as e:
        results["server_time"] = {"status": "error", "error": str(e)}
    try:
        resp = session.get_tickers(category="linear", symbol="BTCUSDT")
        price = resp["result"]["list"][0]["lastPrice"] if resp.get("retCode") == 0 else None
        results["ticker"] = {"status": "ok", "price": price}
    except Exception as e:
        results["ticker"] = {"status": "error", "error": str(e)}
    try:
        resp = session.get_wallet_balance(accountType="UNIFIED")
        results["wallet"] = {"status": "ok", "retCode": resp.get("retCode")}
    except Exception as e:
        results["wallet"] = {"status": "error", "error": str(e)}
    try:
        resp = session.get_positions(category="linear", settleCoin="USDT")
        if resp.get("retCode") == 0:
            pos_list = resp.get("result", {}).get("list", [])
            open_pos = [p for p in pos_list if float(p.get("size", 0)) > 0]
            results["positions"] = {"status": "ok", "total": len(pos_list), "open": len(open_pos)}
    except Exception as e:
        results["positions"] = {"status": "error", "error": str(e)}
    results["config"] = {
        "api_key_prefix": BYBIT_API_KEY[:6] + "..." if len(BYBIT_API_KEY) > 6 else "(not set)",
        "testnet": BYBIT_TESTNET,
    }
    return jsonify(results), 200


@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify(settings), 200


@app.route("/api/settings", methods=["POST"])
def update_settings():
    global settings
    data = request.json
    if "targetProfit" in data:
        settings["targetProfit"] = float(data["targetProfit"])
    if "theme" in data:
        settings["theme"] = data["theme"]
    if "timezone" in data:
        settings["timezone"] = data["timezone"]
    if "tpTargets" in data:
        for key, val in data["tpTargets"].items():
            if key in settings["tpTargets"]:
                if "targetProfit" in val:
                    settings["tpTargets"][key]["targetProfit"] = float(val["targetProfit"])
                if "enabled" in val:
                    settings["tpTargets"][key]["enabled"] = bool(val["enabled"])
                if "label" in val:
                    settings["tpTargets"][key]["label"] = str(val["label"])
                if "symbols" in val:
                    new_syms = [s.strip().upper() for s in val["symbols"] if s.strip()]
                    # Remove these symbols from all OTHER timeframes to prevent duplicates
                    for other_key in settings["tpTargets"]:
                        if other_key != key:
                            settings["tpTargets"][other_key]["symbols"] = [
                                s for s in settings["tpTargets"][other_key].get("symbols", [])
                                if s not in new_syms
                            ]
                    settings["tpTargets"][key]["symbols"] = new_syms
            else:
                # Allow adding custom timeframe targets
                syms = [s.strip().upper() for s in val.get("symbols", []) if s.strip()]
                settings["tpTargets"][key] = {
                    "label": str(val.get("label", key)),
                    "targetProfit": float(val.get("targetProfit", 40.0)),
                    "enabled": bool(val.get("enabled", True)),
                    "symbols": syms,
                }
    _save_settings()
    return jsonify(settings), 200


@app.route("/api/leverage", methods=["GET"])
def get_leverage():
    return jsonify(LEVERAGE_CONFIG), 200


@app.route("/api/leverage", methods=["POST"])
def add_leverage():
    """Add or update a symbol's leverage. Body: { "symbol": "BTCUSDT", "leverage": 50 }"""
    data = request.json
    symbol = (data.get("symbol") or "").strip().upper()
    leverage = data.get("leverage")
    if not symbol or leverage is None:
        return jsonify({"error": "symbol and leverage are required"}), 400
    try:
        leverage = int(leverage)
    except (ValueError, TypeError):
        return jsonify({"error": "leverage must be an integer"}), 400
    if leverage < 1 or leverage > 100:
        return jsonify({"error": "leverage must be between 1 and 100"}), 400
    LEVERAGE_CONFIG[symbol] = leverage
    save_leverage_config(LEVERAGE_CONFIG)
    return jsonify(LEVERAGE_CONFIG), 200


@app.route("/api/leverage/<symbol>", methods=["DELETE"])
def delete_leverage(symbol):
    symbol = symbol.strip().upper()
    if symbol not in LEVERAGE_CONFIG:
        return jsonify({"error": f"{symbol} not found"}), 404
    del LEVERAGE_CONFIG[symbol]
    save_leverage_config(LEVERAGE_CONFIG)
    return jsonify(LEVERAGE_CONFIG), 200


@app.route("/webhook", methods=["POST"])
def webhook():
    if WEBHOOK_SECRET and WEBHOOK_SECRET != "your_webhook_secret_here":
        token = request.headers.get("X-Webhook-Secret", "")
        if token != WEBHOOK_SECRET:
            body = request.get_json(silent=True) or {}
            if body.get("secret") != WEBHOOK_SECRET:
                return jsonify({"error": "Unauthorized"}), 401

    try:
        data = request.get_json(silent=True)
        if data is None:
            raw = request.get_data(as_text=True).strip()
            logger.info(f"Raw webhook body: {raw[:500]}")
            if raw.startswith("{"):
                import json
                try:
                    data = json.loads(raw)
                except Exception:
                    pass
            if data is None:
                return jsonify({"status": "ignored", "reason": "not a trade signal"}), 200

        logger.info(f"Webhook received: {data}")

        if "ticker" not in data or "tp" not in data:
            logger.info(f"Ignoring non-trade alert: {data}")
            return jsonify({"status": "ignored", "reason": "not a trade signal"}), 200

        ticker = data.get("ticker")
        # Prefer 'limit' field for explicit limit price, fall back to 'entry'
        entry = float(data.get("limit") or data.get("entry", 0))
        tp = float(data.get("tp", 0))
        sl = float(data.get("sl", 0))
        side = str(data.get("action") or data.get("side", "Buy")).capitalize()

        if not all([ticker, tp, sl]):
            return jsonify({"error": "Missing parameters (ticker, tp, sl required)"}), 400

        if entry <= 0:
            return jsonify({"error": "Missing or invalid entry/limit price"}), 400

        ticker_info = bybit_call(get_session().get_tickers, category="linear", symbol=ticker)
        last_price = float(ticker_info["result"]["list"][0]["lastPrice"])
        logger.info(f"{ticker} last_price={last_price}, entry={entry}, tp={tp}, sl={sl}, side={side}")

        price_for_calc = entry
        tp_distance = abs(price_for_calc - tp)
        if tp_distance == 0:
            return jsonify({"error": "TP distance is zero"}), 400

        # Use timeframe-specific target profit if provided in webhook data
        timeframe_key = data.get("timeframe", "").lower().strip()
        target_profit = settings.get("targetProfit", 40.0)
        tp_targets = settings.get("tpTargets", {})
        matched_tf = None
        if timeframe_key and timeframe_key in tp_targets:
            tf_cfg = tp_targets[timeframe_key]
            if tf_cfg.get("enabled", True):
                target_profit = tf_cfg.get("targetProfit", target_profit)
                matched_tf = timeframe_key
                logger.info(f"Using {timeframe_key} target profit: ${target_profit}")
        else:
            # Match ticker to a timeframe by its symbol list
            for _key, tf_cfg in tp_targets.items():
                if tf_cfg.get("enabled", True) and ticker in tf_cfg.get("symbols", []):
                    target_profit = tf_cfg.get("targetProfit", target_profit)
                    matched_tf = _key
                    logger.info(f"Matched {ticker} to {_key} target profit: ${target_profit}")
                    break
            if matched_tf is None:
                # No symbol match — fall back to global targetProfit
                logger.info(f"No timeframe match for {ticker}, using global target profit: ${target_profit}")
        raw_quantity = target_profit / tp_distance
        leverage = LEVERAGE_CONFIG.get(ticker, 10)

        min_qty, qty_step = get_symbol_info(ticker)
        quantity = round_qty(raw_quantity, min_qty, qty_step)
        logger.info(f"qty={quantity} (raw={raw_quantity}, min={min_qty}, step={qty_step})")

        try:
            bybit_call(get_session().set_leverage,
                       category="linear", symbol=ticker,
                       buyLeverage=str(leverage), sellLeverage=str(leverage))
        except Exception as e:
            logger.info(f"set_leverage note: {e}")

        tick_size = get_tick_size(ticker)
        limit_price = round_price(entry, tick_size)
        tp_price = round_price(tp, tick_size)

        # ── Determine if this is Trade 1 (new) or Trade 2 (add to existing) ──
        existing = _active_positions.get(ticker)
        is_trade2 = (existing is not None
                     and existing.get("trade_num") == 1
                     and existing.get("side") == side)

        if is_trade2:
            # ═══════════════════════════════════════════════════════════
            # TRADE 2: Second confirmation — add to position
            # SL moves to Trade 1's entry, TP becomes Trade 2's target
            # ═══════════════════════════════════════════════════════════
            trade1_entry = existing["trade1_entry"]
            trade1_sl = existing["trade1_sl"]
            logger.info(f"[TRADE2] {ticker}: Adding to position. "
                        f"Trade1 entry={trade1_entry}, Trade2 entry={limit_price}, "
                        f"New SL={trade1_sl} (Trade1 SL), New TP={tp_price}")

            # Place Trade 2 limit entry with SL at Trade 1's original SL
            sl_for_trade2 = round_price(trade1_sl, tick_size)
            logger.info(f"[TRADE2] Placing LIMIT {side}: {ticker} qty={quantity} "
                        f"price={limit_price} sl={sl_for_trade2}")
            order = bybit_call(get_session().place_order,
                               category="linear", symbol=ticker, side=side,
                               orderType="Limit", qty=str(quantity),
                               price=str(limit_price), stopLoss=str(sl_for_trade2),
                               timeInForce="GTC")
            logger.info(f"[TRADE2] Entry response: {order}")

            if order.get("retCode", -1) != 0:
                error_msg = order.get("retMsg", "Unknown error")
                logger.error(f"[TRADE2] Entry rejected: {error_msg}")
                trades.append({
                    "id": "failed", "ticker": ticker, "side": side,
                    "entry": limit_price, "tp": tp, "sl": sl_for_trade2,
                    "quantity": quantity, "leverage": leverage,
                    "status": "Failed", "pnl": 0.0,
                    "tradeNum": 2,
                    "timeframe": matched_tf or "global",
                    "targetProfit": target_profit,
                    "timestamp": int(time.time() * 1000), "error": error_msg
                })
                _save_trades()
                return jsonify({"error": error_msg}), 400

            entry_order_id = order["result"].get("orderId", "")
            tp_side = "Sell" if side == "Buy" else "Buy"

            # Track Trade 2 pending entry — monitor will:
            #   1. Cancel Trade 1's TP limit
            #   2. Update SL on the whole position to Trade 1's entry
            #   3. Place new TP at Trade 2's target for the full combined qty
            _pending_entries[entry_order_id] = {
                "symbol": ticker,
                "tp_side": tp_side,
                "tp_price": tp_price,
                "qty": str(quantity),
                "is_trade2": True,
                "trade1_entry": trade1_entry,
                "trade1_sl": existing.get("trade1_sl"),
                "trade1_qty": existing.get("trade1_qty"),
            }

            # Update active position tracking
            _active_positions[ticker]["trade_num"] = 2
            _active_positions[ticker]["trade2_order_id"] = entry_order_id
            _active_positions[ticker]["trade2_entry"] = limit_price
            _active_positions[ticker]["trade2_tp"] = tp_price
            _active_positions[ticker]["trade2_qty"] = quantity

            logger.info(f"[TRADE2] Pending for {ticker}: after {entry_order_id} fills → "
                        f"cancel Trade1 TP, set SL={sl_for_trade2}, TP={tp_price}")

            trades.append({
                "id": entry_order_id,
                "ticker": ticker, "side": side, "entry": limit_price,
                "tp": tp, "sl": sl_for_trade2, "quantity": quantity,
                "leverage": leverage, "status": "Open", "pnl": 0.0,
                "entryType": "limit",
                "tpType": "limit",
                "tradeNum": 2,
                "timeframe": matched_tf or "global",
                "targetProfit": target_profit,
                "timestamp": int(time.time() * 1000)
            })
            _save_trades()
            return jsonify({
                "status": "success", "order": order,
                "entryType": "limit", "tpType": "limit",
                "tradeNum": 2,
                "note": f"Trade 2 placed. After fill: SL→{sl_for_trade2}, TP→{tp_price}"
            }), 200

        else:
            # ═══════════════════════════════════════════════════════════
            # TRADE 1: First confirmation — standard entry
            # ═══════════════════════════════════════════════════════════
            logger.info(f"[TRADE1] Placing LIMIT {side}: {ticker} qty={quantity} "
                        f"price={limit_price} sl={sl}")
            order = bybit_call(get_session().place_order,
                               category="linear", symbol=ticker, side=side,
                               orderType="Limit", qty=str(quantity),
                               price=str(limit_price), stopLoss=str(sl),
                               timeInForce="GTC")
            logger.info(f"[TRADE1] Entry response: {order}")

            if order.get("retCode", -1) != 0:
                error_msg = order.get("retMsg", "Unknown error")
                logger.error(f"[TRADE1] Entry rejected: {error_msg}")
                trades.append({
                    "id": "failed", "ticker": ticker, "side": side,
                    "entry": limit_price, "tp": tp, "sl": sl,
                    "quantity": quantity, "leverage": leverage,
                    "status": "Failed", "pnl": 0.0,
                    "tradeNum": 1,
                    "timeframe": matched_tf or "global",
                    "targetProfit": target_profit,
                    "timestamp": int(time.time() * 1000), "error": error_msg
                })
                _save_trades()
                return jsonify({"error": error_msg}), 400

            entry_order_id = order["result"].get("orderId", "")
            tp_side = "Sell" if side == "Buy" else "Buy"
            _pending_entries[entry_order_id] = {
                "symbol": ticker,
                "tp_side": tp_side,
                "tp_price": tp_price,
                "qty": str(quantity),
            }
            logger.info(f"[TRADE1] Pending TP for {ticker}: after {entry_order_id} fills → "
                        f"{tp_side} limit @ {tp_price}")

            # Register as Trade 1 — waiting for potential Trade 2
            _active_positions[ticker] = {
                "trade_num": 1,
                "trade1_entry": limit_price,
                "trade1_sl": sl,
                "trade1_tp": tp_price,
                "trade1_qty": quantity,
                "trade1_order_id": entry_order_id,
                "side": side,
            }

            trades.append({
                "id": entry_order_id,
                "ticker": ticker, "side": side, "entry": limit_price,
                "tp": tp, "sl": sl, "quantity": quantity,
                "leverage": leverage, "status": "Open", "pnl": 0.0,
                "entryType": "limit",
                "tpType": "limit",
                "tradeNum": 1,
                "timeframe": matched_tf or "global",
                "targetProfit": target_profit,
                "timestamp": int(time.time() * 1000)
            })
            _save_trades()
            return jsonify({
                "status": "success", "order": order,
                "entryType": "limit", "tpType": "limit",
                "tradeNum": 1,
                "note": "Trade 1 placed. Awaiting Trade 2 confirmation."
            }), 200

    except Exception as e:
        logger.exception(f"Webhook error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/trades", methods=["GET"])
def get_trades():
    return jsonify(trades), 200


@app.route("/api/trades/<trade_id>/target-profit", methods=["PATCH"])
def update_trade_tp(trade_id):
    """Update TP for an existing trade by cancelling old TP limit and placing a new one."""
    data = request.json
    new_tp = float(data.get("targetProfit", 0))
    for t in trades:
        if t["id"] == trade_id:
            sym = t["ticker"]
            session = get_session()
            tick_size = get_tick_size(sym)
            new_tp_price = round_price(new_tp, tick_size)

            # Cancel existing TP limit order if any
            existing_tp = _tp_orders.get(sym)
            if existing_tp:
                try:
                    logger.info(f"Cancelling old TP order {existing_tp['orderId']} for {sym}")
                    bybit_call(session.cancel_order,
                               category="linear", symbol=sym,
                               orderId=existing_tp["orderId"])
                except Exception as e:
                    logger.warning(f"Cancel old TP failed for {sym}: {e}")
                _tp_orders.pop(sym, None)

            # Determine TP side and qty from position
            try:
                pos = bybit_call(session.get_positions,
                                 category="linear", symbol=sym)
                pos_list = pos.get("result", {}).get("list", [])
                pos_size = 0.0
                pos_side = ""
                for p in pos_list:
                    s = float(p.get("size", 0))
                    if s > 0:
                        pos_size = s
                        pos_side = p.get("side", "")
                        break

                if pos_size <= 0:
                    return jsonify({"error": "No open position found"}), 400

                # TP side is opposite of position side
                tp_side = "Sell" if pos_side == "Buy" else "Buy"
                tp_order_id = _place_tp_limit(
                    session, sym, tp_side, str(pos_size), new_tp_price
                )
                if tp_order_id:
                    _tp_orders[sym] = {
                        "orderId": tp_order_id,
                        "side": tp_side,
                        "qty": str(pos_size),
                        "price": new_tp_price,
                    }
                t["tp"] = new_tp
                _save_trades()
                return jsonify(t), 200

            except Exception as e:
                logger.error(f"Update TP error for {sym}: {e}")
                # Fallback: try set_trading_stop
                try:
                    bybit_call(session.set_trading_stop,
                               category="linear", symbol=sym,
                               takeProfit=str(new_tp_price), positionIdx=0)
                    t["tp"] = new_tp
                    _save_trades()
                    return jsonify(t), 200
                except Exception as e2:
                    return jsonify({"error": str(e2)}), 500
    return jsonify({"error": "Trade not found"}), 404


@app.route("/api/sync-trades", methods=["POST"])
def sync_trades():
    try:
        session = get_session()

        # ── 1. Fetch all open positions ──
        all_positions = []
        cursor = ""
        while True:
            params = {"category": "linear", "settleCoin": "USDT", "limit": 200}
            if cursor:
                params["cursor"] = cursor
            positions = bybit_call(session.get_positions, **params)

            if positions.get("retCode", -1) != 0:
                error_msg = positions.get("retMsg", "Bybit API error")
                logger.error(f"sync error: {error_msg}")
                return jsonify({"error": error_msg}), 502

            all_positions.extend(positions.get("result", {}).get("list", []))
            cursor = positions.get("result", {}).get("nextPageCursor", "")
            if not cursor:
                break

        # Update PnL for open positions and add new synced ones
        for pos in all_positions:
            size = float(pos.get("size", 0))
            if size == 0:
                continue
            symbol = pos.get("symbol", "")
            unrealised_pnl = float(pos.get("unrealisedPnl", 0))

            matched = False
            for t in trades:
                if t["ticker"] == symbol and t["status"] == "Open":
                    t["pnl"] = unrealised_pnl
                    matched = True

            if not matched:
                created = pos.get("createdTime", "")
                try:
                    ts = int(float(created)) if created else int(time.time() * 1000)
                except (ValueError, TypeError):
                    ts = int(time.time() * 1000)
                trades.append({
                    "id": f"synced-{symbol}-{int(time.time())}",
                    "ticker": symbol,
                    "side": pos.get("side", "Buy"),
                    "entry": float(pos.get("avgPrice", 0)),
                    "tp": float(pos.get("takeProfit", 0) or 0),
                    "sl": float(pos.get("stopLoss", 0) or 0),
                    "quantity": size,
                    "leverage": int(float(pos.get("leverage", 1) or 1)),
                    "status": "Open",
                    "pnl": unrealised_pnl,
                    "timestamp": ts
                })

        # Mark trades as Closed if position no longer exists
        open_symbols = {p.get("symbol") for p in all_positions if float(p.get("size", 0)) > 0}
        for t in trades:
            if t["status"] == "Open" and t["ticker"] not in open_symbols:
                t["status"] = "Closed"

        # ── 2. Fetch closed PnL from Bybit to update realized PnL ──
        _sync_closed_pnl(session)

        _save_trades()
        logger.info(f"Synced {len(all_positions)} positions")
        return jsonify({"status": "synced", "positions": len(all_positions)}), 200
    except Exception as e:
        logger.exception(f"sync error: {e}")
        return jsonify({"error": str(e)}), 500


def _sync_closed_pnl(session):
    """Fetch closed PnL records from Bybit and update trades with realized PnL.
    Pulls the last 7 days of closed PnL data.
    """
    try:
        # Collect all closed PnL records (paginated)
        closed_records = []
        cursor = ""
        start_time = int((time.time() - 7 * 86400) * 1000)  # 7 days ago
        pages = 0
        while pages < 10:  # safety limit
            params = {
                "category": "linear",
                "limit": 100,
                "startTime": start_time,
            }
            if cursor:
                params["cursor"] = cursor
            resp = bybit_call(session.get_closed_pnl, **params)
            if resp.get("retCode") != 0:
                logger.warning(f"get_closed_pnl error: {resp.get('retMsg')}")
                break
            records = resp.get("result", {}).get("list", [])
            closed_records.extend(records)
            cursor = resp.get("result", {}).get("nextPageCursor", "")
            pages += 1
            if not cursor:
                break

        if not closed_records:
            return

        logger.info(f"Fetched {len(closed_records)} closed PnL records from Bybit")

        # Build a lookup: symbol → list of closed PnL entries (most recent first)
        # Each record has: symbol, orderId, closedPnl, avgEntryPrice, avgExitPrice,
        #                   qty, createdTime, updatedTime, side, orderType
        for record in closed_records:
            symbol = record.get("symbol", "")
            order_id = record.get("orderId", "")
            closed_pnl = float(record.get("closedPnl", 0))
            avg_exit = float(record.get("avgExitPrice", 0))
            updated_time = record.get("updatedTime", "")
            try:
                close_ts = int(float(updated_time)) if updated_time else 0
            except (ValueError, TypeError):
                close_ts = 0

            # Try to match by order ID first (most accurate)
            matched = False
            for t in trades:
                if t["id"] == order_id:
                    if t["status"] != "Open":
                        t["pnl"] = closed_pnl
                        if avg_exit:
                            t["exitPrice"] = avg_exit
                        if close_ts:
                            t["closedAt"] = close_ts
                    matched = True
                    break

            if matched:
                continue

            # Match by symbol + status Closed + no realized PnL yet
            # Use timestamp proximity to find the right trade
            for t in trades:
                if (t["ticker"] == symbol
                        and t["status"] == "Closed"
                        and t.get("pnl", 0) == 0
                        and not t.get("closedAt")):
                    t["pnl"] = closed_pnl
                    if avg_exit:
                        t["exitPrice"] = avg_exit
                    if close_ts:
                        t["closedAt"] = close_ts
                    matched = True
                    break

            if matched:
                continue

            # Match by symbol + Closed + timestamp within 1 hour
            for t in trades:
                if (t["ticker"] == symbol
                        and t["status"] == "Closed"
                        and not t.get("closedAt")):
                    trade_ts = t.get("timestamp", 0)
                    if close_ts and trade_ts and abs(close_ts - trade_ts) < 3600000:
                        t["pnl"] = closed_pnl
                        if avg_exit:
                            t["exitPrice"] = avg_exit
                        t["closedAt"] = close_ts
                        break

    except Exception as e:
        logger.warning(f"_sync_closed_pnl error: {e}")


# ── Serve React frontend ──
DIST_DIR = os.path.join(os.path.dirname(__file__), "dist")

@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_react(path):
    if path and os.path.exists(os.path.join(DIST_DIR, path)):
        return send_from_directory(DIST_DIR, path)
    return send_from_directory(DIST_DIR, "index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
