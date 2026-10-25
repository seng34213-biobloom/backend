import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, Role, SupportTicketStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateTicketDto } from './dto/create-ticket.dto';
import type { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(customerId: string, dto: CreateTicketDto) {
    const ticket = await this.prisma.supportTicket.create({
      data: {
        customerId,
        subject: dto.subject.trim(),
        message: dto.message.trim(),
      },
    });
    await this.audit.record({
      actorType: AuditActorType.CUSTOMER,
      actorId: null,
      action: 'support.ticket.create',
      targetType: 'SupportTicket',
      targetId: ticket.id,
      metadata: { customerId },
    });
    return ticket;
  }

  listForCustomer(customerId: string) {
    return this.prisma.supportTicket.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getForCustomer(ticketId: string, customerId: string) {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.customerId !== customerId) throw new ForbiddenException('Not your support ticket');
    return ticket;
  }

  async reopen(ticketId: string, customerId: string) {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.customerId !== customerId) throw new ForbiddenException('Not your support ticket');
    if (ticket.status === SupportTicketStatus.CLOSED) {
      throw new BadRequestException('A closed support ticket cannot be reopened');
    }
    if (ticket.status !== SupportTicketStatus.RESOLVED) {
      throw new BadRequestException('Only resolved support tickets can be reopened');
    }

    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: SupportTicketStatus.OPEN, resolvedAt: null },
    });
    await this.audit.record({
      actorType: AuditActorType.CUSTOMER,
      actorId: null,
      action: 'support.ticket.reopen',
      targetType: 'SupportTicket',
      targetId: ticketId,
      metadata: { customerId, from: ticket.status, to: SupportTicketStatus.OPEN },
    });
    return updated;
  }

  listForAdmin(status?: SupportTicketStatus) {
    return this.prisma.supportTicket.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'asc' },
      include: { customer: { select: { id: true, name: true, email: true } } },
    });
  }

  async updateStatus(ticketId: string, dto: UpdateTicketStatusDto, actor: AuthenticatedUser) {
    if (actor.role !== Role.ADMIN) throw new ForbiddenException('Only ADMIN can manage tickets');
    const ticket = await this.requireTicket(ticketId);
    if (ticket.status === SupportTicketStatus.CLOSED && dto.status !== SupportTicketStatus.CLOSED) {
      throw new BadRequestException('A closed support ticket cannot be reopened');
    }

    const now = new Date();
    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: dto.status,
        resolvedAt:
          dto.status === SupportTicketStatus.RESOLVED
            ? now
            : dto.status === SupportTicketStatus.OPEN
              ? null
              : ticket.resolvedAt,
        closedAt:
          dto.status === SupportTicketStatus.CLOSED
            ? now
            : dto.status === SupportTicketStatus.OPEN
              ? null
              : ticket.closedAt,
      },
    });
    await this.audit.record({
      actorType: AuditActorType.ADMIN,
      actorId: actor.id,
      action: 'support.ticket.status',
      targetType: 'SupportTicket',
      targetId: ticketId,
      metadata: { from: ticket.status, to: dto.status },
    });
    return updated;
  }

  private async requireTicket(ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException(`Support ticket ${ticketId} not found`);
    return ticket;
  }
}
