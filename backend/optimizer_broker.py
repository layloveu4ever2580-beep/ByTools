"""
Optimizer Broker — job queue bridging the mobile dashboard and the desktop
StratOptimizer Chrome extension (Option 1: remote-control architecture).

Flow:
    Phone (dashboard)  ── create job ──▶  Broker (this module)
    Desktop runner     ── claim job  ──▶  Broker
    Desktop runner     ── stream progress + result rows ──▶  Broker
    Phone (dashboard)  ── poll progress + results ──▶  Broker

All TradingView DOM work stays in the desktop extension. This module only
stores job config, streams progress, and persists result rows.

Persistence:
    <data_dir>/opt_jobs.json        — job metadata + progress (rewritten on change)
    <data_dir>/opt/<job_id>.jsonl   — result rows, append-only (one JSON per line)
"""

import os
import json
import time
import logging
import threading
from functools import wraps

from flask import Blueprint, request, jsonify

logger = logging.getLogger(__name__)

opt_bp = Blueprint("optimizer_broker", __name__)

# ── Config / auth ──
# Runner-facing endpoints require this secret (sent as X-Opt-Secret header or
# ?secret= query param). Falls back to WEBHOOK_SECRET, then open (dev only).
# Read lazily so it works regardless of when load_dotenv() runs relative to import.
_opt_secret_cache = None
_secret_warned = False


def _get_opt_secret():
    global _opt_secret_cache, _secret_warned
    if _opt_secret_cache is not None:
        return _opt_secret_cache
    secret = os.getenv("OPT_SECRET", "") or os.getenv("WEBHOOK_SECRET", "")
    if not secret or secret == "your_webhook_secret_here":
        if not _secret_warned:
            logger.warning("[opt] No OPT_SECRET/WEBHOOK_SECRET set — runner endpoints are UNAUTHENTICATED.")
            _secret_warned = True
        secret = ""
    _opt_secret_cache = secret
    return secret

# ── Storage paths (set by init_broker) ──
_DATA_DIR = os.path.dirname(__file__)
_JOBS_FILE = os.path.join(_DATA_DIR, "opt_jobs.json")
_RESULTS_DIR = os.path.join(_DATA_DIR, "opt")

# ── In-memory state ──
_jobs = {}                       # job_id -> job dict
_jobs_lock = threading.Lock()
_runner_last_seen = 0            # epoch ms of last runner contact
_RUNNER_ONLINE_WINDOW_MS = 30_000  # runner considered online if seen within 30s

_ALLOWED_METRICS = {
    "netProfit", "percentProfitable", "profitFactor", "maxDrawdown",
    "sharpeRatio", "sortinoRatio", "totalTrades",
}


# ═══════════════════════════════════════════════════════════════════════════
#  Persistence
# ═══════════════════════════════════════════════════════════════════════════

def init_broker(data_dir):
    """Point the broker at the app's data directory and load persisted jobs."""
    global _DATA_DIR, _JOBS_FILE, _RESULTS_DIR
    _DATA_DIR = data_dir
    _JOBS_FILE = os.path.join(_DATA_DIR, "opt_jobs.json")
    _RESULTS_DIR = os.path.join(_DATA_DIR, "opt")
    os.makedirs(_RESULTS_DIR, exist_ok=True)
    _load_jobs()


def _load_jobs():
    global _jobs
    if os.path.exists(_JOBS_FILE):
        try:
            with open(_JOBS_FILE, "r") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    _jobs = data
                    # Any job left "running" from a previous process is stale.
                    for j in _jobs.values():
                        if j.get("status") == "running":
                            j["status"] = "interrupted"
                    logger.info(f"[opt] Loaded {len(_jobs)} optimizer jobs from disk")
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"[opt] Failed to load jobs file: {e}")


def _save_jobs():
    try:
        tmp = _JOBS_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(_jobs, f, indent=2)
        os.replace(tmp, _JOBS_FILE)
    except IOError as e:
        logger.error(f"[opt] Failed to save jobs: {e}")


def _results_path(job_id):
    return os.path.join(_RESULTS_DIR, f"{job_id}.jsonl")


def _append_results(job_id, rows):
    """Append result rows to the job's JSONL file. Returns total line count."""
    path = _results_path(job_id)
    with open(path, "a") as f:
        for row in rows:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")


def _read_results(job_id, offset=0, limit=None):
    path = _results_path(job_id)
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, "r") as f:
        for i, line in enumerate(f):
            if i < offset:
                continue
            if limit is not None and len(rows) >= limit:
                break
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return rows


def _count_results(job_id):
    path = _results_path(job_id)
    if not os.path.exists(path):
        return 0
    with open(path, "r") as f:
        return sum(1 for line in f if line.strip())


# ═══════════════════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════════════════

def _now_ms():
    return int(time.time() * 1000)


def require_runner_secret(fn):
    """Guard runner-facing endpoints with the shared secret."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        secret = _get_opt_secret()
        if secret:
            provided = (request.headers.get("X-Opt-Secret", "")
                        or request.args.get("secret", ""))
            if provided != secret:
                body = request.get_json(silent=True) or {}
                if body.get("secret") != secret:
                    return jsonify({"error": "Unauthorized"}), 401
        _touch_runner()
        return fn(*args, **kwargs)
    return wrapper


def _touch_runner():
    global _runner_last_seen
    _runner_last_seen = _now_ms()


def _decimal_places(num_str):
    s = str(num_str)
    dot = s.find(".")
    return 0 if dot == -1 else len(s) - dot - 1


def _range_len(start, end, step):
    """Count values in an inclusive start..end range by step (integer math)."""
    try:
        start_f, end_f, step_f = float(start), float(end), float(step)
    except (ValueError, TypeError):
        return 0
    if step_f <= 0 or start_f > end_f:
        return 0
    precision = max(_decimal_places(start), _decimal_places(step))
    mult = 10 ** precision
    i_start = round(start_f * mult)
    i_end = round(end_f * mult)
    i_step = round(step_f * mult)
    if i_step <= 0:
        return 0
    return (i_end - i_start) // i_step + 1


def _count_combinations(parameters):
    """Product of unlocked-parameter range sizes. 0 if any range is invalid."""
    total = 1
    unlocked = [p for p in parameters if not p.get("locked")]
    if not unlocked:
        return 0
    for p in unlocked:
        n = _range_len(p.get("start"), p.get("end"), p.get("step"))
        if n == 0:
            return 0
        total *= n
    return total


def _validate_parameters(parameters):
    """Return (ok, error_message)."""
    if not isinstance(parameters, list) or not parameters:
        return False, "parameters must be a non-empty list"
    unlocked = [p for p in parameters if not p.get("locked")]
    if not unlocked:
        return False, "Unlock at least one parameter to optimize"
    for p in unlocked:
        if _range_len(p.get("start"), p.get("end"), p.get("step")) == 0:
            name = p.get("name", "?")
            return False, f"Invalid min/max/step for parameter '{name}'"
    return True, None


def _public_job(job):
    """A copy safe to return to the phone (no oversized fields)."""
    return {k: v for k, v in job.items() if k != "_internal"}


# ═══════════════════════════════════════════════════════════════════════════
#  Phone-facing endpoints
# ═══════════════════════════════════════════════════════════════════════════

@opt_bp.route("/api/opt/status", methods=["GET"])
def opt_status():
    """Lightweight status for the dashboard: is a desktop runner connected?"""
    online = (_now_ms() - _runner_last_seen) <= _RUNNER_ONLINE_WINDOW_MS
    with _jobs_lock:
        pending = sum(1 for j in _jobs.values() if j.get("status") == "pending")
        running = sum(1 for j in _jobs.values() if j.get("status") == "running")
    return jsonify({
        "runnerOnline": online,
        "runnerLastSeen": _runner_last_seen or None,
        "pendingJobs": pending,
        "runningJobs": running,
        "authRequired": bool(_get_opt_secret()),
    }), 200


@opt_bp.route("/api/opt/jobs", methods=["GET"])
def list_jobs():
    with _jobs_lock:
        jobs = sorted(_jobs.values(), key=lambda j: j.get("createdAt", 0), reverse=True)
        return jsonify([_public_job(j) for j in jobs]), 200


@opt_bp.route("/api/opt/jobs", methods=["POST"])
def create_job():
    data = request.get_json(silent=True) or {}
    parameters = data.get("parameters")
    config = data.get("config") or {}

    ok, err = _validate_parameters(parameters)
    if not ok:
        return jsonify({"error": err}), 400

    metric = config.get("metric", "netProfit")
    if metric not in _ALLOWED_METRICS:
        return jsonify({"error": f"Unknown metric '{metric}'"}), 400

    try:
        delay = int(config.get("delay", 1500))
    except (ValueError, TypeError):
        delay = 1500
    delay = max(500, min(delay, 30000))

    total = _count_combinations(parameters)
    job_id = f"opt-{_now_ms()}-{os.urandom(3).hex()}"
    now = _now_ms()

    job = {
        "id": job_id,
        "status": "pending",
        "createdAt": now,
        "updatedAt": now,
        "claimedAt": None,
        "completedAt": None,
        "config": {
            "strategyName": str(config.get("strategyName", "4 EMA Fib Strategy")),
            "symbol": str(config.get("symbol", "N/A")),
            "interval": str(config.get("interval", "N/A")),
            "metric": metric,
            "delay": delay,
        },
        "parameters": parameters,
        "totalCombinations": total,
        "completedCombinations": 0,
        "progress": {"completed": 0, "total": total, "percent": 0,
                     "elapsed": 0, "eta": None, "speed": None},
        "best": None,
        "stopRequested": False,
        "error": None,
        "runnerId": None,
        "resultCount": 0,
    }

    with _jobs_lock:
        _jobs[job_id] = job
        _save_jobs()

    logger.info(f"[opt] Created job {job_id}: {total} combos, metric={metric}")
    return jsonify(_public_job(job)), 201


@opt_bp.route("/api/opt/jobs/<job_id>", methods=["GET"])
def get_job(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return jsonify({"error": "Job not found"}), 404
        return jsonify(_public_job(job)), 200


@opt_bp.route("/api/opt/jobs/<job_id>/results", methods=["GET"])
def get_job_results(job_id):
    with _jobs_lock:
        if job_id not in _jobs:
            return jsonify({"error": "Job not found"}), 404
    try:
        offset = int(request.args.get("offset", 0))
    except (ValueError, TypeError):
        offset = 0
    limit_arg = request.args.get("limit")
    limit = None
    if limit_arg is not None:
        try:
            limit = max(1, min(int(limit_arg), 5000))
        except (ValueError, TypeError):
            limit = None
    rows = _read_results(job_id, offset=offset, limit=limit)
    total = _count_results(job_id)
    return jsonify({"offset": offset, "limit": limit, "total": total, "rows": rows}), 200


@opt_bp.route("/api/opt/jobs/<job_id>/stop", methods=["POST"])
def stop_job(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return jsonify({"error": "Job not found"}), 404
        if job["status"] in ("pending", "running"):
            job["stopRequested"] = True
            if job["status"] == "pending":
                # Never claimed — cancel outright.
                job["status"] = "stopped"
                job["completedAt"] = _now_ms()
            job["updatedAt"] = _now_ms()
            _save_jobs()
        return jsonify(_public_job(job)), 200


@opt_bp.route("/api/opt/jobs/<job_id>", methods=["DELETE"])
def delete_job(job_id):
    with _jobs_lock:
        job = _jobs.pop(job_id, None)
        if not job:
            return jsonify({"error": "Job not found"}), 404
        _save_jobs()
    try:
        path = _results_path(job_id)
        if os.path.exists(path):
            os.remove(path)
    except OSError as e:
        logger.warning(f"[opt] Could not remove results for {job_id}: {e}")
    return jsonify({"status": "deleted", "id": job_id}), 200


# ═══════════════════════════════════════════════════════════════════════════
#  Runner-facing endpoints (secret-protected)
# ═══════════════════════════════════════════════════════════════════════════

@opt_bp.route("/api/opt/heartbeat", methods=["POST"])
@require_runner_secret
def runner_heartbeat():
    return jsonify({"ok": True, "serverTime": _now_ms()}), 200


@opt_bp.route("/api/opt/claim", methods=["POST"])
@require_runner_secret
def claim_job():
    """Runner claims the oldest pending job. Returns {job: null} if none."""
    data = request.get_json(silent=True) or {}
    runner_id = str(data.get("runnerId", "runner"))
    with _jobs_lock:
        pending = [j for j in _jobs.values() if j.get("status") == "pending"]
        pending.sort(key=lambda j: j.get("createdAt", 0))
        if not pending:
            return jsonify({"job": None}), 200
        job = pending[0]
        job["status"] = "running"
        job["runnerId"] = runner_id
        job["claimedAt"] = _now_ms()
        job["updatedAt"] = _now_ms()
        _save_jobs()
        logger.info(f"[opt] Job {job['id']} claimed by {runner_id}")
        return jsonify({"job": _public_job(job)}), 200


@opt_bp.route("/api/opt/jobs/<job_id>/progress", methods=["POST"])
@require_runner_secret
def post_progress(job_id):
    data = request.get_json(silent=True) or {}
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return jsonify({"error": "Job not found"}), 404
        prog = data.get("progress") or {}
        job["progress"] = {
            "completed": prog.get("completed", job["progress"].get("completed", 0)),
            "total": prog.get("total", job["progress"].get("total")),
            "percent": prog.get("percent", 0),
            "elapsed": prog.get("elapsed", 0),
            "eta": prog.get("eta"),
            "speed": prog.get("speed"),
        }
        job["completedCombinations"] = job["progress"]["completed"]
        if data.get("best") is not None:
            job["best"] = data.get("best")
        job["updatedAt"] = _now_ms()
        _save_jobs()
        return jsonify({"stopRequested": job.get("stopRequested", False)}), 200


@opt_bp.route("/api/opt/jobs/<job_id>/results", methods=["POST"])
@require_runner_secret
def post_results(job_id):
    data = request.get_json(silent=True) or {}
    rows = data.get("rows")
    if not isinstance(rows, list):
        return jsonify({"error": "rows must be a list"}), 400
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return jsonify({"error": "Job not found"}), 404
    if rows:
        _append_results(job_id, rows)
    count = _count_results(job_id)
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job:
            job["resultCount"] = count
            job["updatedAt"] = _now_ms()
            _save_jobs()
            stop = job.get("stopRequested", False)
        else:
            stop = False
    return jsonify({"stopRequested": stop, "resultCount": count}), 200


@opt_bp.route("/api/opt/jobs/<job_id>/complete", methods=["POST"])
@require_runner_secret
def complete_job(job_id):
    data = request.get_json(silent=True) or {}
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return jsonify({"error": "Job not found"}), 404
        stopped = bool(data.get("stopped"))
        err = data.get("error")
        if err:
            job["status"] = "error"
            job["error"] = str(err)
        elif stopped:
            job["status"] = "stopped"
        else:
            job["status"] = "completed"
        if data.get("duration") is not None:
            job["duration"] = data.get("duration")
        if data.get("best") is not None:
            job["best"] = data.get("best")
        if data.get("completed") is not None:
            job["completedCombinations"] = data.get("completed")
            job["progress"]["completed"] = data.get("completed")
        job["resultCount"] = _count_results(job_id)
        job["completedAt"] = _now_ms()
        job["updatedAt"] = _now_ms()
        _save_jobs()
        logger.info(f"[opt] Job {job_id} finished: status={job['status']} "
                    f"results={job['resultCount']}")
        return jsonify(_public_job(job)), 200
