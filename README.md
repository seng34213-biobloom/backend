# backend

Bio Bloom NestJS REST API and Core Domain Services

## Tech stack

- NestJS 10 (TypeScript)
- Prisma ORM with PostgreSQL 15
- Jest and Supertest for tests
- GitHub Actions for CI

## Getting started

Requirements: Node.js 20 (see `.nvmrc`), npm and Docker.

```bash
# 1. Install dependencies (also generates the Prisma client)
npm install

# 2. Create your local env file
cp .env.example .env

# 3. Start PostgreSQL, Redis and MailHog
docker compose up -d

# 4. Apply database migrations
npm run prisma:deploy

# 5. Run the API in watch mode
npm run start:dev
```

The API runs on http://localhost:4000/api. Check it with:

```bash
curl http://localhost:4000/api/health
```

Emails sent in development are caught by MailHog at http://localhost:8025.

## Scripts

| Command                  | Description                                       |
| ------------------------ | ------------------------------------------------- |
| `npm run start:dev`      | Start the API in watch mode                       |
| `npm run build`          | Compile to `dist/`                                |
| `npm run start:prod`     | Run the compiled build                            |
| `npm run lint`           | Run ESLint                                        |
| `npm run format:check`   | Check formatting with Prettier                    |
| `npm test`               | Run unit tests                                    |
| `npm run test:e2e`       | Run integration tests (needs a running database)  |
| `npm run prisma:migrate` | Create and apply a migration from `schema.prisma` |
| `npm run prisma:deploy`  | Apply existing migrations                         |
| `npm run prisma:studio`  | Open Prisma Studio                                |

## Project structure

```
src/
  analytics/        Admin dashboard KPIs, revenue series and top sellers
  app.module.ts     Root module
  app.setup.ts      Global prefix, CORS and validation, shared with e2e tests
  audit/            Append-only audit log for privileged changes
  main.ts           Entry point
  batches/          Admin and seller batch management
  health/           GET /api/health liveness check
  inventory/        FIFO stock checks and batch allocation
  notifications/    Domain events and transactional email (MailHog in dev)
  products/         Public product catalogue API
  subscriptions/    Subscribe & Save lifecycle and payment token encryption
  prisma/           PrismaService, available globally
prisma/
  schema.prisma     Database schema
  migrations/       SQL migrations, applied in order
test/               Integration tests
```

## Data model

| Table             | Purpose                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `product`         | Catalogue entry: name, description, base price, unit weight, optional owning seller          |
| `product_variant` | Sellable size of a product with its own SKU, price and weight                                |
| `product_batch`   | Stock received for a variant, with manufactured and expiry dates                             |
| `address`         | Shipping address owned by a customer                                                         |
| `subscription`    | Subscribe & Save plan: variant, address, frequency, locked discount, encrypted payment token |
| `audit_log`       | Who changed what: actor, action, target and metadata                                         |

Batches are consumed FIFO by expiry date, so `product_batch` is indexed on `expiry_date` and on `(product_variant_id, expiry_date)`. The database rejects negative quantities, a current quantity above the initial quantity, and an expiry date before the manufactured date.

Subscriptions run every 14, 30 or 60 days for 1 to 10 units. Their status moves `ACTIVE` ↔ `PAUSED`, and either can move to `CANCELLED`, which is final. The payment token is encrypted with pgcrypto using `SUBSCRIPTION_TOKEN_ENC_KEY` and is never returned by the API.

## Inventory allocation

`InventoryService` is the only code that changes batch quantities.

- `availableStock(variantId)` and `checkStock(variantId, qty)` count only valid batches: not expired, not `DEPLETED`, quantity above zero.
- `decrementForVariant(variantId, qty, tx)` must run inside a Prisma `$transaction`. It locks the valid batches with `SELECT ... FOR UPDATE`, takes stock earliest-expiry-first, marks emptied batches `DEPLETED` and throws `OutOfStockError` (HTTP 409) when stock is short, which rolls the transaction back.

## Batch expiry sweep

`ExpiryCronService` runs every day at 06:00 UTC (SDS §5.6):

- `ACTIVE` batches that expire within the next 7 days, including today, become `EXPIRING_SOON` and emit `batch.expiringSoon`. Every active admin receives the expiring-soon email.
- Batches whose expiry date has passed become `EXPIRED` and emit `batch.expired`.
- `DEPLETED` batches are left alone, and running the sweep again on the same day changes nothing.

Stock queries filter on the expiry date itself, so an expired batch is never sold even before the sweep runs. A failed email is logged and never stops the sweep.

## Email notifications

Feature modules emit domain events through `NotificationsService` (`emitOrderConfirmed`, `emitSubscriptionCancelled`, …) and return straight away. Listeners send the email afterwards, so a mail failure never blocks or fails the request. In development every email lands in MailHog at http://localhost:8025.

| Event                                                  | Email                           | Sent to            |
| ------------------------------------------------------ | ------------------------------- | ------------------ |
| `order.confirmed`                                      | Order confirmed, with the total | Customer           |
| `order.shipped`, `order.delivered`                     | Order shipped, order delivered  | Customer           |
| `subscription.renewed`, `subscription.cancelled`       | Renewal, cancellation           | Customer           |
| `subscription.stockDelayed`                            | Delivery delayed, not charged   | Customer           |
| `subscription.chargeFailed`                            | Payment declined                | Customer           |
| `refund.approved`                                      | Refund issued                   | Customer           |
| `seller.approved`                                      | Welcome, with the portal link   | Seller             |
| `batch.expiringSoon`                                   | Batch expiring soon             | Every active admin |
| `seller.applied`, `seller.rejected`, `refund.rejected` | Logged only                     | —                  |

Links in emails use `STOREFRONT_URL` and `SELLER_PORTAL_URL`. Every value placed in an email is HTML-escaped.

## API

All routes are under `/api`. Invalid input returns `422 Unprocessable Entity`.

| Method | Route                                                          | Description                                                                                                                             |
| ------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                                                      | Liveness check. `commit` is the deployed commit on Render, `null` elsewhere                                                             |
| GET    | `/products`                                                    | Catalogue. Query: `category`, `search`, `page` (default 1), `pageSize` (default 24, max 60). Only products with sellable stock          |
| GET    | `/products/:slug`                                              | Product detail with `stockByVariant` and `earliestExpiryByVariant`                                                                      |
| GET    | `/subscriptions`                                               | Signed-in customer's subscriptions                                                                                                      |
| POST   | `/subscriptions`                                               | Subscribe: `productVariantId`, `shippingAddressId`, `frequencyDays` (14, 30 or 60), `quantity` (1-10), `paymentToken`, `paymentGateway` |
| PATCH  | `/subscriptions/:id/pause`, `/resume`, `/skip-next`, `/cancel` | Change a subscription the customer owns                                                                                                 |
| GET    | `/admin/products/:productId/batches`                           | Batches of a product, earliest expiry first. Admin or owning seller                                                                     |
| POST   | `/admin/products/:productId/variants/:variantId/batches`       | Add a batch. Admin or owning seller                                                                                                     |
| GET    | `/admin/analytics/dashboard`                                   | Today's revenue, pending orders, active subscriptions, batches expiring within 7 days. Admin only                                       |
| GET    | `/admin/analytics/revenue-series`                              | Daily revenue for the last `days` days (default 30, max 365), one point per day. Admin only                                             |
| GET    | `/admin/analytics/top-selling`                                 | Best-selling products this month by revenue, `limit` 1–50 (default 5). Admin only                                                       |

Admins and sellers add stock with `POST /admin/products/:productId/variants/:variantId/batches` (`batchNumber`, `manufacturedDate`, `expiryDate`, `initialQuantity`). The manufactured date cannot be in the future and the expiry date must be tomorrow or later. Sellers can only manage batches of their own products; products without a seller are managed by admins. Every new batch writes a `batch.create` row to `audit_log`.

## Deployment

Staging runs on Render in Singapore: the `biobloom-api` web service, Render Postgres 15 and Render Key Value.

- API: https://biobloom-api.onrender.com/api
- Every push to `develop` runs CI. When it passes, the `Deploy to Render staging` job deploys that commit through the `RENDER_DEPLOY_HOOK_URL` secret of the `staging` environment, then waits until `/api/health` reports that commit. The job fails if it does not within 15 minutes.
- Auto-deploy is off on the Render service, so a commit that fails CI is never deployed.
- Migrations run with `prisma migrate deploy` when the service starts. Render only switches traffic to the new version once `/api/health` responds, so a failed deploy leaves the previous one live.
- Environment variables are set on the Render service, not in the repo. The names match `.env.example`.
- Staging uses free instances, which sleep after 15 minutes without traffic. The first request after that takes up to a minute, and the 06:00 UTC expiry sweep only runs while the instance is awake.

## Branching

Work happens on short-lived branches cut from `develop`, and changes reach `develop` through a pull request with one approval. `main` is updated from `develop` for releases.
