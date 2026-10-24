import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, OrderStatus, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AssignDeliveryDto } from './dto/assign-delivery.dto';

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async assign(dto: AssignDeliveryDto, actor: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException(`Order ${dto.orderId} not found`);
    if (order.status !== OrderStatus.SHIPPED) {
      throw new BadRequestException(
        `Order must be SHIPPED before delivery assignment (status: ${order.status})`,
      );
    }

    const rider = await this.prisma.deliveryUser.findUnique({
      where: { id: dto.deliveryUserId },
      select: { id: true, active: true },
    });
    if (!rider || !rider.active) {
      throw new NotFoundException(`Active delivery rider ${dto.deliveryUserId} not found`);
    }

    const existing = await this.prisma.deliveryAssignment.findUnique({
      where: { orderId: dto.orderId },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Order already has a delivery assignment');

    let assignment;
    try {
      assignment = await this.prisma.deliveryAssignment.create({
        data: { orderId: dto.orderId, deliveryUserId: rider.id },
        include: { deliveryUser: { select: { id: true, name: true, phone: true } } },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Order already has a delivery assignment');
      }
      throw error;
    }

    await this.audit.record({
      actorType: AuditActorType.ADMIN,
      actorId: actor.id,
      action: 'delivery.assign',
      targetType: 'DeliveryAssignment',
      targetId: assignment.id,
      metadata: { orderId: order.id, deliveryUserId: rider.id },
    });
    this.notifications.emitDeliveryAssigned({
      assignmentId: assignment.id,
      orderId: order.id,
      deliveryUserId: rider.id,
    });
    return assignment;
  }
}
