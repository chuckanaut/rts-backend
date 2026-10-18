# Deployment notes

Replace the in-memory stores with a persistent database before deploying to production. Recommended steps:

- Use Postgres or Firestore for users, purchases, chat logs, and lobbies.
- Implement server-side verification of Google Play tokens and Play Billing purchase tokens.
- Replace placeholder signed-url generation for avatars with AWS S3 presigned URLs or Google Cloud Storage signed URLs.
- Add proper admin authentication for moderation endpoints (OAuth or Admin console).
