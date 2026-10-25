import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { fixtureEmail, fixtureNamespace } from './helpers/fixtures';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const email = fixtureEmail(fixtureNamespace('auth'), 'customer');
  const password = 'Sunset2026';

  // POST routes need the double-submit CSRF cookie and header
  const csrf = async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/csrf').expect(200);
    return {
      token: res.body.csrfToken as string,
      cookie: res.headers['set-cookie'] as unknown as string[],
    };
  };

  const post = async (path: string, body: object) => {
    const { token, cookie } = await csrf();
    return request(app.getHttpServer())
      .post(path)
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send(body);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.customer.deleteMany({ where: { email } });
    }
    await app?.close();
  });

  it('POST /api/auth/register creates a customer and returns 201', async () => {
    const res = await post('/api/auth/register', { email, password, name: 'Nimal Perera' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email, name: 'Nimal Perera' });
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('POST /api/auth/register with the same email returns 409', async () => {
    const res = await post('/api/auth/register', { email, password, name: 'Nimal Perera' });
    expect(res.status).toBe(409);
  });

  it('POST /api/auth/login with valid credentials returns 200 and an HTTP-only cookie', async () => {
    const res = await post('/api/auth/login', { email, password });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email, role: 'CUSTOMER' });
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const authCookie = cookies.find((c) => c.startsWith('auth_token='));
    expect(authCookie).toBeDefined();
    expect(authCookie).toMatch(/HttpOnly/i);
    expect(authCookie).toMatch(/SameSite=Strict/i);
  });

  it('POST /api/auth/login with a wrong password returns 401', async () => {
    const res = await post('/api/auth/login', { email, password: 'WrongPass99' });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/logout clears the cookie and revokes the session token', async () => {
    const loginCsrf = await csrf();
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Cookie', loginCsrf.cookie)
      .set('x-csrf-token', loginCsrf.token)
      .send({ email, password })
      .expect(200);
    const loginCookies = login.headers['set-cookie'] as unknown as string[];
    const authCookie = loginCookies.find((cookie) => cookie.startsWith('auth_token='));
    if (!authCookie) {
      throw new Error('Login response did not set the auth_token cookie');
    }

    const logoutCsrf = await csrf();
    const csrfCookie = logoutCsrf.cookie.find((cookie) => cookie.startsWith('csrf-token='));
    if (!csrfCookie) {
      throw new Error('CSRF endpoint did not set the csrf-token cookie');
    }

    const logout = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', `${authCookie.split(';')[0]}; ${csrfCookie.split(';')[0]}`)
      .set('x-csrf-token', logoutCsrf.token)
      .expect(204);

    expect(logout.headers['set-cookie'] as unknown as string[]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^auth_token=;/)]),
    );
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', authCookie.split(';')[0])
      .expect(401);
  });

  it('POST without a CSRF token returns 403', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(403);
  });
});
