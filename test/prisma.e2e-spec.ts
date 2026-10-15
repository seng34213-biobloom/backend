import { PrismaService } from '../src/prisma/prisma.service';

describe('PrismaService (integration)', () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('connects to the database and runs a query', async () => {
    const rows = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;

    expect(rows).toEqual([{ ok: 1 }]);
  });
});
