# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `POST /api/payments/setup` and `POST /api/payments/setup/complete` save a card on the Stripe or PayHere hosted page for Subscribe & Save, with no charge; subscriptions now return `discountedUnitPrice` and the variant price (#76)
- Checkout returns `payment.checkout`: a redirect to a hosted Stripe Checkout page, or the signed PayHere form. Stripe `checkout.session.*` events settle the order, and a gateway that cannot take the payment is refused before the cart and stock are touched (#74)
- Customer order list and detail include `orderNumber`, `itemCount`, `subtotal`, product names, refund requests and delivery status; raw gateway payloads are no longer returned (#74)
- Contributing guide, pull request template with the Definition of Done, CODEOWNERS, and the architecture decision records ADR-001 to ADR-013 in `docs/adr/` (#70)
- Unpaid checkouts are cancelled after `PENDING_ORDER_TIMEOUT_MINUTES` (30 by default): the payment fails, the units go back to unexpired batches and a SYSTEM audit entry is written; a payment that succeeds after its order was cancelled is refunded (#64)
- k6 load tests in `load-test/`: checkout at 50 concurrent shoppers (p95 under 600 ms, under 1% failures) and one billing run over 200 due subscriptions (under 60 s), with a fixture and an admin-only billing trigger that production builds do not expose; the rate limits are configurable through `THROTTLE_*` for test environments (#68)
- Daily Subscribe & Save billing at 06:00 UTC: each due active subscription is charged the discounted price plus shipping on its stored token, and a paid renewal becomes a `PAID` order with FIFO stock; short stock or a declined charge creates no order and takes no stock, and the billing date always moves one interval forward (#15)
- `PaymentsService.chargeStoredToken` for off-session Stripe charges and the PayHere Charging API (#15)
- CI/CD pipeline stages: unit tests with the coverage gate and an uploaded report, a dependency audit that fails on high or critical advisories, and a multi-stage Docker image that every push to `develop` publishes to GitHub Container Registry tagged with the commit SHA; staging deploys only after all of them pass, and a newer push cancels the older run (#62)
- Production environment validation for signing, payment, token-encryption, and upload configuration; user-based API throttling, CSP headers, verified private proof-image uploads, and customer ownership coverage (#37)
- Weight-bracket shipping quotes sum cart-item weights, apply inclusive rate boundaries, and cache rate brackets in Redis for five minutes (#16)
- Shipped-order rider assignments, audited delivery status updates, proof URLs, GPS capture and FCM token registration; failed assignments are terminal and are not automatically reassigned (#32)
- Verified-purchase product reviews with admin moderation and public approved-review summaries (#31)
- Customer support tickets with customer reopen and admin resolution/closure workflows (#31)
- Staging deploy: every push to `develop` that passes CI is deployed to Render, and the job waits until `/api/health` reports that commit (#49)
- `GET /api/health` reports the deployed `commit` (#49)
- API unit tests run in UTC and enforce an 80% global line, statement, and function coverage gate, excluding module classes, controllers (covered by the integration suite), DTOs, and `main.ts` (#33)
- E2E tests use unique per-run fixtures, verify shipping bracket boundaries and reject tampered Stripe webhooks; CI runs the integration suite twice against the same PostgreSQL, Redis and MailHog services (#34)
- Admin analytics API: `GET /api/admin/analytics/dashboard` (today's revenue, pending orders, active subscriptions, batches expiring soon), `/revenue-series` (zero-filled daily revenue, 30 days by default) and `/top-selling`; only paid orders count as revenue (#45)
- Transactional email for order confirmed, shipped and delivered, subscription renewed, cancelled, stock delayed and charge failed, refund issued and seller approved, sent from domain events through `NotificationsService` (#43)
- Cancelling a subscription now sends the cancellation confirmation email (#43)
- Audited order status transitions, staff fulfilment queues, shipment and delivery emails, and refunds with expiry-safe batch restocking (#26)
- Customer shipping addresses, weight-based shipping quotes, payment intents, and atomic FIFO checkout with price, weight, and shipping snapshots (#17)
- Stripe and PayHere hosted payment intents, signature-verified idempotent webhooks, failure restocking, and order-confirmation email notifications (#21)
- Daily batch expiry sweep at 06:00 UTC: batches within 7 days of expiry become `EXPIRING_SOON` and every active admin is emailed; expired batches become `EXPIRED` (#39)
- Event-driven email foundation: `EventEmitterModule`, `MailerService` over SMTP and `NotificationsService`, with MailHog in docker-compose and CI (#39)
- Global JWT and role guards, Redis-backed logout token revocation, double-submit CSRF protection and auth rate limits of 20 requests per IP per 15 minutes (#5)
- Admin and seller product/variant management endpoints with ownership checks, audit entries, uniqueness validation and soft deactivation (#12)
- Batch management API for admins and sellers: `POST /api/admin/products/:productId/variants/:variantId/batches` and `GET /api/admin/products/:productId/batches` in FIFO order, with a `batch.create` audit entry (#9)
- `audit_log` table and `AuditService`, and optional seller ownership on `product` (#9)
- Subscribe & Save lifecycle API: create, list, pause, resume, skip next and cancel under `/api/subscriptions`, with the 10% discount locked in and the payment token encrypted with pgcrypto (#14)
- `address` and `subscription` tables with the pgcrypto extension (#14)
- Public product catalogue API: `GET /api/products` with category, search and paging, and `GET /api/products/:slug` with live stock per variant; products without sellable stock are hidden (#19)
- Validation errors now return 422 Unprocessable Entity (#19)
- FIFO inventory allocation: `InventoryService` with available stock, stock checks and earliest-expiry-first decrements under row-level locks (#10)
- Prisma schema for products, variants and batches with the first migration (#2)
- NestJS project setup with Prisma, health check and CI pipeline (#1)

### Fixed

- Billing and the expiry sweep run on one API instance only, under a daily Redis lock; each billing cycle is claimed once with a unique key, and a renewal whose stock transaction fails after the charge is refunded (#64)
- Restocking a cancelled or refunded order increments the batch in SQL, so a concurrent checkout's decrement is no longer overwritten (#64)
- Staging starts again: with `APP_ENV=staging` the production secret checks allow Stripe test keys and no uploads bucket, which had stopped every deploy since the OWASP hardening merge (#66)
- The auth rate limit of 20 requests per 15 minutes now applies only to register and login. It had applied to every route, so `/api/health` failed Render's health checks and staging kept restarting (#55)
- `GET /api/products` and `GET /api/products/:slug` now return the `seller` (`id`, `businessName`), or `null` for admin-managed products; the storefront product pages failed without it (#55)
- Restored a single notifications module after the payment webhooks merge left duplicate mailer, listener and template code that stopped `develop` from building (#43)

### Changed

- Every value placed in an email is now HTML-escaped, and `nodemailer` is upgraded to 10 (#43)
