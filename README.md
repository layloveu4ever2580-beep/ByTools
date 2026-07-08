
An automated crypto trading bot that connects a TradingView Pine Script strategy to the Bybit exchange via webhooks. It handles position sizing, leverage management, and trade execution with a real-time React dashboard for monitoring.

## How It Works

```
TradingView Alert (JSON webhook, one per signal)
        │
        ▼
  Flask Backend (/webhook)
        │
        ├─ Verifies webhook secret
        ├─ Calculates position size from target profit & TP distance
        ├─ Sets leverage per symbol config
        ├─ Places a limit entry order (no position-level stop)
        │
        └─ Background monitor (every 3s), per independent trade:
              ├─ On entry fill → places THIS trade's own:
              │     ├─ reduce-only limit TP order
              │     └─ reduce-only conditional stop (SL) order
              ├─ On TP fill → cancels that trade's SL
              ├─ On SL fill → cancels that trade's TP
              └─ Safety net: if the symbol's position is gone,
                    closes tracked trades and cancels leftover orders
```

The Pine Script strategy (`4 EMA Fib Strategy`) runs on TradingView, detects setups using 4 EMAs and Fibonacci levels, and sends JSON alerts to the bot's webhook endpoint. The bot then executes the trade on Bybit with proper position sizing.

## Independent Per-Trade TP/SL

Every signal is treated as a fully independent trade with its own unique `id`
(sent by the Pine script). Each trade gets its **own** reduce-only take-profit
limit order and its **own** reduce-only conditional stop-loss order, sized to
that trade's own quantity.

| | Each trade |
|---|---|
| **Entry** | Limit order at the Fib entry level (no position-level stop) |
| **Take Profit** | Own reduce-only limit order at that trade's TP |
| **Stop Loss** | Own reduce-only conditional stop at that trade's SL |
| **Qty** | Sized from target profit ÷ TP distance |

Because Bybit nets positions per symbol, trades on the same symbol share one
underlying position, but their TP/SL orders are separate — so multiple
simultaneous trades on one symbol keep independent exit levels. When one
trade's TP or SL fills, the monitor cancels that trade's sibling order so it
can't affect the others.

> **Position mode:** this assumes the Bybit account is in **One-Way** mode
> (`positionIdx=0`). Reduce-only orders let each trade manage its own slice of
> the netted position.

## Features

- **Webhook receiver** — accepts TradingView JSON alerts and places limit orders on Bybit
- **Dual-confirmation entries** — automatically stacks two trades per setup, managing SL/TP across both
- **Smart position sizing** — calculates quantity from a target profit dollar amount and TP distance
- **Per-symbol leverage** — configurable leverage for each trading pair (persisted to disk)
- **Background order monitor** — polls every 3s to place TP limits after entry fills and cancel orphans
- **Trade sync** — pulls open positions from Bybit and reconciles with local trade state
- **React dashboard** — live PnL, win rate, trade history, leverage config, and theme toggle
- **Single-container deploy** — Flask serves both the API and the built React frontend

## Tech Stack

| Layer | Technology |
|---|---|
| Strategy | Pine Script v6 (TradingView) |
| Backend | Python 3.11, Flask, pybit, gunicorn |
| Frontend | React 19, Vite, Lucide icons |
| Deployment | Docker (multi-stage), Render |

## Project Structure

```
├── backend/
│   ├── main.py                 # Flask app — webhook, API routes, background monitor
│   ├── leverage_config.py      # Per-symbol leverage config (JSON persistence)
│   ├── test_bybit_api.py       # Bybit API connectivity test script
│   ├── requirements.txt
│   └── .env                    # API keys and config (not committed)
├── frontend/
│   ├── src/
│   │   ├── App.jsx             # Dashboard UI — stats, trade table, leverage panel
│   │   ├── App.css
│   │   └── main.jsx
│   ├── vite.config.js          # Dev proxy to Flask backend
│   └── package.json
├── pinescript/
│   └── 4ema_fib_strategy.pine  # TradingView strategy with webhook alerts
├── Dockerfile                  # Multi-stage: build React → serve with Flask
├── docker-compose.yml
└── render.yaml                 # Render.com deployment config
```

## Getting Started

### Prerequisites

- Python 3.11+
- Node.js 20+
- A Bybit account with API keys (supports both mainnet and testnet)

### 1. Clone and configure

```bash
git clone <repo-url>
cd <repo-name>
```

Create `backend/.env`:

```env
BYBIT_API_KEY=your_api_key
BYBIT_API_SECRET=your_api_secret
BYBIT_TESTNET=false
PORT=5001
WEBHOOK_SECRET=your_webhook_secret_here
ALLOWED_ORIGINS=http://localhost:3000
```

### 2. Run locally (development)

**Backend:**

```bash
cd backend
pip install -r requirements.txt
python main.py
```

**Frontend:**

```bash
cd frontend
npm install
npm run dev
```

The frontend dev server runs on `http://localhost:3000` and proxies API calls to the Flask backend on port 5001.

### 3. Run with Docker

```bash
docker compose up --build
```

The app is available at `http://localhost:5001`. Flask serves both the API and the React build.

### 4. Test Bybit connectivity

```bash
cd backend
python test_bybit_api.py
```

Runs checks against public and authenticated Bybit endpoints to verify your API keys work.

## TradingView Setup

1. Add `pinescript/4ema_fib_strategy.pine` to TradingView
2. Choose a preset profile (P1–P6) or use custom settings
3. Create an alert on the strategy with:
   - **Condition:** the strategy / "Any alert() function call"
   - **Webhook URL:** `https://your-domain.com/webhook` (TradingView requires HTTPS on port 80/443)
   - **Message:** leave default — the strategy sends its JSON via `alert()`

### Webhook JSON format

The Pine script emits this automatically (the `id` keeps each trade independent):

```json
{
  "id": "Long_1234",
  "ticker": "BTCUSDT",
  "action": "buy",
  "limit": 65000.50,
  "entry": 65000.50,
  "tp": 67500.00,
  "sl": 63800.00
}
```

> **Authentication:** TradingView cannot send custom HTTP headers. If you set a
> `WEBHOOK_SECRET`, the simplest way to authenticate — without putting the
> secret in the public Pine script — is to append it to the webhook URL as a
> query param: `https://your-domain.com/webhook?secret=<your-secret>`. The bot
> also accepts the secret via an `X-Webhook-Secret` header or a `"secret"` field
> in the JSON body. Repeated signals with the same `id` are ignored, so a
> retried alert won't open a duplicate trade.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhook` | Receive TradingView alerts and place trades |
| `GET` | `/api/trades` | List all tracked trades |
| `POST` | `/api/sync-trades` | Sync open positions from Bybit |
| `PATCH` | `/api/trades/:id/target-profit` | Update TP for an existing trade |
| `GET/POST` | `/api/settings` | Get or update bot settings (target profit, theme) |
| `GET` | `/api/leverage` | Get leverage config for all symbols |
| `POST` | `/api/leverage` | Add or update a symbol's leverage |
| `DELETE` | `/api/leverage/:symbol` | Remove a symbol from leverage config |
| `GET` | `/api/test-bybit` | Test Bybit API connectivity |
| `GET` | `/health` | Health check |

## Deployment (Render)

The included `render.yaml` defines a Docker web service. Set these environment variables in Render:

- `BYBIT_API_KEY`
- `BYBIT_API_SECRET`
- `WEBHOOK_SECRET`
- `BYBIT_TESTNET` (default: `false`)

## Security Notes

- Set `WEBHOOK_SECRET` to a strong random value. TradingView can't send headers, so include it as a `secret` field in the alert JSON body (the `X-Webhook-Secret` header also works for non-TradingView callers)
- API keys are loaded from environment variables, never hardcoded
- CORS is configurable via `ALLOWED_ORIGINS` — defaults to `same-origin` in production

## License

This project is unlicensed / private use.
