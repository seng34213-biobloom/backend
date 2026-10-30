# ADR-009: Hosted payments with signed webhooks driving order state

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#17, DDP-#21, DDP-#22, DDP-#26, SDS §2.3, §4.2, §7.3

## Context

Bio Bloom must never store or log card data (SDS §7.3). Stripe serves international cards and PayHere serves LKR payments (SDS §2.3). A customer's browser can close before returning from the payment page, so a redirect alone cannot confirm a payment.

## Decision

- Checkout creates the order as `PENDING_PAYMENT`, takes the stock (ADR-007) and creates a `PENDING` payment row, then returns what the client needs to pay in `payment.checkout`: a redirect to a Stripe Checkout Session, or the signed PayHere hosted checkout form. A gateway that cannot take the payment is refused before the order is created.
- Only verified webhooks change payment and order state:
  - `POST /api/webhooks/stripe` checks the `Stripe-Signature` header over the raw body.
  - `POST /api/webhooks/payhere` checks the `md5sig` field.
- Stripe events are matched on the stored session id. `payment_intent.succeeded` events are also accepted and matched on the signed `orderId` metadata; `payment_intent.payment_failed` is not, because a declined card can be retried on the hosted page. Only `checkout.session.expired` or `checkout.session.async_payment_failed` ends the attempt.
- Webhooks are idempotent: a repeated event returns `duplicate` and changes nothing. The amount and currency must match the payment row.
- Success marks the payment and order `PAID` and emits `order.confirmed`. Failure marks the payment `FAILED`, cancels the order and returns its units.
- A success that arrives after the order was cancelled (ADR-010) is refunded, never applied.
- Subscribe & Save stores only the gateway's reusable token, encrypted (ADR-004), and charges it off-session through `PaymentsService.chargeStoredToken`.

## Consequences

- Card data stays with the gateways.
- The client's return page reads the order status from the API instead of assuming success.
- Webhook routes need the raw request body and are exempt from CSRF.
- Orders whose webhook never arrives are cleaned up by the stale-order job (ADR-010).
