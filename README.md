# Bybit Money Management Bot

An automated crypto trading bot that connects a TradingView Pine Script strategy to the Bybit exchange via webhooks. It handles position sizing, leverage management, and trade execution with a real-time React dashboard for monitoring.

## How It Works

```
TradingView Alert (JSON webhook)
        │
        ▼
  Flask Backend (/webhook)
        │
        ├─ Calculates position size from target profit & TP distance
        ├─ Sets leverage per symbol config
        ├─ Places limit entry order with stop-loss on Bybit
        └─ Background monitor places TP limit order after fill
              │
              └─ Cancels orphaned TP orders when SL hits
```

The Pine Script strategy (`4 EMA Fib Strategy`) runs on TradingView, detects setups using 4 EMAs and Fibonacci levels, and sends JSON alerts to the bot's webhook endpoint. The bot then executes the trade on Bybit with proper position sizing.

## Features

- **Webhook receiver** — accepts TradingView JSON alerts and places limit orders on Bybit
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
2. Choose a preset profile (Aggressive, Balanced, Conservative) or use custom settings
3. Create an alert on the strategy with:
   - **Condition:** strategy order fills / alert() function calls
   - **Webhook URL:** `https://your-domain.com/webhook`
   - **Message:** `{{strategy.order.comment}}` (or leave default — the strategy sends JSON via `alert()`)

### Webhook JSON format

```json
{
  "ticker": "BTCUSDT",
  "action": "buy",
  "limit": 65000.50,
  "entry": 65000.50,
  "tp": 67500.00,
  "sl": 63800.00
}
```

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

- Set `WEBHOOK_SECRET` to a strong random value and include it as `X-Webhook-Secret` header or `secret` field in your TradingView alert body
- API keys are loaded from environment variables, never hardcoded
- CORS is configurable via `ALLOWED_ORIGINS` — defaults to `same-origin` in production

## License

This project is unlicensed / private use.
