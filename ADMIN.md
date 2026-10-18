// Admin README additions

## Admin endpoints (development)

The backend includes simple moderation endpoints for development. They rely on ADMIN_KEY environment variable to authorize requests.

- POST /api/moderation/ban { adminKey, userId } - ban a user (blocks chat and interactions)
- POST /api/moderation/mute { adminKey, userId, minutes } - mute a user for N minutes

Set ADMIN_KEY in your .env before running these endpoints in dev.
