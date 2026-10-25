# ADR-008: All scheduling and date arithmetic in UTC

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#22, DDP-#23, DDP-#24, SDS §5.4, §5.6

## Context

The daily jobs compare dates: "next billing date is today or earlier", "expires within seven days". If the cron timer, the database and `Date` arithmetic used different time zones, a subscription could be billed twice or a batch flagged a day late. Developers' machines, CI runners and the staging server all run in different local zones.

## Decision

- `src/main.ts` sets `process.env.TZ = 'UTC'` before Nest starts, and the Jest runner does the same, so every `Date`, cron expression and timestamp in the API is in UTC.
- Calendar dates (`nextBillingDate`, `expiryDate`) are stored at UTC midnight and compared with UTC "today".
- Billing and the expiry sweep run at `0 6 * * *` (`CronExpression.EVERY_DAY_AT_6AM`): 06:00 UTC, 11:30 in Sri Lanka.
- Keys that depend on the day use the UTC date: the billing cycle key `<subscription id>:<yyyy-mm-dd>` and the job locks `cron:<job>:<yyyy-mm-dd>` (ADR-013).
- A subscription's next date moves on from its previous date, not from the day the job ran, so a late run keeps the schedule.

## Consequences

- The jobs behave the same on every machine and in CI.
- The clients convert dates to Asia/Colombo only for display.
- The SDS's "06:00 daily" is read as 06:00 UTC; moving it to local time would need a new record.
