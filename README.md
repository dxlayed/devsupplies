# Waurks — Uncrackable Roblox Anti-Botter

Waurks is a commercial, server-authoritative Roblox friend request filter that automatically detects and declines spam botnets while approving genuine human players — without requiring user account credentials or cookies.

---

## 🔒 Why Waurks Cannot Be Cracked

Conventional client-side anti-bot tools or Tampermonkey scripts can be cracked in minutes by anyone who opens DevTools and changes `if (isValidKey)` to `if (true)` or strips the key verification routine.

**Waurks uses a Zero-Trust Server-Authoritative Architecture:**
1. **Zero Heuristics on the Client**: The client script contains **no** detection logic or decision algorithms. It merely retrieves profile metadata from the user's active Roblox session and sends candidates to the Waurks Cloud Threat Engine (`POST /api/v1/scan/evaluate`).
2. **Server-Enforced Licensing**: The backend validates key authenticity, expiration timestamps, and HWID device binding before processing any request. If an unauthorized or stripped client sends requests without a valid active key, the server responds with `401 Unauthorized` and no sorting verdicts or action tokens are generated.
3. **Cryptographically Signed Action Tokens**: Every decline/accept decision returned by the server is signed with an HMAC-SHA256 signature and timestamped nonce.
4. **Hardware/Browser Fingerprint Binding (HWID)**: Keys are bound to the purchaser's machine/browser session upon first activation to prevent key sharing across multiple accounts. Users can reset their binding via the Client Dashboard if switching computers.

---

## 💰 Pricing Tiers & Billing

| Tier | Price | Access Period | Cost / Week | Features |
| :--- | :--- | :--- | :--- | :--- |
| **Weekly** | **$15** | 7 Days | $15.00 | Full botnet filtering, auto-accept players |
| **Monthly** | **$45** | 30 Days | ~$10.50 | Save $15, priority threat database sync |
| **Yearly** | **$115** | 365 Days | ~$2.20 | Best value, full year of continuous protection |

---

## 💳 Payment & Key Issuance System

- **Discord Sign-in**: Keys are bound to Discord accounts for subscription tracking, renewal notifications, and VIP role assignment.
- **Crypto Payments**: Supports USDT (TRC20), USDC, SOL, BTC, ETH, LTC, and DOGE. Generates dynamic order IDs and deposit addresses with instant simulated verification for testing or webhooks for production gateways.
- **In-Game Item Trade Escrow**: Generates unique Middleman Escrow Tickets (`TRADE-XXXX`) for players paying with Roblox Limiteds or popular in-game items (MM2, Adopt Me, Blox Fruits).
- **Auto-Expiration & Renewal**: Expired keys are halted automatically on the server.

---

## 🚀 Quick Start & Testing

### 1. Start the Server
```bash
npm start
```
The server will start on `http://localhost:3000`.

### 2. Run the Automated Validation Suite
```bash
npm test
```
Tests all 6 core subsystems: Discord user auth, order creation, tier pricing, HWID binding, automatic expiration enforcement, and heuristic bot scoring accuracy.

### 3. Open the Web Applications
- **Landing Page**: [http://localhost:3000/index.html](http://localhost:3000/index.html)
- **Checkout & Key Generator**: [http://localhost:3000/checkout.html](http://localhost:3000/checkout.html)
- **Client Portal & Live Simulator**: [http://localhost:3000/dashboard.html](http://localhost:3000/dashboard.html)
- **Direct Userscript URL**: [http://localhost:3000/waurks.user.js](http://localhost:3000/waurks.user.js)

