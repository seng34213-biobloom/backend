# ADR-006: JWT cookie, Redis JTI blocklist and double-submit CSRF

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#04, DDP-#05, DDP-#37, SDS §7.1, §7.4

## Context

The web apps and the Flutter app share one API. Browsers should not expose the token to JavaScript. JWTs are stateless, but logout must take effect immediately (SDS §7.1). Cookie authentication in turn exposes state-changing requests to cross-site request forgery, and the auth endpoints need protection against brute force.

## Decision

- Tokens are JWTs signed with `JWT_SECRET`. Customers get a 15-day token; staff, sellers and riders an 8-hour token (`JWT_CUSTOMER_TTL`, `JWT_STAFF_TTL`).
- Browsers receive the token in the `auth_token` cookie: `HttpOnly`, `SameSite=Strict`, and `Secure` in production. Other clients may send `Authorization: Bearer <token>`.
- Logout writes the token's JTI to Redis as `jti:<id>`, with a TTL equal to the token's remaining lifetime; the JWT strategy rejects revoked tokens.
- CSRF uses the double-submit cookie pattern: `GET /api/auth/csrf` issues a readable `csrf-token` cookie, and every non-GET request must echo it in the `X-CSRF-Token` header. `/api/webhooks/*` is exempt because those calls are verified by signature.
- Rate limits (SDS §7.4): 20 requests per IP per 15 minutes on register, login and seller apply, and 100 requests per minute per user (per IP when anonymous) elsewhere. `THROTTLE_*` raises them for load tests only.
- In production builds the API refuses to start with weak or placeholder secrets (ADR-012 covers staging).

## Consequences

- XSS cannot read the session token.
- Redis is a hard dependency for authenticated requests.
- The web apps prime the CSRF cookie before their first change and send credentials with every request; CORS lists exact origins (`CORS_ORIGINS`) with credentials enabled.
