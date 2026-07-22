# UPI QR Checker Bot 🤖

Telegram bot that collects UPI QR payment links, checks their Stripe payment status, and returns a formatted verified/expired report.

## How to Use

1. Forward QR messages to the bot one by one
2. Each message will be acknowledged: `➕ 1 QR add hua — Total: 3`
3. When all QRs are sent, type `/done` → full list appears
4. To start fresh, type `/reset`

## Deploy on Render (Free Tier)

### Step 1 — Create Web Service
- Go to [render.com](https://render.com) → New → **Web Service**
- Connect this GitHub repo

### Step 2 — Configure
| Setting | Value |
|---|---|
| **Environment** | `Node` |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npm start` |
| **Instance Type** | Free |

### Step 3 — Environment Variables
Add this in Render → Environment:

| Key | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your bot token from @BotFather |
| `NODE_ENV` | `production` |

### Step 4 — Deploy
Click **Deploy** — bot will be live in ~2 minutes.

> ⚠️ **Note:** Render free tier sleeps after 15 minutes of inactivity. The bot uses **polling** mode so it will wake up and work normally when it receives messages after a brief delay. For 24/7 uptime, upgrade to Starter ($7/month).
