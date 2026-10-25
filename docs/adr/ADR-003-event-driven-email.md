# ADR-003: Event-driven email notifications

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#24, DDP-#25, DDP-#28, SDS §4.2, §5.4 to §5.6

## Context

The SDS sends email for order confirmation, subscription renewals, stock delays and expiry alerts. A request or a scheduled job must not fail, or slow down, because the mail server is unreachable. SMS would add a paid provider and a second channel to test.

## Decision

- Feature modules emit domain events through `EventEmitter2` with the typed helpers in `NotificationsService` and return straight away. Listeners send the email afterwards.
- Email only, through `MailerService` over SMTP: MailHog in development and CI, and SendGrid's SMTP relay (`smtp.sendgrid.net:465`) once `SMTP_HOST` points at it.
- A send failure is logged and returns `{ accepted: false }`; it never fails the request or the job that raised the event.
- `seller.applied`, `seller.rejected` and `refund.rejected` are logged only. Every other event sends an email.
- Riders register an FCM token (`POST /api/delivery/fcm-token`) for push notifications from the delivery app; the API stores it for later use.

## Consequences

- One template set to maintain, visible end to end in MailHog during development.
- No SMS costs or provider integration.
- A customer who ignores email can miss a stock-delay notice; the account pages show the same state.
