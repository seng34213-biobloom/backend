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

  it('does not apply the auth limit to other routes', async () => {
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      const res = await request(app.getHttpServer()).get('/api/health').expect(200);
      expect(res.headers['x-ratelimit-limit-auth']).toBeUndefined();
    }
  });

  describe('with THROTTLE_AUTH_LIMIT set, as for a load test', () => {
    let raised: INestApplication;

    beforeAll(async () => {
      process.env.THROTTLE_AUTH_LIMIT = '30';
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      raised = moduleRef.createNestApplication();
      configureApp(raised);
      await raised.init();
    });

    afterAll(async () => {
      delete process.env.THROTTLE_AUTH_LIMIT;
      await raised?.close();
    });

    it('allows 30 auth requests and rejects the 31st', async () => {
      const token = 'b'.repeat(48);
      const login = () =>
        request(raised.getHttpServer())
          .post('/api/auth/login')
          .set('Cookie', `csrf-token=${token}`)
          .set('x-csrf-token', token)
          .send({});

      for (let attempt = 1; attempt <= 30; attempt += 1) {
        await login().expect(422);
      }
      await login().expect(429);
    });
  });
});
