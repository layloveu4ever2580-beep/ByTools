import os
import json
import time
import queue
import logging
import threading
from flask import Flask, request, jsonify, send_from_directory
from pybit.unified_trading import HTTP
from dotenv import load_dotenv
from flask_cors import CORS
from leverage_config import LEVERAGE_CONFIG, save_leverage_config
from optimizer_broker import opt_bp, init_broker

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

# ── Optimizer broker (remote-control bridge for the desktop extension) ──
init_broker(_DATA_DIR)
app.register_blueprint(opt_bp)

BYBIT_API_KEY = os.getenv("BYBIT_API_KEY", "")
BYBIT_API_SECRET = os.getenv("BYBIT_API_SECRET", "")
BYBIT_TESTNET = os.getenv("BYBIT_TESTNET", "false").lower() == "true"
PORT = int(os.getenv("PORT", 5001))

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


def _fetch_symbol_filters(symbol):
    """Fetch and cache (min_qty, qty_step, tick_size) for a symbol in ONE API
    call. Previously get_symbol_info and get_tick_size each made a separate
    get_instruments_info request — doubling the latency on the hot path."""
    if symbol in _symbol_cache:
        return _symbol_cache[symbol]
    try:
        info = bybit_call(get_session().get_instruments_info, category="linear", symbol=symbol)
        instrument = info["result"]["list"][0]
        lot_filter = instrument["lotSizeFilter"]
        min_qty = float(lot_filter["minOrderQty"])
        qty_step = float(lot_filter["qtyStep"])
        tick_size = float(instrument["priceFilter"]["tickSize"])
        _symbol_cache[symbol] = (min_qty, qty_step, tick_size)
        return min_qty, qty_step, tick_size
    except Exception as e:
        logger.warning(f"[filters] Failed to fetch instrument info for {symbol}: {e}")
        return 0.001, 0.001, 0.01


def get_symbol_info(symbol):
    min_qty, qty_step, _ = _fetch_symbol_filters(symbol)
    return min_qty, qty_step


def get_tick_size(symbol):
    return _fetch_symbol_filters(symbol)[2]


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

# ── Per-trade tracking (software-managed, fully independent TP/SL) ──
# Every signal becomes an independent trade. Each trade gets its OWN
# reduce-only TP limit order and its OWN reduce-only conditional stop (SL)
# order, so multiple simultaneous trades on the same symbol keep completely
# separate TP and SL levels. There is no netting/merging of trades.

# Entries waiting to fill. Keyed by the entry order id.
# { entry_order_id: {
#     "symbol", "side", "tp_side", "tp_price", "sl_price", "qty", "trade_uid"
# } }
_pending_entries = {}

# Live trades with their exit orders placed. Keyed by the entry order id.
# { entry_order_id: {
#     "symbol", "side", "qty", "tp_price", "sl_price", "tp_side",
#     "tp_order_id", "sl_order_id", "trade_uid"
# } }
_open_trades = {}


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
    """Place a reduce-only limit order as this trade's TP. Returns orderId or None.

    Note: NO position-level trading-stop fallback here. Position-level TP/SL is
    global to the whole netted position and would destroy per-trade separation,
    so each trade only ever uses its own reduce-only order.
    """
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
        if retry:
            logger.info(f"[TP] Retrying TP limit for {symbol} in 1s...")
            time.sleep(1)
            return _place_tp_limit(session, symbol, side, qty, price, retry=False)
        logger.error(f"[TP] Limit failed for {symbol}: {tp_ord.get('retMsg')}")
        return None
    except Exception as e:
        logger.error(f"[TP] Exception placing TP for {symbol}: {e}")
        if retry:
            time.sleep(1)
            return _place_tp_limit(session, symbol, side, qty, price, retry=False)
        return None


def _place_sl_stop(session, symbol, side, qty, trigger_price, position_side, retry=True):
    """Place a reduce-only conditional stop-LIMIT order as this trade's SL.

    Each trade gets its own SL order (instead of a single position-level stop),
    so multiple trades on one symbol keep independent stop levels.

    `side` is the closing side (opposite of the entry side). `position_side`
    is the entry side ("Buy"/"Sell") used to derive the trigger direction:
      - Long  (Buy):  SL is below → trigger when price falls  → triggerDirection=2
      - Short (Sell): SL is above → trigger when price rises   → triggerDirection=1

    The order is a stop-limit: once triggerPrice is hit, a reduce-only LIMIT
    order is submitted at `limit_price`. The limit is offset a small buffer
    beyond the trigger in the fill-favouring direction so it still executes.
    Returns orderId or None.
    """
    trigger_dir = 2 if position_side == "Buy" else 1

    # Compute the protective limit price with a small slippage buffer so the
    # stop-limit reliably fills after it triggers.
    tick = get_tick_size(symbol)
    trig = float(trigger_price)
    buffer = max(tick, round_price(trig * 0.001, tick))  # ~0.1%, at least 1 tick
    if side == "Sell":   # closing a long → sell limit just BELOW trigger
        limit_price = round_price(trig - buffer, tick)
    else:                # closing a short → buy limit just ABOVE trigger
        limit_price = round_price(trig + buffer, tick)

    logger.info(f"[SL] Placing {side} reduce-only stop-limit: {symbol} qty={qty} "
                f"trigger@{trigger_price} limit@{limit_price} dir={trigger_dir}")
    try:
        sl_ord = bybit_call(session.place_order,
                            category="linear", symbol=symbol,
                            side=side, orderType="Limit", qty=str(qty),
                            price=str(limit_price),
                            triggerPrice=str(trigger_price), triggerBy="LastPrice",
                            triggerDirection=trigger_dir, reduceOnly=True,
                            timeInForce="GTC")
        logger.info(f"[SL] Response: retCode={sl_ord.get('retCode')} retMsg={sl_ord.get('retMsg')}")
        if sl_ord.get("retCode") == 0:
            return sl_ord["result"].get("orderId", "")
        if retry:
            logger.info(f"[SL] Retrying SL stop for {symbol} in 1s...")
            time.sleep(1)
            return _place_sl_stop(session, symbol, side, qty, trigger_price,
                                  position_side, retry=False)
        logger.error(f"[SL] Stop failed for {symbol}: {sl_ord.get('retMsg')}")
        return None
    except Exception as e:
        logger.error(f"[SL] Exception placing SL for {symbol}: {e}")
        if retry:
            time.sleep(1)
            return _place_sl_stop(session, symbol, side, qty, trigger_price,
                                  position_side, retry=False)
        return None


def _cancel_order_safe(session, symbol, order_id, tag=""):
    """Cancel an order, ignoring errors (e.g. already filled/cancelled)."""
    if not order_id:
        return
    try:
        bybit_call(session.cancel_order, category="linear",
                   symbol=symbol, orderId=order_id)
        logger.info(f"[cancel] {tag} order {order_id} for {symbol} cancelled")
    except Exception as e:
        logger.warning(f"[cancel] {tag} order {order_id} for {symbol} failed: {e}")


def background_monitor():
    """Background loop every 5s:
    1. Check pending entries — if filled, place TP reduce-only limit
    2. Cancel orphaned TP orders when SL hits (position gone)
    3. Periodically sync closed PnL from Bybit (every 60s)
    """
    _last_pnl_sync = 0
    while True:
        try:
            # 5s (was 3s) — lighter Bybit polling frees the single vCPU so the
            # webhook endpoint stays responsive. Fill→TP/SL attach is still fast.
            time.sleep(5)
            session = get_session()

            # ── 1. Check pending entries for fills → place this trade's TP + SL ──
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

                        # Confirm a position actually exists for the symbol.
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
                            logger.info(f"[monitor] Entry filled but no position for {sym}")
                            for t in trades:
                                if t["id"] == order_id and t["status"] == "Open":
                                    t["status"] = "Closed"
                            _save_trades()
                            continue

                        # This trade's OWN quantity — NOT the whole position.
                        trade_qty = info.get("qty")
                        tp_side = info["tp_side"]

                        # Place this trade's independent reduce-only TP limit.
                        tp_order_id = _place_tp_limit(
                            session, sym, tp_side, trade_qty, info["tp_price"]
                        )
                        # Place this trade's independent reduce-only SL stop.
                        sl_order_id = _place_sl_stop(
                            session, sym, tp_side, trade_qty,
                            info["sl_price"], info["side"]
                        )

                        _open_trades[order_id] = {
                            "symbol": sym,
                            "side": info["side"],
                            "qty": trade_qty,
                            "tp_price": info["tp_price"],
                            "sl_price": info["sl_price"],
                            "tp_side": tp_side,
                            "tp_order_id": tp_order_id,
                            "sl_order_id": sl_order_id,
                            "trade_uid": info.get("trade_uid"),
                        }
                        logger.info(f"[monitor] Trade {info.get('trade_uid')} ({sym}) live: "
                                    f"TP={tp_order_id} @ {info['tp_price']}, "
                                    f"SL={sl_order_id} @ {info['sl_price']}, qty={trade_qty}")
                        continue

                    logger.debug(f"[monitor] Entry {order_id} {sym} status unknown, will retry")

            # ── 2. Watch each live trade's TP/SL orders independently ──
            if _open_trades:
                for entry_id in list(_open_trades.keys()):
                    tr = _open_trades.get(entry_id)
                    if not tr:
                        continue
                    sym = tr["symbol"]

                    tp_status = (_check_order_status(session, sym, tr["tp_order_id"])
                                 if tr.get("tp_order_id") else "Unknown")
                    sl_status = (_check_order_status(session, sym, tr["sl_order_id"])
                                 if tr.get("sl_order_id") else "Unknown")

                    closed_reason = None
                    if tp_status == "Filled":
                        closed_reason = "TP"
                    elif sl_status == "Filled":
                        closed_reason = "SL"

                    if closed_reason:
                        logger.info(f"[monitor] Trade {tr.get('trade_uid')} ({sym}) "
                                    f"closed by {closed_reason}")
                        # Cancel the sibling exit order so it can't touch other trades.
                        if closed_reason == "TP":
                            _cancel_order_safe(session, sym, tr.get("sl_order_id"), "SL")
                        else:
                            _cancel_order_safe(session, sym, tr.get("tp_order_id"), "TP")

                        for t in trades:
                            if t["id"] == entry_id and t["status"] == "Open":
                                t["status"] = "Closed"
                                t["closeReason"] = closed_reason
                        _save_trades()
                        _open_trades.pop(entry_id, None)

            # ── 3. Safety net: if a symbol's position is fully gone but we
            #      still track open trades for it, close them and cancel any
            #      leftover exit orders (covers a missed fill detection).
            if _open_trades:
                try:
                    positions = bybit_call(session.get_positions,
                                           category="linear", settleCoin="USDT")
                    if positions.get("retCode") == 0:
                        pos_list = positions.get("result", {}).get("list", [])
                        open_syms = {p.get("symbol") for p in pos_list
                                     if float(p.get("size", 0)) > 0}
                        for entry_id in list(_open_trades.keys()):
                            tr = _open_trades.get(entry_id)
                            if not tr or tr["symbol"] in open_syms:
                                continue
                            sym = tr["symbol"]
                            logger.info(f"[monitor] Position gone for {sym}; closing "
                                        f"tracked trade {tr.get('trade_uid')}")
                            _cancel_order_safe(session, sym, tr.get("tp_order_id"), "TP")
                            _cancel_order_safe(session, sym, tr.get("sl_order_id"), "SL")
                            for t in trades:
                                if t["id"] == entry_id and t["status"] == "Open":
                                    t["status"] = "Closed"
                            _save_trades()
                            _open_trades.pop(entry_id, None)
                except Exception as e:
                    logger.warning(f"[monitor] Position sweep error: {e}")

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


import re as _re
_SYMBOL_RE = _re.compile(r"^[A-Z0-9]+$")


@app.route("/api/leverage", methods=["POST"])
def add_leverage():
    """Add or update a symbol's leverage. Body: { "symbol": "BTCUSDT", "leverage": 50 }"""
    data = request.json
    raw_symbol = (data.get("symbol") or "").strip().upper()
    leverage = data.get("leverage")

    # Accept "SYMBOL*60", "SYMBOL,60", "SYMBOL 60", "SYMBOL:60" as a convenience
    # by splitting off the leverage if it was pasted directly into the symbol field.
    split_match = _re.match(r"^([A-Z0-9]+)[\*,:\s]+(\d+)$", raw_symbol)
    if split_match:
        symbol = split_match.group(1)
        if leverage is None:
            leverage = split_match.group(2)
    else:
        symbol = raw_symbol

    if not symbol or leverage is None:
        return jsonify({"error": "symbol and leverage are required"}), 400
    if not _SYMBOL_RE.match(symbol):
        return jsonify({"error": f"Invalid symbol '{symbol}'. Use letters/numbers only, e.g. BTCUSDT"}), 400
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


# In-memory guard so a retried/duplicated alert doesn't double-fire while the
# first one is still being processed in the background.
_inflight_uids = set()
_inflight_lock = threading.Lock()

# Bounded work queue: /webhook only ENQUEUES (instant) and a small fixed pool of
# worker threads does the slow Bybit calls. This keeps the endpoint responsive
# even when many alerts fire in the same second on a candle close — a burst no
# longer spawns an unbounded number of threads that would stall the host and
# cause TradingView "request took too long" timeouts.
_signal_queue = queue.Queue()
_SIGNAL_WORKERS = 3


@app.route("/webhook", methods=["POST"])
def webhook():
    # No authentication — the webhook is open. Anyone who can reach this
    # endpoint can place trades, so restrict inbound access at the firewall
    # (e.g. allow only TradingView's IPs) if that matters.
    #
    # IMPORTANT: TradingView aborts a webhook if the HTTP response takes longer
    # than a few seconds ("request took too long and timed out"). All the slow
    # Bybit REST calls (ticker, leverage, instrument info, order placement, each
    # with retries + backoff) are therefore handed off to a background thread so
    # we can ACK immediately and delivery never times out.
    try:
        data = request.get_json(silent=True)
        if data is None:
            raw = request.get_data(as_text=True).strip()
            logger.info(f"Raw webhook body: {raw[:500]}")
            if raw.startswith("{"):
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

        # Fast, in-memory idempotency so retried/duplicated alerts don't
        # double-fire (TradingView retries a webhook it thinks failed).
        trade_uid = str(data.get("id") or f"{side}_{int(time.time() * 1000)}")
        with _inflight_lock:
            already = (trade_uid in _inflight_uids
                       or any(p.get("trade_uid") == trade_uid for p in _pending_entries.values())
                       or any(o.get("trade_uid") == trade_uid for o in _open_trades.values()))
            if data.get("id") and already:
                logger.info(f"[ENTRY] Duplicate signal for {trade_uid}, ignoring")
                return jsonify({"status": "ignored", "reason": "duplicate trade id"}), 200
            _inflight_uids.add(trade_uid)

        # Hand off the slow Bybit work to the worker pool and ACK immediately.
        _signal_queue.put((data, trade_uid))
        return jsonify({"status": "accepted", "tradeUid": trade_uid}), 200
    except Exception as e:
        logger.exception(f"Webhook error: {e}")
        return jsonify({"error": str(e)}), 500


def _process_signal(data, trade_uid):
    """Place the entry order for a validated signal. Runs in a background
    thread (spawned by /webhook) so TradingView's webhook never times out.
    Once the entry fills, background_monitor attaches this trade's own
    reduce-only TP limit and SL stop."""
    try:
        ticker = data.get("ticker")
        entry = float(data.get("limit") or data.get("entry", 0))
        tp = float(data.get("tp", 0))
        sl = float(data.get("sl", 0))
        side = str(data.get("action") or data.get("side", "Buy")).capitalize()

        ticker_info = bybit_call(get_session().get_tickers, category="linear", symbol=ticker)
        last_price = float(ticker_info["result"]["list"][0]["lastPrice"])
        logger.info(f"{ticker} last_price={last_price}, entry={entry}, tp={tp}, sl={sl}, side={side}")

        price_for_calc = entry
        tp_distance = abs(price_for_calc - tp)
        if tp_distance == 0:
            logger.error(f"[ENTRY] {trade_uid} TP distance is zero, aborting")
            return

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

        # Single cached call returns lot filters AND tick size (was two calls).
        min_qty, qty_step, tick_size = _fetch_symbol_filters(ticker)
        quantity = round_qty(raw_quantity, min_qty, qty_step)
        logger.info(f"qty={quantity} (raw={raw_quantity}, min={min_qty}, step={qty_step})")

        try:
            bybit_call(get_session().set_leverage,
                       category="linear", symbol=ticker,
                       buyLeverage=str(leverage), sellLeverage=str(leverage))
        except Exception as e:
            logger.info(f"set_leverage note: {e}")

        limit_price = round_price(entry, tick_size)
        tp_price = round_price(tp, tick_size)

        # ═══════════════════════════════════════════════════════════════
        # INDEPENDENT TRADE — every signal is its own trade with its own
        # TP and SL. The limit entry is placed WITHOUT a position-level
        # stopLoss (that would be global to the netted position). Once it
        # fills, the monitor attaches this trade's own reduce-only TP limit
        # and reduce-only conditional stop, so multiple simultaneous trades
        # on the same symbol keep completely separate TP/SL levels.
        # ═══════════════════════════════════════════════════════════════
        # Entry, TP and SL prices all come straight from the TradingView alert
        # (the strategy already applies its own Risk:Reward). The bot just
        # places them as this trade's own reduce-only orders.
        sl_price = round_price(sl, tick_size)

        logger.info(f"[ENTRY] {trade_uid} Placing LIMIT {side}: {ticker} "
                    f"qty={quantity} price={limit_price} tp={tp_price} sl={sl_price}")
        order = bybit_call(get_session().place_order,
                           category="linear", symbol=ticker, side=side,
                           orderType="Limit", qty=str(quantity),
                           price=str(limit_price), timeInForce="GTC")
        logger.info(f"[ENTRY] {trade_uid} response: {order}")

        if order.get("retCode", -1) != 0:
            error_msg = order.get("retMsg", "Unknown error")
            logger.error(f"[ENTRY] {trade_uid} rejected: {error_msg}")
            trades.append({
                "id": "failed", "tradeUid": trade_uid,
                "ticker": ticker, "side": side,
                "entry": limit_price, "tp": tp, "sl": sl_price,
                "quantity": quantity, "leverage": leverage,
                "status": "Failed", "pnl": 0.0,
                "timeframe": matched_tf or "global",
                "targetProfit": target_profit,
                "timestamp": int(time.time() * 1000), "error": error_msg
            })
            _save_trades()
            return

        entry_order_id = order["result"].get("orderId", "")
        tp_side = "Sell" if side == "Buy" else "Buy"

        # Queue this trade — monitor places its own TP + SL once the entry fills.
        _pending_entries[entry_order_id] = {
            "symbol": ticker,
            "side": side,
            "tp_side": tp_side,
            "tp_price": tp_price,
            "sl_price": sl_price,
            "qty": str(quantity),
            "trade_uid": trade_uid,
        }
        logger.info(f"[ENTRY] {trade_uid} pending: after {entry_order_id} fills → "
                    f"TP {tp_side} @ {tp_price}, SL @ {sl_price}")

        trades.append({
            "id": entry_order_id,
            "tradeUid": trade_uid,
            "ticker": ticker, "side": side, "entry": limit_price,
            "tp": tp, "sl": sl_price, "quantity": quantity,
            "leverage": leverage, "status": "Open", "pnl": 0.0,
            "entryType": "limit",
            "tpType": "limit",
            "timeframe": matched_tf or "global",
            "targetProfit": target_profit,
            "timestamp": int(time.time() * 1000)
        })
        _save_trades()
        logger.info(f"[ENTRY] {trade_uid} accepted — independent TP + SL will "
                    f"attach automatically once the entry fills.")

    except Exception as e:
        logger.exception(f"[ENTRY] {trade_uid} processing error: {e}")
    finally:
        with _inflight_lock:
            _inflight_uids.discard(trade_uid)


def _signal_worker():
    """Drain the signal queue and place orders with bounded concurrency."""
    while True:
        data, trade_uid = _signal_queue.get()
        try:
            _process_signal(data, trade_uid)
        except Exception as e:
            logger.exception(f"[worker] {trade_uid} failed: {e}")
        finally:
            _signal_queue.task_done()


# Fixed-size worker pool — bounds thread count/CPU regardless of burst size.
for _i in range(_SIGNAL_WORKERS):
    threading.Thread(target=_signal_worker, daemon=True, name=f"signal-worker-{_i}").start()


@app.route("/api/trades", methods=["GET"])
def get_trades():
    return jsonify(trades), 200


@app.route("/api/trades/<trade_id>/target-profit", methods=["PATCH"])
def update_trade_tp(trade_id):
    """Update the TP for ONE specific trade by cancelling that trade's own TP
    limit order and placing a new reduce-only TP limit for the same quantity.
    Only this trade is affected — other trades on the same symbol keep their TP.
    """
    data = request.json
    new_tp = float(data.get("targetProfit", 0))
    for t in trades:
        if t["id"] == trade_id:
            sym = t["ticker"]
            session = get_session()
            tick_size = get_tick_size(sym)
            new_tp_price = round_price(new_tp, tick_size)

            tr = _open_trades.get(trade_id)
            if not tr:
                return jsonify({"error": "Trade is not live (no active TP order)"}), 400

            # Cancel this trade's existing TP limit order.
            _cancel_order_safe(session, sym, tr.get("tp_order_id"), "TP")

            try:
                # Re-place TP for THIS trade's own quantity only.
                new_tp_order_id = _place_tp_limit(
                    session, sym, tr["tp_side"], tr["qty"], new_tp_price
                )
                if not new_tp_order_id:
                    return jsonify({"error": "Failed to place new TP order"}), 500

                tr["tp_order_id"] = new_tp_order_id
                tr["tp_price"] = new_tp_price
                t["tp"] = new_tp
                _save_trades()
                return jsonify(t), 200
            except Exception as e:
                logger.error(f"Update TP error for {sym} ({trade_id}): {e}")
                return jsonify({"error": str(e)}), 500
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
