# Contributing to the Bio Bloom API

This guide covers how work moves from a GitHub issue to a merged pull request. Read it before opening your first branch. Each issue carries its acceptance criteria, test requirements and Definition of Done.

## Branches

| Branch    | Purpose                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| `develop` | Default branch and integration line. Every pull request targets it. Each merge deploys staging. |
| `main`    | Release line, updated from `develop` by a release pull request.                                 |

Both branches are protected: no direct pushes, and a merge needs a passing CI run and one approving review.

Work on one short-lived branch per issue, cut from an up-to-date `develop`:

| Issue type                            | Branch pattern        | Example                   |
| ------------------------------------- | --------------------- | ------------------------- |
| `feat`                                | `feature/<NN>-<slug>` | `feature/15-billing-cron` |
| `fix`                                 | `fix/<NN>-<slug>`     | `fix/64-cron-concurrency` |
| `chore`, `docs`, `test`, `ci`, `perf` | `chore/<NN>-<slug>`   | `chore/62-ci-pipeline`    |

`<NN>` is the GitHub issue number and `<slug>` a few lowercase words joined by hyphens.

```bash
git switch develop
git pull --ff-only
git switch -c feature/15-billing-cron
```

Stay inside the issue's scope. An unrelated fix gets its own issue and branch.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<scope>): <concise message in present tense>

<one or two lines saying what changed and why>

Refs #<N>
```

- **Types:** `feat`, `fix`, `test`, `ci`, `build`, `perf`, `refactor`, `docs`, `chore`, `style`.
- **Scope:** the module the commit changes, for example `auth`, `inventory`, `subscriptions`, `pipeline`, `adr`.
- Keep the first line at 72 characters or fewer.
- One concern per commit: the schema, service, controller and tests for one behaviour belong together; an unrelated refactor does not.
- Every commit ends with `Refs #<N>`, except the last commit of the issue, which ends with `Closes #<N>`.
- Never commit secrets, a `.env` file with real keys, or build output.

## Before you push

Run what CI runs:

```bash
npm ci
npm run lint
npm run format:check
npm run build
npm run test:cov
docker compose up -d
npm run prisma:deploy
npm run test:e2e
```

| Area changed  | Extra checks                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------- |
| Prisma schema | `npm run prisma:migrate -- --name <change>`, and commit the generated migration              |
| Dependencies  | `npm audit --audit-level=high` must pass                                                     |
| Docker or CI  | `hadolint Dockerfile` and `actionlint .github/workflows/ci.yml`                              |
| Performance   | The k6 scripts in [load-test/](load-test/README.md) when checkout or billing changes         |
| Markdown      | `npm run format:check` (Prettier checks Markdown too); `npm run format` fixes files in place |

## Pull requests

1. Push the branch: `git push -u origin <branch>`.
2. Open a pull request against `develop`, titled in Conventional Commits form, for example `feat(subscriptions): add daily Subscribe & Save billing job`.
3. Fill in every section of the [template](.github/pull_request_template.md): Summary, Changes, Design notes, How to test, the Definition of Done checklist, and the `Closes #<N>` line.
4. Add the issue's labels, assign yourself, and request a reviewer. [CODEOWNERS](.github/CODEOWNERS) requests the owners of the paths you touched.
5. Wait for a green CI run and one approval with no blocker comments. Answer review comments with new commits.
6. Merge with a **merge commit** (not squash, not rebase), so the per-concern commits and their `Refs` lines stay in history. Never bypass branch protection.
7. Tick the completed checkboxes on the issue, delete the branch, and update your local `develop`.

```bash
gh pr checks --watch
gh pr merge --merge --delete-branch
git switch develop
git pull --ff-only
```

## Definition of Done

An issue is done when:

- the code is implemented and follows the team coding standards;
- unit tests pass with at least 80% coverage;
- integration tests pass;
- the pull request targets `develop`;
- at least one peer review has approved it, with no blocker comments;
- CI passes (lint, build, test, audit);
- no secrets are hard-coded;
- `CHANGELOG.md` is updated.

## Changelog

Every pull request that changes behaviour adds an entry to [CHANGELOG.md](CHANGELOG.md) under `## [Unreleased]`, in the same pull request:

- Use the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) headings: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- Write for someone using or running the API: say what changed, not which files.
- End the entry with the issue number, for example `(#15)`.
- On a merge conflict in `CHANGELOG.md`, keep both entries.

A test-only change or a CI tweak with no visible effect may skip the changelog; say so in the pull request.

## Architecture decisions

A change that alters an architectural decision (a dependency with lasting impact, a different data model, a new integration pattern) needs a record in [docs/adr/](docs/adr/README.md), in the same pull request or one before it.

## Code style

- TypeScript strict mode. Follow the patterns of the module you are changing: NestJS modules, services, controllers and DTOs.
- Validate every request body with a class-validator DTO. Validation errors return 422.
- Compute money with `Prisma.Decimal`, never JavaScript numbers, and return it as a two-decimal string.
- Record every privileged change through `AuditService.record` with the real actor.
- Keep comments for the reasons behind the code, citing the SDS section where it helps.
