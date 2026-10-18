# rts-backend

Backend scaffold for the mobile RTS game. Provides simple API endpoints and placeholder implementations for:

- Play Games / Google Sign-in (placeholder)
- Promo code redemption (code: `4110`) — ties to Google account
- 7-day free trial (no card required) — server-side temporary entitlement
- Member profile and entitlements
- Shop active rotation endpoint (server rotates every 2 weeks)
- Chat relay endpoints (world chat & match chat) with basic moderation hooks
- Matchmaking metadata endpoints, quick search, and invite endpoints

This is a starter scaffold. Replace the in-memory stores with a real database (Postgres / Firestore / PlayFab) before production.

## Quick start (development)
1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill values
3. Start server: `npm run dev` (uses nodemon) or `node index.js`

## Notes
- This scaffold intentionally uses an in-memory store for clarity. Use a persistent DB and proper authentication in production.
- The `redeem` endpoint accepts the permanent code `4110` and marks the account as fully unlocked.
- The `trial` endpoint grants a 7-day trial (no card required) by setting `trial_expires_at` on the user record.
- Shop rotation is implemented as a scheduled job in `cron/shop-rotation.js` and will randomly pick items from the catalog every 2 weeks (cron job suitable for cloud functions or a scheduler).

## License
MIT
