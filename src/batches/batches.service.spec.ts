import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { BatchesService } from './batches.service';

const DAY = 86_400_000;
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const isoDay = (offset: number) =>
  new Date(today.getTime() + offset * DAY).toISOString().slice(0, 10);

const admin = { id: 'admin-1', role: 'ADMIN' } as AuthenticatedUser;
const seller = { id: 'seller-1', role: 'SELLER' } as AuthenticatedUser;

const dto = (overrides: Partial<Record<string, unknown>> = {}) => ({
  batchNumber: ' B-2026-001 ',
  manufacturedDate: isoDay(-10),
  expiryDate: isoDay(90),
  initialQuantity: 40,
  ...overrides,
});

describe('BatchesService', () => {
  let svc: BatchesService;
  let prisma: jest.Mocked<PrismaService>;
  let audit: jest.Mocked<AuditService>;

  beforeEach(() => {
    prisma = {
      productVariant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'v-1',
          productId: 'p-1',
          product: { id: 'p-1', sellerId: 'seller-1' },
        }),
      },
      productBatch: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'b-1', ...data })),
        findMany: jest.fn().mockResolvedValue([]),
      },
      product: { findUnique: jest.fn() },
    } as unknown as jest.Mocked<PrismaService>;
    audit = { record: jest.fn() } as unknown as jest.Mocked<AuditService>;
    svc = new BatchesService(prisma, audit);
  });

  describe('createForVariant', () => {
    it('creates an ACTIVE batch with currentQuantity equal to initialQuantity', async () => {
      const out = await svc.createForVariant('p-1', 'v-1', dto(), admin);

      expect(out).toMatchObject({
        batchNumber: 'B-2026-001',
        initialQuantity: 40,
        currentQuantity: 40,
        status: 'ACTIVE',
      });
    });

    it('records a batch.create audit row for an admin', async () => {
      await svc.createForVariant('p-1', 'v-1', dto(), admin);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'ADMIN',
          actorId: 'admin-1',
          action: 'batch.create',
          targetType: 'ProductBatch',
          targetId: 'b-1',
        }),
      );
    });

    it('keeps a seller ID in metadata because actor_id only references admins', async () => {
      await svc.createForVariant('p-1', 'v-1', dto(), seller);

      const entry = (audit.record as jest.Mock).mock.calls[0][0];
      expect(entry.actorType).toBe('SELLER');
      expect(entry.actorId).toBeNull();
      expect(entry.metadata).toMatchObject({ sellerId: 'seller-1', productId: 'p-1' });
    });

    it.each([
      ['a manufactured date in the future', { manufacturedDate: isoDay(1) }, /future/],
      ['an expiry date of today', { expiryDate: isoDay(0) }, /future/],
      ['an expiry date in the past', { expiryDate: isoDay(-1) }, /future/],
      ['an unparseable date', { expiryDate: 'not-a-date' }, /Invalid date/],
    ])('rejects %s with 400', async (_label, overrides, message) => {
      const attempt = svc.createForVariant('p-1', 'v-1', dto(overrides), admin);
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(message);
      expect(prisma.productBatch.create).not.toHaveBeenCalled();
    });

    it('returns 404 when the variant does not belong to the product', async () => {
      await expect(
        svc.createForVariant('other-product', 'v-1', dto(), admin),
      ).rejects.toBeInstanceOf(NotFoundException);

      (prisma.productVariant.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(svc.createForVariant('p-1', 'missing', dto(), admin)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("returns 403 when a seller adds stock to another seller's product", async () => {
      const otherSeller = { id: 'seller-2', role: 'SELLER' } as AuthenticatedUser;
      await expect(svc.createForVariant('p-1', 'v-1', dto(), otherSeller)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('returns 409 for a duplicate batch number instead of a database error', async () => {
      (prisma.productBatch.create as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const attempt = svc.createForVariant('p-1', 'v-1', dto(), admin);
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(/B-2026-001 already exists/);
    });

    it('rethrows other database errors', async () => {
      (prisma.productBatch.create as jest.Mock).mockRejectedValue(new Error('connection lost'));
      await expect(svc.createForVariant('p-1', 'v-1', dto(), admin)).rejects.toThrow(
        'connection lost',
      );
    });
  });

  describe('listForProduct', () => {
    it('lists batches earliest-expiry first with the batch number as tie-break', async () => {
      (prisma.product.findUnique as jest.Mock).mockResolvedValue({ id: 'p-1', sellerId: null });

      await svc.listForProduct('p-1', admin);

      const args = (prisma.productBatch.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({ variant: { productId: 'p-1' } });
      expect(args.orderBy).toEqual([{ expiryDate: 'asc' }, { batchNumber: 'asc' }]);
    });

    it('returns 404 for an unknown product', async () => {
      (prisma.product.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(svc.listForProduct('missing', admin)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets a seller see only their own products', async () => {
      (prisma.product.findUnique as jest.Mock).mockResolvedValue({
        id: 'p-1',
        sellerId: 'seller-1',
      });
      await expect(svc.listForProduct('p-1', seller)).resolves.toEqual([]);

      (prisma.product.findUnique as jest.Mock).mockResolvedValue({ id: 'p-2', sellerId: null });
      await expect(svc.listForProduct('p-2', seller)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
