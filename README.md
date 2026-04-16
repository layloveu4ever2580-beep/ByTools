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
        ├─ Background monitor places TP limit order after fill
        │     └─ Cancels orphaned TP orders when SL hits
        │
        └─ Dual-Confirmation Trade Flow
              │
              ├─ Trade 1 (1st confirmation): entry + SL + TP as normal
              ├─ Trade 2 (2nd confirmation): adds to position
              │     ├─ SL stays at Trade 1's original SL
              │     ├─ TP moves to Trade 2's target (full combined qty)
              │     └─ Trade 1's TP is cancelled and replaced
              └─ Both trades execute independently — Trade 2 fires
                    even if Trade 1 hasn't filled yet
```

The Pine Script strategy (`4 EMA Fib Strategy`) runs on TradingView, detects setups using 4 EMAs and Fibonacci levels, and sends JSON alerts to the bot's webhook endpoint. The bot then executes the trade on Bybit with proper position sizing.

## Dual-Confirmation Trade Logic

The strategy produces two confirmation signals per setup. The bot handles both:

| | Trade 1 (1st confirmation) | Trade 2 (2nd confirmation) |
|---|---|---|
| **Entry** | Limit order at Fib entry level | Limit order at 2nd Fib entry level |
| **Stop Loss** | Trade 1's SL (Fib-based) | Trade 1's original SL (unchanged) |
| **Take Profit** | Trade 1's TP target | Trade 2's TP target (replaces Trade 1's TP) |
| **Qty** | Sized from target profit | Sized from target profit |

After Trade 2 fills, the background monitor:
1. Cancels Trade 1's TP limit order
2. Sets the position SL to Trade 1's original SL via `set_trading_stop`
3. Places a new TP limit at Trade 2's target for the **full combined position size**

If Trade 1 gets stopped out before Trade 2 arrives, the position is cleaned up normally. Trade 2 will still be placed as a fresh Trade 1 if the setup reappears.

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

The bot automatically determines whether this is Trade 1 or Trade 2 based on whether an open position already exists for the symbol on the same side. No extra fields are needed from TradingView.

**Response includes `tradeNum`** (1 or 2) so you can verify which confirmation was processed.

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
