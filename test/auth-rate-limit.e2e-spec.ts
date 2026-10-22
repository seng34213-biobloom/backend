import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

describe('Authentication rate limit (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('allows 20 auth requests per IP and rejects the 21st within 15 minutes', async () => {
    const token = 'a'.repeat(48);
    const cookie = `csrf-token=${token}`;

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('Cookie', cookie)
        .set('x-csrf-token', token)
        .send({})
        .expect(422);
    }

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({})
      .expect(429);
  });
});
