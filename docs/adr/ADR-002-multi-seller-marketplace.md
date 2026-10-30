# ADR-002: Multi-seller marketplace instead of a single vendor

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#10, DDP-#12, SDS §1.2

## Context

The SDS describes Bio Bloom as a single artisanal food business selling its own products, while the requirements also ask for sellers who apply to join, manage their own catalogue and are approved by an administrator. The team had to choose one model before designing the schema.

## Decision

- A `Seller` identity with a `PENDING → APPROVED | REJECTED` application workflow, plus `SUSPENDED` for sellers an administrator takes offline.
- A product has an optional owning seller. Sellers manage only their own products, variants and batches; administrators manage all of them, and products without a seller are managed by administrators.
- Seller decisions are recorded in the audit log, and an approved seller receives the welcome email.

The single-vendor case is still supported: it is a marketplace whose products have no seller.

## Consequences

- Every catalogue and batch endpoint checks ownership, and the integration suites cover it.
- The schema carries an entity the SDS diagram does not show (`Seller`).
- Seller payouts are out of scope for now; a later record will cover settlement if it is added.
