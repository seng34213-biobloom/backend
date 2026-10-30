# ADR-005: One identity table per actor type

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#04, DDP-#05, SDS §3.2, §7.2

## Context

SDS §7.2 keeps administrators and customers in separate tables so that a customer can never raise their own privileges. The marketplace (ADR-002) and the delivery app add sellers and riders, each with different profile data and lifecycles. The code uses five roles where the SDS names three: `CUSTOMER`, `ADMIN`, `FULFILMENT_STAFF`, `SELLER` and `DELIVERY`.

## Decision

- Four identity tables: `Customer`, `AdminUser` (roles `ADMIN` and `FULFILMENT_STAFF`), `Seller` and `DeliveryUser`.
- One login endpoint (`POST /api/auth/login`) looks the email up across the tables and issues a JWT carrying `sub`, `role`, `actorType` and `jti`. `actorType` tells the JWT strategy which table to load the user from.
- Only customers register themselves. Sellers come from the application workflow; staff and riders are created by an administrator.
- Audit rows store the real actor as `actorType` plus `actorId`, without a foreign key, so any of the tables can be referenced. Scheduled jobs record `SYSTEM`.

## Consequences

- A customer row has no role column, so a profile update can never escalate privileges.
- An email must be unique across all four tables; registration and seller applications check this.
- Guards and ownership checks consider `actorType`, not only the role.
