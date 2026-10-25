# ADR-013: Scheduled jobs under Redis locks, one charge per billing cycle

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#22, DDP-#23, DDP-#24, SDS §5.4, §8.1

## Context

SDS §8.1 runs one to three API instances, and every instance has its own `@Cron` timers. Without coordination each instance would bill the same subscriptions and send the same expiry emails. A billing run can also crash part-way, or two runs can overlap, and a customer must never be charged twice for one cycle.

## Decision

- `CronLockService.runExclusive` runs a job only on the instance that takes its Redis lock (`SET cron:<name> <instance> NX EX <ttl>`); the others log that they skipped. Billing and the expiry sweep lock per UTC day; the stale-order job locks per 10-minute slot. Locks expire rather than being released.
- Before charging, billing claims the cycle with a payment row whose `billing_cycle_key` (`<subscription id>:<billing date>`) is unique, and sends the same key to the gateway as the idempotency key. A second claim fails and the subscription is skipped.
- Billing also skips a subscription whose date has moved on, or that was paused, since it was selected.
- If the stock transaction fails after a successful charge, the charge is refunded and the payment row records both.

## Consequences

- A crash after the claim but before the charge leaves that cycle unbilled rather than risking a double charge; the date still moves on.
- A failed refund leaves the payment `PAID`, with the reason in `rawPayload`, for a manual refund.
- Redis is required for the scheduled jobs as well as for authentication (ADR-006).
