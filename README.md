# Waurks — 100% Cloud-Powered Roblox Anti-Botter

Waurks is a commercial, server-authoritative Roblox anti-bot platform that runs **24/7 directly on the cloud**. 

Users log into the website, connect their Roblox account, and the Waurks cloud servers automatically monitor, decline spam botnets, and approve real players around the clock.

**Zero browser extensions, zero desktop software, zero keeping user PCs running.**

---

## 🔒 Why This Model is 100% Uncrackable

With traditional desktop tools or browser extensions, attackers decompile the JavaScript or binary and remove the `if (keyValid)` check.

**Waurks is physically uncrackable because 100% of the botting code lives exclusively on your private backend server:**
1. **No Client Code**: There is no browser extension or executable distributed to users. The user connects their account to the site, and the backend cloud worker executes all friend sorting tasks.
2. **Key-Gated Cloud Daemon**: Every cloud scan requires a valid, unexpired cryptographic license key (`WAURKS-XXXX-...`) in the database. If a key expires or is deleted, the server immediately halts background scanning for that account.
3. **Encrypted Vault Storage**: User Roblox session tokens are encrypted at rest using AES-256-CBC with dynamic initialization vectors (IV).

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
- **Landing Page**: [http://localhost:3000/index.html](http://localhost:3000/index.html)
- **Checkout**: [http://localhost:3000/checkout.html](http://localhost:3000/checkout.html)
- **Client Portal**: [http://localhost:3000/dashboard.html](http://localhost:3000/dashboard.html)
