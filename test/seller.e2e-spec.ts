import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER_NAME } from '../src/common/middleware/csrf.middleware';

/**
 * Phase 3 e2e — exercises the full seller lifecycle plus the audit trail.
 *   1. Public apply  → PENDING row, no login allowed
 *   2. Admin lists pending applications
 *   3. Admin approves → status APPROVED, AuditLog row written
 *   4. Approved seller can log in (Phase 2 AuthService picks SELLER role)
 *   5. Reject path & duplicate apply path
 */
describe('Seller flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = Date.now();
  const sellerEmailA = `apply-a-${stamp}@bbtest.lk`;
  const sellerEmailB = `apply-b-${stamp}@bbtest.lk`;
  const sellerPassword = 'Password123!';

  // The seed creates this admin with the same password.
  const adminEmail = 'admin@biobloom.lk';
  const adminPassword = 'Password123!';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(ThrottlerModule)
      .useModule(
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: 10_000 },
          { name: 'auth', ttl: 900_000, limit: 10_000 },
        ]),
      )
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        errorHttpStatusCode: 422,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      // Audit log rows reference the seller via metadata + targetId; safe to
      // leave them as historical record. Clean only the seller rows so reruns
      // are idempotent.
      await prisma.auditLog.deleteMany({
        where: { targetType: 'Seller', targetId: { in: [] } },
      });
      await prisma.seller.deleteMany({
        where: { email: { in: [sellerEmailA, sellerEmailB] } },
      });
    }
    await app.close();
  });

  async function csrfHandshake(): Promise<{ cookie: string; header: string }> {
    const res = await request(app.getHttpServer()).get('/api/auth/csrf').expect(200);
    const setCookie = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const csrfCookie = setCookie.find((c: string) => c.startsWith('csrf-token='));
    if (!csrfCookie) throw new Error('csrf-token cookie not set');
    const value = csrfCookie.split(';')[0].split('=')[1];
    return { cookie: csrfCookie.split(';')[0], header: value };
  }

  async function loginAdmin(csrf: { cookie: string; header: string }): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Cookie', csrf.cookie)
      .set(CSRF_HEADER_NAME, csrf.header)
      .send({ email: adminEmail, password: adminPassword })
      .expect(200);
    const setCookie = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const authCookie = setCookie.find((c: string) => c.startsWith('auth_token='));
    if (!authCookie) throw new Error('auth_token cookie not set');
    return authCookie.split(';')[0];
  }

  it('full lifecycle: apply → list pending → approve → login as seller', async () => {
    const csrf = await csrfHandshake();

    // 1. Apply
    const applyRes = await request(app.getHttpServer())
      .post('/api/sellers/apply')
      .set('Cookie', csrf.cookie)
      .set(CSRF_HEADER_NAME, csrf.header)
      .send({
        email: sellerEmailA,
        password: sellerPassword,
        businessName: `Test Kitchen ${stamp}`,
        contactName: 'E2E',
        phone: '+94770000001',
      })
      .expect(201);
    expect(applyRes.body.status).toBe('PENDING');
    const sellerId: string = applyRes.body.id;

    // 2. PENDING seller cannot log in
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Cookie', csrf.cookie)
      .set(CSRF_HEADER_NAME, csrf.header)
      .send({ email: sellerEmailA, password: sellerPassword })
      .expect(403);

    // 3. Admin logs in
    const adminCookie = await loginAdmin(csrf);

    // 4. Admin lists pending applications, sees ours
    const listRes = await request(app.getHttpServer())
      .get('/api/admin/sellers/pending')
      .set('Cookie', [csrf.cookie, adminCookie].join('; '))
      .expect(200);
    const found = listRes.body.find((s: { id: string }) => s.id === sellerId);
    expect(found).toBeDefined();
    expect(found.email).toBe(sellerEmailA);

    // 5. Admin approves
    const approveRes = await request(app.getHttpServer())
      .post(`/api/admin/sellers/${sellerId}/approve`)
      .set('Cookie', [csrf.cookie, adminCookie].join('; '))
      .set(CSRF_HEADER_NAME, csrf.header)
      .expect(200);
    expect(approveRes.body.status).toBe('APPROVED');

    // 6. AuditLog row exists for the approval
    const auditRow = await prisma.auditLog.findFirst({
      where: { action: 'seller.approve', targetType: 'Seller', targetId: sellerId },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorType).toBe('ADMIN');
    expect(auditRow?.actorId).toBeDefined();

    // 7. Approved seller can now log in with role=SELLER
    const sellerLoginRes = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Cookie', csrf.cookie)
      .set(CSRF_HEADER_NAME, csrf.header)
      .send({ email: sellerEmailA, password: sellerPassword })
      .expect(200);
    expect(sellerLoginRes.body.role).toBe('SELLER');
  });

  it('reject path persists reason and audits, blocks login', async () => {
    const csrf = await csrfHandshake();

    const applyRes = await request(app.getHttpServer())
      .post('/api/sellers/apply')
      .set('Cookie', csrf.cookie)
      .set(CSRF_HEADER_NAME, csrf.header)
      .send({
        email: sellerEmailB,
        password: sellerPassword,
        businessName: `Reject Test ${stamp}`,
        contactName: 'E2E',
        phone: '+94770000002',
      })
      .expect(201);
    const sellerId: string = applyRes.body.id;

    const adminCookie = await loginAdmin(csrf);

    const rejectRes = await request(app.getHttpServer())
      .post(`/api/admin/sellers/${sellerId}/reject`)
      .set('Cookie', [csrf.cookie, adminCookie].join('; '))
      .set(CSRF_HEADER_NAME, csrf.header)
      .send({ reason: 'No tax ID provided' })
      .expect(200);
    expect(rejectRes.body.status).toBe('REJECTED');

    const row = await prisma.seller.findUnique({ where: { id: sellerId } });
    expect(row?.rejectionReason).toBe('No tax ID provided');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'seller.reject', targetId: sellerId },
    });
    expect(audit).not.toBeNull();

    // Rejected seller cannot log in
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Cookie', csrf.cookie)
      .set(CSRF_HEADER_NAME, csrf.header)
      .send({ email: sellerEmailB, password: sellerPassword })
      .expect(403);
  });

  it('duplicate apply returns 409', async () => {
    const csrf = await csrfHandshake();
    await request(app.getHttpServer())
      .post('/api/sellers/apply')
      .set('Cookie', csrf.cookie)
      .set(CSRF_HEADER_NAME, csrf.header)
      .send({
        email: sellerEmailA, // already applied in the first test
        password: sellerPassword,
        businessName: 'Dup',
        contactName: 'X',
        phone: '+94770000003',
      })
      .expect(409);
  });

  it('admin endpoints require an authenticated admin', async () => {
    // No cookies → JwtAuthGuard 401
    await request(app.getHttpServer()).get('/api/admin/sellers/pending').expect(401);
  });

  it('non-admin (customer) gets 403 on admin endpoints', async () => {
    const csrf = await csrfHandshake();
    const customerEmail = `cust-${stamp}@bbtest.lk`;
    const password = 'Password123!';

    // Register a customer and log in
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .set('Cookie', csrf.cookie)
      .set(CSRF_HEADER_NAME, csrf.header)
      .send({ email: customerEmail, password, name: 'Cust' })
      .expect(201);
    const loginRes = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Cookie', csrf.cookie)
      .set(CSRF_HEADER_NAME, csrf.header)
      .send({ email: customerEmail, password })
      .expect(200);
    const setCookie = (loginRes.headers['set-cookie'] as unknown as string[]) ?? [];
    const authCookie = (setCookie.find((c: string) => c.startsWith('auth_token=')) as string).split(
      ';',
    )[0];

    await request(app.getHttpServer())
      .get('/api/admin/sellers/pending')
      .set('Cookie', [csrf.cookie, authCookie].join('; '))
      .expect(403);

    // Cleanup customer at end
    await prisma.customer.deleteMany({ where: { email: customerEmail } });
  });
});
