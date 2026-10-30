# ADR-004: PostgreSQL 15 with Prisma and pgcrypto

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#03, DDP-#18, DDP-#37, SDS §2.3, §3, §7.3

## Context

The SDS fixes PostgreSQL 15 and Prisma for the data tier and requires subscription payment tokens to be encrypted at rest with pgcrypto. Inventory, checkout and payments need ACID transactions and row-level locks, and some integrity rules must hold even under concurrent writes.

## Decision

- PostgreSQL 15 with Prisma. Since #58 the API runs Prisma 7 through the `@prisma/adapter-pg` driver adapter, with the connection configured in `prisma.config.ts`.
- Conventions: UUID primary keys, `snake_case` columns through `@map`, money as `Decimal(12,2)`, rates as `Decimal(5,4)`, calendar dates as `@db.Date`.
- The pgcrypto extension is created by a migration (`CREATE EXTENSION IF NOT EXISTS pgcrypto`), so local, CI and staging databases all get it.
- Payment tokens are encrypted in `TokenCipherService` with `pgp_sym_encrypt` and `pgp_sym_decrypt` using `SUBSCRIPTION_TOKEN_ENC_KEY`. The column is `Bytes`, and no endpoint ever returns the token.
- Rules that must hold under concurrency are CHECK constraints: batch quantities never negative and never above the initial quantity, expiry after manufacture, positive prices and weights, subscription frequency, quantity and discount ranges, review ratings 1 to 5.

## Consequences

- Raw SQL is limited to the pgcrypto calls and the FIFO lock query (ADR-007), and always uses parameters; `$queryRawUnsafe` is blocked by lint.
- Money stays exact: services compute with `Prisma.Decimal` and return amounts as two-decimal strings.
- A schema change always comes with a committed migration, and CI checks that the migrations apply on an empty database.
