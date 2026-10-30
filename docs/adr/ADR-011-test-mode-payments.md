# ADR-011: Payment gateways are faked in test mode

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#21, DDP-#22, DDP-#34, DDP-#38, ADR-009

## Context

Real payment calls need gateway accounts, sandbox keys and a public URL for webhooks. The integration suite in CI and the k6 load tests have none of these, yet they must place orders, renew subscriptions and exercise declines through the real checkout and billing code.

## Decision

- When `NODE_ENV=test`, `PaymentsService` calls no gateway:
  - `createIntent` returns a `pi_test_…` or `payhere_test_…` intent.
  - `chargeStoredToken` approves every stored token, except one containing `fail` or `decline`, which is declined with `card_declined`.
- Everything after the payment result is the same code as with a real gateway: the payment and order rows, stock, events and emails.
- The Jest runner sets `NODE_ENV=test`; the load tests run the API with `NODE_ENV=test` (see `load-test/README.md`).
- Outside test mode the configured Stripe and PayHere keys are used, test keys on staging (ADR-012).

## Consequences

- CI and load tests need no gateway accounts and never move money.
- The gateway calls themselves are covered by unit tests with mocked clients, not end to end; testing them for real needs sandbox keys and a public webhook URL.
