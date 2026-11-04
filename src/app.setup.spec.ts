import {
  Controller,
  Get,
  INestApplication,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app.setup';
import { CSRF_COOKIE_NAME, CsrfMiddleware } from './common/middleware/csrf.middleware';

@Controller('ping')
class PingController {
  @Get()
  ping(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [PingController] })
class PingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CsrfMiddleware).forRoutes('*');
  }
}

async function createApp(env: Record<string, string>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => env] }), PingModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

function preflight(app: INestApplication, origin: string) {
  return request(app.getHttpServer())
    .options('/api/ping')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
}

describe('configureApp CORS', () => {
  const savedOrigins = process.env.CORS_ORIGINS;
  let app: INestApplication;

  beforeEach(() => {
    delete process.env.CORS_ORIGINS;
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    if (savedOrigins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = savedOrigins;
  });

  it.each([
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:8080',
  ])('allows %s with credentials by default', async (origin) => {
    app = await createApp({});

    const res = await preflight(app, origin).expect(204);

    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toBe('content-type,x-csrf-token');
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,PUT,PATCH,DELETE,OPTIONS');
    expect(res.headers['access-control-expose-headers']).toBe('x-csrf-token');
  });

  it('sends no CORS headers to an origin that is not listed', async () => {
    app = await createApp({});

    const res = await preflight(app, 'http://localhost:9999');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('uses CORS_ORIGINS when it is set, trimming spaces and empty entries', async () => {
    app = await createApp({ CORS_ORIGINS: ' https://shop.example.com , ,http://localhost:8080' });

    const listed = await preflight(app, 'https://shop.example.com').expect(204);
    const mobile = await preflight(app, 'http://localhost:8080').expect(204);
    const dropped = await preflight(app, 'http://localhost:3000');

    expect(listed.headers['access-control-allow-origin']).toBe('https://shop.example.com');
    expect(mobile.headers['access-control-allow-origin']).toBe('http://localhost:8080');
    expect(dropped.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets the mobile web build read the CSRF token and store the cookie in production', async () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      app = await createApp({ CORS_ORIGINS: 'https://shop.example.com,http://localhost:8080' });

      const res = await request(app.getHttpServer())
        .get('/api/ping')
        .set('Origin', 'http://localhost:8080')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8080');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      const cookies = res.headers['set-cookie'] as unknown as string[];
      const csrf = cookies.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
      expect(csrf).toMatch(/; Secure/);
      expect(csrf).toMatch(/SameSite=None/);
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
});
