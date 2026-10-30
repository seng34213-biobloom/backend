# ADR-007: FIFO allocation with `SELECT … FOR UPDATE`

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#13, DDP-#14, DDP-#17, DDP-#22, SDS §3.2, §4.2

## Context

Food safety requires that the oldest stock is sold first: the inventory service always takes from the batch with the earliest expiry date (SDS §4.2). Two customers checking out the last units at the same moment must not both succeed, and no batch quantity may ever go negative. A check in application code followed by an update would race.

## Decision

- `InventoryService` is the only code that changes batch quantities.
- `decrementForVariant(variantId, qty, tx)` runs inside the caller's transaction. It locks the variant's sellable batches (not expired, not `DEPLETED`, quantity above zero) in `expiry_date` order with `SELECT … FOR UPDATE`, then takes from them in order until the request is met.
- It returns one result per batch drawn, and checkout and billing write one order item per batch, so every unit sold can be traced to its batch. A batch that reaches zero becomes `DEPLETED`.
- If the locked batches cannot cover the request it throws `OutOfStockError` (HTTP 409), and the whole transaction rolls back.
- Restocks (cancellations, failed payments, refunds) return units only to batches that have not expired, and increment them in SQL so a concurrent checkout is never overwritten.
- A CHECK constraint keeps batch quantities at zero or above as a last line of defence.

## Consequences

- Concurrent checkouts of the same variant queue on the batch rows; the second buyer of the last unit gets 409, never an oversell.
- Lock time is bounded by the transaction, so no payment gateway is called while the locks are held.
