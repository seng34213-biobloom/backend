<!--
Title: <type>(<scope>): <summary>, for example "feat(subscriptions): add daily billing job".
Target branch: develop.
-->

## Summary

<!-- What this pull request does and why, in two or three sentences. -->

## Changes

<!-- The changes, grouped by area: API, database, scheduled jobs, CI/CD, docs. -->

-

## Design notes

<!-- Decisions, trade-offs and anything a reviewer should look at closely. Link an ADR in docs/adr/ when one applies, and note any deviation from the SDS. -->

## How to test

<!-- Steps a reviewer can follow, with commands and expected results. -->

1. `npm run lint`, `npm run build`, `npm run test:cov`
2. `docker compose up -d`, `npm run prisma:deploy`, then `npm run test:e2e`

## Definition of Done

- [ ] Code implemented and adheres to team coding standards
- [ ] Unit tests passing with >= 80% coverage
- [ ] Integration tests passing
- [ ] PR raised against 'develop' branch
- [ ] At least 1 peer code review approved; no blocker comments
- [ ] CI pipeline passes (lint, build, test, audit)
- [ ] No hardcoded secrets
- [ ] CHANGELOG.md updated

Closes #
