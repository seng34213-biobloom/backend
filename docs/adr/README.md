# Architecture Decision Records

This folder records the architecture decisions behind the Bio Bloom API. Each record explains one decision: the situation that forced it, what was chosen, and what follows from it. Records are short and numbered, and an accepted record is never rewritten; a later decision supersedes it instead.

## Register

| ADR                                                | Title                                                    | Status   | Related issues    |
| -------------------------------------------------- | -------------------------------------------------------- | -------- | ----------------- |
| [ADR-001](ADR-001-separate-repositories.md)        | One repository per application                           | Accepted | DDP-#01, #09      |
| [ADR-002](ADR-002-multi-seller-marketplace.md)     | Multi-seller marketplace instead of a single vendor      | Accepted | DDP-#10, #12      |
| [ADR-003](ADR-003-event-driven-email.md)           | Event-driven email notifications                         | Accepted | DDP-#24, #25      |
| [ADR-004](ADR-004-postgres-prisma-pgcrypto.md)     | PostgreSQL 15 with Prisma and pgcrypto                   | Accepted | DDP-#03, #18      |
| [ADR-005](ADR-005-separate-actor-tables.md)        | One identity table per actor type                        | Accepted | DDP-#04, #05      |
| [ADR-006](ADR-006-jwt-cookie-and-csrf.md)          | JWT cookie, Redis JTI blocklist and double-submit CSRF   | Accepted | DDP-#04, #05, #37 |
| [ADR-007](ADR-007-fifo-row-locking.md)             | FIFO allocation with `SELECT … FOR UPDATE`               | Accepted | DDP-#14, #17      |
| [ADR-008](ADR-008-utc-scheduling.md)               | All scheduling and date arithmetic in UTC                | Accepted | DDP-#22, #23, #24 |
| [ADR-009](ADR-009-hosted-payments-and-webhooks.md) | Hosted payments with signed webhooks driving order state | Accepted | DDP-#21, #22      |
| [ADR-010](ADR-010-stale-unpaid-order-timeout.md)   | Cancel unpaid orders after 30 minutes                    | Accepted | DDP-#23           |
| [ADR-011](ADR-011-test-mode-payments.md)           | Payment gateways are faked in test mode                  | Accepted | DDP-#21, #38      |
| [ADR-012](ADR-012-render-staging-and-ghcr.md)      | Staging on Render, images on GitHub Container Registry   | Accepted | DDP-#39, #40      |
| [ADR-013](ADR-013-scheduled-job-locks.md)          | Scheduled jobs under Redis locks, one charge per cycle   | Accepted | DDP-#22, #23      |

The front end's own decisions, such as how it stores the chosen language, are recorded in the `frontend` repository.

## Statuses

- **Proposed:** under discussion in a pull request.
- **Accepted:** agreed and reflected in the code.
- **Superseded by ADR-NNN:** replaced by a later record and kept for history.
- **Deprecated:** no longer applies and has no replacement.

## Adding a record

1. Copy the template below into `ADR-NNN-short-slug.md`, using the next free number.
2. Open a pull request with the record in **Proposed** status.
3. Change the status to **Accepted** in the same pull request once it is approved.
4. To reverse a decision, write a new record and mark the old one **Superseded by ADR-NNN**. Do not edit the old record's decision.

```markdown
# ADR-NNN: Title

- **Status:** Proposed
- **Date:** yyyy-mm-dd
- **Related:** DDP-#NN, SDS §x.y

## Context

## Decision

## Consequences
```
