# ADR-010: Cancel unpaid orders after 30 minutes

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#17, DDP-#21, DDP-#23, ADR-007, ADR-009

## Context

Checkout takes stock as soon as it creates the order in `PENDING_PAYMENT` (ADR-007), before the customer pays (ADR-009). If the customer abandons the payment page, or the webhook never arrives, those units stay held by an order that will never be paid, and perishable stock can expire unsold. The SDS does not give a timeout.

## Decision

- `StaleOrderCronService` runs every 10 minutes and cancels orders still in `PENDING_PAYMENT` whose `placedAt` is older than `PENDING_ORDER_TIMEOUT_MINUTES`, **30** by default.
- For each order, in one transaction: a guarded update moves it to `CANCELLED` only if it is still unpaid, its pending payment becomes `FAILED`, and its units go back to batches that have not expired. A `SYSTEM` audit entry records the cancellation.
- A payment that lands first wins; one that lands after the cancellation is refunded (ADR-009).
- Only one API instance runs each 10-minute pass (ADR-013).

## Consequences

- Abandoned checkouts free their stock within about 40 minutes.
- Thirty minutes covers the gateways' own payment windows and slow 3-D Secure flows; a shorter value risks cancelling an order whose payment is still in progress.
- The timeout is configurable per environment.
