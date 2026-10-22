# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
