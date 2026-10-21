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

# 3. Start PostgreSQL
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
  app.module.ts     Root module
  app.setup.ts      Global prefix, CORS and validation, shared with e2e tests
  audit/            Append-only audit log for privileged changes
  main.ts           Entry point
  batches/          Admin and seller batch management
  health/           GET /api/health liveness check
  inventory/        FIFO stock checks and batch allocation
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

## API

All routes are under `/api`. Invalid input returns `422 Unprocessable Entity`.

| Method | Route                                                          | Description                                                                                                                             |
| ------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                                                      | Liveness check                                                                                                                          |
| GET    | `/products`                                                    | Catalogue. Query: `category`, `search`, `page` (default 1), `pageSize` (default 24, max 60). Only products with sellable stock          |
| GET    | `/products/:slug`                                              | Product detail with `stockByVariant` and `earliestExpiryByVariant`                                                                      |
| GET    | `/subscriptions`                                               | Signed-in customer's subscriptions                                                                                                      |
| POST   | `/subscriptions`                                               | Subscribe: `productVariantId`, `shippingAddressId`, `frequencyDays` (14, 30 or 60), `quantity` (1-10), `paymentToken`, `paymentGateway` |
| PATCH  | `/subscriptions/:id/pause`, `/resume`, `/skip-next`, `/cancel` | Change a subscription the customer owns                                                                                                 |
| GET    | `/admin/products/:productId/batches`                           | Batches of a product, earliest expiry first. Admin or owning seller                                                                     |
| POST   | `/admin/products/:productId/variants/:variantId/batches`       | Add a batch. Admin or owning seller                                                                                                     |

Admins and sellers add stock with `POST /admin/products/:productId/variants/:variantId/batches` (`batchNumber`, `manufacturedDate`, `expiryDate`, `initialQuantity`). The manufactured date cannot be in the future and the expiry date must be tomorrow or later. Sellers can only manage batches of their own products; products without a seller are managed by admins. Every new batch writes a `batch.create` row to `audit_log`.

## Branching

Work happens on short-lived branches cut from `develop`, and changes reach `develop` through a pull request with one approval. `main` is updated from `develop` for releases.
