import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuditActorType, SupportTicketStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { SupportService } from './support.service';

describe('SupportService', () => {
  let service: SupportService;
  let prisma: jest.Mocked<PrismaService>;
  let audit: jest.Mocked<Pick<AuditService, 'record'>>;
  const ticket = {
    id: 'ticket-1',
    customerId: 'customer-1',
    subject: 'Order problem',
    message: 'My order arrived damaged.',
    status: SupportTicketStatus.OPEN,
    resolvedAt: null,
    closedAt: null,
  };
  const admin: AuthenticatedUser = {
    id: 'admin-1',
    email: 'admin@example.com',
    role: 'ADMIN',
    actorType: 'admin',
    jti: 'jti',
    expiresAt: 0,
  };

  beforeEach(() => {
    prisma = {
      supportTicket: {
        create: jest.fn().mockResolvedValue(ticket),
        findMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(ticket),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...ticket, ...data })),
      },
    } as unknown as jest.Mocked<PrismaService>;
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new SupportService(prisma, audit as unknown as AuditService);
  });

  it('opens a customer ticket and audits its creation', async () => {
    await service.create('customer-1', {
      subject: '  Order problem  ',
      message: '  My order arrived damaged.  ',
    });

    expect(prisma.supportTicket.create).toHaveBeenCalledWith({
      data: {
        customerId: 'customer-1',
        subject: 'Order problem',
        message: 'My order arrived damaged.',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: AuditActorType.CUSTOMER,
        action: 'support.ticket.create',
        targetId: 'ticket-1',
      }),
    );
  });

  it("does not allow a customer to read another customer's ticket", async () => {
    await expect(service.getForCustomer('ticket-1', 'customer-2')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('returns not found for an unknown ticket', async () => {
    (prisma.supportTicket.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(service.getForCustomer('missing', 'customer-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('does not allow a closed ticket to be reopened by its customer', async () => {
    (prisma.supportTicket.findUnique as jest.Mock).mockResolvedValue({
      ...ticket,
      status: SupportTicketStatus.CLOSED,
    });

    await expect(service.reopen('ticket-1', 'customer-1')).rejects.toThrow(BadRequestException);
    expect(prisma.supportTicket.update).not.toHaveBeenCalled();
  });

  it('allows a customer to reopen a resolved ticket and audits it', async () => {
    (prisma.supportTicket.findUnique as jest.Mock).mockResolvedValue({
      ...ticket,
      status: SupportTicketStatus.RESOLVED,
      resolvedAt: new Date(),
    });

    await service.reopen('ticket-1', 'customer-1');

    expect(prisma.supportTicket.update).toHaveBeenCalledWith({
      where: { id: 'ticket-1' },
      data: { status: SupportTicketStatus.OPEN, resolvedAt: null },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support.ticket.reopen', targetId: 'ticket-1' }),
    );
  });

  it('allows admins to resolve tickets and records the status change', async () => {
    await service.updateStatus('ticket-1', { status: SupportTicketStatus.RESOLVED }, admin);

    expect(prisma.supportTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ticket-1' },
        data: expect.objectContaining({
          status: SupportTicketStatus.RESOLVED,
          resolvedAt: expect.any(Date),
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: AuditActorType.ADMIN,
        action: 'support.ticket.status',
      }),
    );
  });

  it('allows admins to close tickets', async () => {
    await service.updateStatus('ticket-1', { status: SupportTicketStatus.CLOSED }, admin);

    expect(prisma.supportTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: SupportTicketStatus.CLOSED,
          closedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('prevents admins from reopening a closed ticket', async () => {
    (prisma.supportTicket.findUnique as jest.Mock).mockResolvedValue({
      ...ticket,
      status: SupportTicketStatus.CLOSED,
    });

    await expect(
      service.updateStatus('ticket-1', { status: SupportTicketStatus.OPEN }, admin),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.supportTicket.update).not.toHaveBeenCalled();
  });

  it('does not allow non-admins to manage ticket status', async () => {
    const customer = { ...admin, role: 'CUSTOMER' as const };

    await expect(
      service.updateStatus('ticket-1', { status: SupportTicketStatus.CLOSED }, customer),
    ).rejects.toThrow(ForbiddenException);
  });
});
