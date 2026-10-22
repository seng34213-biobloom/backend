import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

type Agent = ReturnType<typeof request.agent>;
interface Session {
  agent: Agent;
  csrf: string;
}

describe('Product administration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = `productadmin${Date.now()}`;
  const password = 'ProductAdmin2026';
  const ids = { sellerA: '', sellerB: '', product: '', variant: '' };
  const sessions = {} as Record<'sellerA' | 'sellerB', Session>;

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

  const createProduct = (who: Session, slug: string) =>
    who.agent
      .post('/api/admin/products')
      .set('x-csrf-token', who.csrf)
      .send({
        name: `${stamp} Honey`,
        slug,
        description: 'Product admin fixture',
        category: 'honey',
        basePrice: 1500,
        unitWeightGrams: 320,
        variants: [
          {
            sku: `${slug}-250`,
            name: 'Wild Honey 250g',
            size: '250 g',
            price: 1500,
            unitWeightGrams: 320,
          },
        ],
      });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const passwordHash = await bcrypt.hash(password, 4);
    const createSeller = (suffix: string) =>
      prisma.seller.create({
        data: {
          email: `${suffix}.${stamp}@example.com`,
          passwordHash,
          businessName: `${suffix} Foods`,
          contactName: suffix,
          phone: '0771234567',
          status: 'APPROVED',
        },
      });
    ids.sellerA = (await createSeller('seller-a')).id;
    ids.sellerB = (await createSeller('seller-b')).id;
    sessions.sellerA = await signIn(`seller-a.${stamp}@example.com`);
    sessions.sellerB = await signIn(`seller-b.${stamp}@example.com`);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [ids.product, ids.variant] } } });
      await prisma.product.deleteMany({ where: { slug: { startsWith: stamp } } });
      await prisma.seller.deleteMany({ where: { email: { contains: stamp } } });
    }
    await app?.close();
  });

  it('lets an approved seller create a product with variants and writes an audit row', async () => {
    const response = await createProduct(sessions.sellerA, `${stamp}-honey`).expect(201);
    ids.product = response.body.id as string;
    ids.variant = response.body.variants[0].id as string;

    expect(response.body).toMatchObject({
      sellerId: ids.sellerA,
      slug: `${stamp}-honey`,
      active: true,
    });
    const audit = await prisma.auditLog.findFirst({
      where: { targetId: ids.product, action: 'product.create' },
    });
    expect(audit).toMatchObject({
      actorType: 'SELLER',
      actorId: null,
      targetType: 'Product',
      metadata: expect.objectContaining({ sellerId: ids.sellerA }),
    });

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const date = (offset: number) =>
      new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
    await sessions.sellerA.agent
      .post(`/api/admin/products/${ids.product}/variants/${ids.variant}/batches`)
      .set('x-csrf-token', sessions.sellerA.csrf)
      .send({
        batchNumber: `${stamp}-initial`,
        manufacturedDate: date(-5),
        expiryDate: date(60),
        initialQuantity: 8,
      })
      .expect(201);

    const catalogue = await request(app.getHttpServer())
      .get('/api/products')
      .query({ search: stamp })
      .expect(200);
    expect(catalogue.body.items.map((item: { id: string }) => item.id)).toContain(ids.product);
  });

  it('rejects duplicate slugs and invalid product weights', async () => {
    await createProduct(sessions.sellerB, `${stamp}-honey`).expect(409);

    await sessions.sellerA.agent
      .post('/api/admin/products')
      .set('x-csrf-token', sessions.sellerA.csrf)
      .send({
        name: 'Invalid Weight',
        slug: `${stamp}-invalid-weight`,
        description: 'Invalid fixture',
        category: 'honey',
        basePrice: 100,
        unitWeightGrams: 0,
        variants: [
          {
            sku: `${stamp}-invalid`,
            name: 'Invalid',
            size: '1 g',
            price: 100,
            unitWeightGrams: 1,
          },
        ],
      })
      .expect(422);
  });

  it('prevents one seller from editing another seller product', async () => {
    await sessions.sellerB.agent
      .patch(`/api/admin/products/${ids.product}`)
      .set('x-csrf-token', sessions.sellerB.csrf)
      .send({ name: 'Not allowed' })
      .expect(403);
  });

  it('deactivates products and variants so the public catalogue hides them', async () => {
    await sessions.sellerA.agent
      .delete(`/api/admin/products/${ids.product}/variants/${ids.variant}`)
      .set('x-csrf-token', sessions.sellerA.csrf)
      .expect(200);

    const inactiveVariant = await prisma.productVariant.findUnique({
      where: { id: ids.variant },
    });
    expect(inactiveVariant?.active).toBe(false);

    await sessions.sellerA.agent
      .delete(`/api/admin/products/${ids.product}`)
      .set('x-csrf-token', sessions.sellerA.csrf)
      .expect(200);
    await request(app.getHttpServer()).get(`/api/products/${stamp}-honey`).expect(404);

    const inactiveProduct = await prisma.product.findUnique({ where: { id: ids.product } });
    expect(inactiveProduct?.active).toBe(false);
  });
});
