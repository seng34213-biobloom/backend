# ADR-001: One repository per application

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** DDP-#01, DDP-#09, SDS §2.3, §8.3

## Context

Bio Bloom has a NestJS API, a Next.js web front end (storefront, admin console and seller portal) and a Flutter delivery app. The module guidelines name separate repositories for the back end, front end and mobile app. A single monorepo would let the apps share TypeScript types and the Prisma client, but it would also tie every team member's work to one lockfile, one toolchain and one CI run.

## Decision

- The organisation has one repository per application: `backend` (this API), `frontend`, `mobile` and `documents`.
- The API owns the database: the Prisma schema, migrations and generated client live only here.
- The front end and the mobile app talk to the API over HTTPS and keep their own types for its responses.
- Each repository has its own CI, branch protection and release flow.

## Consequences

- A team member can build and test one application without installing the others.
- A schema change that affects a client needs a coordinated change in that client's repository; the API's README documents every route.
- Types can drift between the API and its clients. A breaking response change must be called out in the pull request and in `CHANGELOG.md`.
