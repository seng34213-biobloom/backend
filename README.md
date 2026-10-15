# backend

Bio Bloom NestJS REST API and Core Domain Services

## Tech stack

- NestJS 10 (TypeScript)
- Prisma ORM with PostgreSQL 15
- Jest and Supertest for tests
- GitHub Actions for CI

## Getting started

Requirements: Node.js 20 (see `.nvmrc`), npm and Docker.

```bash
# 1. Install dependencies (also generates the Prisma client)
npm install

# 2. Create your local env file
cp .env.example .env

# 3. Start PostgreSQL
docker compose up -d

# 4. Run the API in watch mode
npm run start:dev
```

The API runs on http://localhost:4000/api. Check it with:

```bash
curl http://localhost:4000/api/health
```

## Scripts

| Command                  | Description                                       |
| ------------------------ | ------------------------------------------------- |
| `npm run start:dev`      | Start the API in watch mode                       |
| `npm run build`          | Compile to `dist/`                                |
| `npm run start:prod`     | Run the compiled build                            |
| `npm run lint`           | Run ESLint                                        |
| `npm run format:check`   | Check formatting with Prettier                    |
| `npm test`               | Run unit tests                                    |
| `npm run test:e2e`       | Run integration tests (needs a running database)  |
| `npm run prisma:migrate` | Create and apply a migration from `schema.prisma` |
| `npm run prisma:studio`  | Open Prisma Studio                                |

## Project structure

```
src/
  app.module.ts     Root module
  app.setup.ts      Global prefix, CORS and validation, shared with e2e tests
  main.ts           Entry point
  health/           GET /api/health liveness check
  prisma/           PrismaService, available globally
prisma/
  schema.prisma     Database schema
test/               Integration tests
```

## Branching

Work happens on short-lived branches cut from `develop`, and changes reach `develop` through a pull request with one approval. `main` is updated from `develop` for releases.
