import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';

const DEFAULT_CORS_ORIGINS = 'http://localhost:3000,http://localhost:3001,http://localhost:3002';

// Shared by main.ts and the e2e tests so both run the app with the same settings.
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');

  const origins = config
    .get<string>('CORS_ORIGINS', DEFAULT_CORS_ORIGINS)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token'],
    exposedHeaders: ['x-csrf-token'],
  });

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      errorHttpStatusCode: 422,
    }),
  );

  app.enableShutdownHooks();
}
