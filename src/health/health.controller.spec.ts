import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthController } from './health.controller';
import { HealthModule } from './health.module';

describe('HealthController', () => {
  let app: INestApplication;
  let controller: HealthController;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    controller = moduleRef.get(HealthController);
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports status ok with an ISO timestamp', () => {
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('GET /api/health returns 200 OK', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);

    expect(res.body.status).toBe('ok');
  });
});
