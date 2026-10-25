process.env.TZ = 'UTC';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { Request } from 'express';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureApp(app);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
    }),
  );

  const verifyRawBody = (req: Request & { rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
    if (req.originalUrl?.startsWith('/api/webhooks/')) {
      req.rawBody = Buffer.from(new Uint8Array(buf));
    }
  };
  app.use(express.json({ verify: verifyRawBody }));
  app.use(express.urlencoded({ extended: true, verify: verifyRawBody }));

  const port = Number(app.get(ConfigService).get('PORT')) || 4000;
  await app.listen(port);
  Logger.log(`API listening on http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
