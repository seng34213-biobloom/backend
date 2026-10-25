import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env by itself. Load it when there is one; CI and
// Render set DATABASE_URL directly. `prisma generate` does not connect, so an
// empty URL is fine before .env exists (npm install runs it on postinstall).
try {
  process.loadEnvFile();
} catch {
  // No .env file
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
