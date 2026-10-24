# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Shipped-order rider assignments, audited delivery status updates, proof URLs, GPS capture and FCM token registration; failed assignments are terminal and are not automatically reassigned (#32)
- Staging deploy: every push to `develop` that passes CI is deployed to Render, and the job waits until `/api/health` reports that commit (#49)
- `GET /api/health` reports the deployed `commit` (#49)
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

- Restored a single notifications module after the payment webhooks merge left duplicate mailer, listener and template code that stopped `develop` from building (#43)

### Changed

- Every value placed in an email is now HTML-escaped, and `nodemailer` is upgraded to 10 (#43)
