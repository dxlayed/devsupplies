# Waurks — Modern Roblox Anti-Botter & MM2 Trader

Waurks is a high-speed, server-authoritative Roblox anti-bot platform powered by an **open-source browser extension** and server-side heuristic detection engine.

- **100% Open Source Extension**: Zero cookie logging. Does not request or touch `.ROBLOSECURITY` cookies or account passwords.
- **Server-Authoritative Heuristics**: Multi-layered threat scoring (entropy, scam links, account age, badges, flood waves, MM2 level badges).
- **Public GitHub Repository**: [github.com/dxlayed/devsupplies](https://github.com/dxlayed/devsupplies)

---

## 🔒 Security & Zero Cookie Logging Guarantee

Waurks prioritizes account security and full transparency:
1. **No Cookie Permissions in Extension**: The Chrome extension manifest (`manifest.json`) strictly declares only `"storage"` and `"alarms"` permissions. Chrome prevents the extension from reading or intercepting your `.ROBLOSECURITY` cookie.
2. **Official In-Browser API**: The extension queries Roblox's friend request endpoint directly in your existing browser session (`credentials: 'include'`). Sensitive session tokens never leave your computer.
3. **Uncrackable Server Detection**: 100% of the bot evaluation logic and license verification lives server-side. The extension is purely a transparent client.

---

## 💰 Pricing Tiers & Billing

| Tier | Price | Duration | Cost / Week | Features |
| :--- | :--- | :--- | :--- | :--- |
| **Weekly** | **$15** | 7 Days | $15.00 | Full 24/7 cloud botnet decline & player auto-accept |
| **Monthly** | **$45** | 30 Days | ~$10.50 | Save $15, priority threat database sync, 24/7 daemon |
| **Yearly** | **$115** | 365 Days | ~$2.20 | Best value (~$2.20/week), uninterrupted cloud monitoring |

---

## 💳 Checkout & Payment System

- **Discord Sign-in**: Accounts are authenticated through Discord for licensing, renewals, and role sync.
- **Crypto Payments**: Supports USDT (TRC20), USDC, SOL, BTC, ETH, LTC, and DOGE with simulated test confirmation and live webhook integration (`/api/v1/payments/crypto-webhook`).
- **In-Game Item Trade Escrow**: Generates Middleman Escrow Tickets (`TRADE-XXXX`) for players paying with Roblox Limiteds or popular in-game items (MM2, Adopt Me, Blox Fruits).
- **Discord Webhook Alerts**: Automatically dispatches embeds to your Discord staff channels for new sales and pending middleman trade tickets.

---

## 🚀 How to Run & Test

### 1. Run Automated Test Suite
```bash
npm test
```
Verifies all 7 subsystems: Discord auth, 3 pricing tiers, HWID binding, automatic expiration enforcement, bot detection accuracy, in-game item trades, and 24/7 cloud account sorting.

### 2. Start the Waurks Cloud Server
```bash
npm start
```
Starts on `http://localhost:3000`.

### 3. Web Pages
- **Landing Page**: [http://localhost:3000/](http://localhost:3000/)
- **Checkout**: [http://localhost:3000/checkout](http://localhost:3000/checkout)
- **Client Portal**: [http://localhost:3000/dashboard](http://localhost:3000/dashboard)
