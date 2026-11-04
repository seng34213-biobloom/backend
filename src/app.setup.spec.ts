import { Controller, Get, INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from './app.setup';

@Controller('ping')
class PingController {
  @Get()
  ping(): { ok: boolean } {
    return { ok: true };
  }
}

async function createApp(env: Record<string, string>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => env] })],
    controllers: [PingController],
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
});
