import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { InventoryService } from '../src/inventory/inventory.service';
import { PrismaService } from '../src/prisma/prisma.service';

type Agent = ReturnType<typeof request.agent>;
interface Session {
  agent: Agent;
  csrf: string;
}

describe('Batch management (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = `batches${Date.now()}`;
  const password = 'Harvest2026';
  const ids = {
    sellerA: '',
    sellerB: '',
    admin: '',
    productA: '',
    variantA: '',
    productB: '',
    variantB: '',
  };
  const createdBatchIds: string[] = [];
  const sessions = {} as Record<'admin' | 'sellerA' | 'sellerB' | 'customer', Session>;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const isoDay = (offset: number) =>
    new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

  const signIn = async (email: string): Promise<Session> => {
    const agent = request.agent(app.getHttpServer());
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken as string;
    await agent
      .post('/api/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password })
      .expect(200);
    return { agent, csrf };
  };

  const createBatch = (
    who: Session,
    body: Record<string, unknown>,
    productId = ids.productA,
    variantId = ids.variantA,
  ) =>
    who.agent
      .post(`/api/admin/products/${productId}/variants/${variantId}/batches`)
      .set('x-csrf-token', who.csrf)
      .send({
        manufacturedDate: isoDay(-7),
        expiryDate: isoDay(120),
        initialQuantity: 25,
        ...body,
      });

  const createProduct = (slug: string, sellerId: string) =>
    prisma.product.create({
      data: {
        sellerId,
        slug,
        name: `${slug} Kithul Treacle`,
        description: 'Batch fixture',
        category: 'treacle',
        basePrice: '1200.00',
        unitWeightGrams: 400,
        variants: {
          create: {
            sku: `${slug}-350`,
            name: '350ml',
            size: '350 ml',
            price: '1200.00',
            unitWeightGrams: 400,
          },
        },
      },
      include: { variants: true },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const passwordHash = await bcrypt.hash(password, 4);
    const seller = (name: string) =>
      prisma.seller.create({
        data: {
          email: `${name}.${stamp}@example.com`,
          passwordHash,
          businessName: `${name} Foods`,
          contactName: name,
          phone: '0771234567',
          status: 'APPROVED',
        },
      });
    ids.sellerA = (await seller('sellera')).id;
    ids.sellerB = (await seller('sellerb')).id;
    ids.admin = (
      await prisma.adminUser.create({
        data: { email: `admin.${stamp}@example.com`, passwordHash, name: 'Admin', role: 'ADMIN' },
      })
    ).id;
    await prisma.customer.create({
      data: { email: `customer.${stamp}@example.com`, passwordHash, name: 'Customer' },
    });

    const productA = await createProduct(`${stamp}-a`, ids.sellerA);
    const productB = await createProduct(`${stamp}-b`, ids.sellerB);
    ids.productA = productA.id;
    ids.variantA = productA.variants[0].id;
    ids.productB = productB.id;
    ids.variantB = productB.variants[0].id;

    sessions.admin = await signIn(`admin.${stamp}@example.com`);
    sessions.sellerA = await signIn(`sellera.${stamp}@example.com`);
    sessions.sellerB = await signIn(`sellerb.${stamp}@example.com`);
    sessions.customer = await signIn(`customer.${stamp}@example.com`);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.auditLog.deleteMany({ where: { targetId: { in: createdBatchIds } } });
      await prisma.product.deleteMany({ where: { slug: { startsWith: stamp } } });
      await prisma.seller.deleteMany({ where: { email: { contains: stamp } } });
      await prisma.adminUser.deleteMany({ where: { email: { contains: stamp } } });
      await prisma.customer.deleteMany({ where: { email: { contains: stamp } } });
    }
    await app?.close();
  });

  it('lets an admin create a batch, audits it and adds the stock', async () => {
    const inventory = app.get(InventoryService);
    const before = await inventory.availableStock(ids.variantA);

    const res = await createBatch(sessions.admin, {
      batchNumber: 'KT-LATE',
      expiryDate: isoDay(200),
    }).expect(201);
    createdBatchIds.push(res.body.id);

    expect(res.body).toMatchObject({
      batchNumber: 'KT-LATE',
      status: 'ACTIVE',
      initialQuantity: 25,
      currentQuantity: 25,
    });
    expect(await inventory.availableStock(ids.variantA)).toBe(before + 25);

    const audit = await prisma.auditLog.findFirst({ where: { targetId: res.body.id } });
    expect(audit).toMatchObject({ actorType: 'ADMIN', actorId: ids.admin, action: 'batch.create' });
  });

  it('lets a seller add stock to their own product and audits it under metadata', async () => {
    const res = await createBatch(sessions.sellerA, {
      batchNumber: 'KT-EARLY',
      expiryDate: isoDay(30),
    }).expect(201);
    createdBatchIds.push(res.body.id);

    const audit = await prisma.auditLog.findFirst({ where: { targetId: res.body.id } });
    expect(audit).toMatchObject({ actorType: 'SELLER', actorId: null, action: 'batch.create' });
    expect(audit?.metadata).toMatchObject({ sellerId: ids.sellerA, productId: ids.productA });
  });

  it('GET /api/admin/products/:productId/batches lists batches in expiry order', async () => {
    const tie = await createBatch(sessions.admin, {
      batchNumber: 'KT-A-TIE',
      expiryDate: isoDay(30),
    }).expect(201);
    createdBatchIds.push(tie.body.id);

    const res = await sessions.admin.agent
      .get(`/api/admin/products/${ids.productA}/batches`)
      .expect(200);

    expect(res.body.map((b: { batchNumber: string }) => b.batchNumber)).toEqual([
      'KT-A-TIE',
      'KT-EARLY',
      'KT-LATE',
    ]);
    expect(res.body[0].variant).toMatchObject({ id: ids.variantA, size: '350 ml' });
  });

  it('rejects date rule violations with 400', async () => {
    await createBatch(sessions.admin, { batchNumber: 'KT-TODAY', expiryDate: isoDay(0) }).expect(
      400,
    );
    await createBatch(sessions.admin, {
      batchNumber: 'KT-FUTURE-MFG',
      manufacturedDate: isoDay(2),
    }).expect(400);
  });

  it('rejects an invalid quantity or malformed date with 422', async () => {
    await createBatch(sessions.admin, { batchNumber: 'KT-ZERO', initialQuantity: 0 }).expect(422);
    await createBatch(sessions.admin, { batchNumber: 'KT-BAD', expiryDate: '31/12/2027' }).expect(
      422,
    );
  });

  it('returns 404 when the variant belongs to a different product', async () => {
    await createBatch(sessions.admin, { batchNumber: 'KT-MIX' }, ids.productA, ids.variantB).expect(
      404,
    );
  });

  it("returns 403 when a seller touches another seller's product", async () => {
    await createBatch(sessions.sellerB, { batchNumber: 'KT-FOREIGN' }).expect(403);
    await sessions.sellerB.agent.get(`/api/admin/products/${ids.productA}/batches`).expect(403);
  });

  it('returns 409 for a duplicate batch number on the same variant', async () => {
    const res = await createBatch(sessions.admin, { batchNumber: 'KT-LATE' }).expect(409);
    expect(res.body.message).toMatch(/KT-LATE already exists/);
  });

  it('is limited to admins and sellers', async () => {
    await createBatch(sessions.customer, { batchNumber: 'KT-CUSTOMER' }).expect(403);
    await request(app.getHttpServer())
      .get(`/api/admin/products/${ids.productA}/batches`)
      .expect(401);
  });
});
