import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditActorType,
  DeliveryAssignmentStatus,
  OrderStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatusService } from '../orders/order-status.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AssignDeliveryDto } from './dto/assign-delivery.dto';
import type { RegisterFcmTokenDto } from './dto/fcm-token.dto';
import type { UpdateDeliveryStatusDto } from './dto/update-status.dto';
import type { UploadDeliveryProofDto } from './dto/upload-proof.dto';

const allowedTransitions: Record<DeliveryAssignmentStatus, DeliveryAssignmentStatus[]> = {
  [DeliveryAssignmentStatus.ASSIGNED]: [DeliveryAssignmentStatus.PICKED_UP],
  [DeliveryAssignmentStatus.PICKED_UP]: [DeliveryAssignmentStatus.OUT_FOR_DELIVERY],
  [DeliveryAssignmentStatus.OUT_FOR_DELIVERY]: [
    DeliveryAssignmentStatus.DELIVERED,
    DeliveryAssignmentStatus.FAILED,
  ],
  [DeliveryAssignmentStatus.DELIVERED]: [],
  [DeliveryAssignmentStatus.FAILED]: [],
};

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly orderStatus: OrderStatusService,
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

  listForRider(deliveryUserId: string) {
    return this.prisma.deliveryAssignment.findMany({
      where: { deliveryUserId },
      orderBy: { assignedAt: 'desc' },
      include: {
        order: {
          select: {
            id: true,
            status: true,
            placedAt: true,
            shippingAddress: true,
            customer: { select: { id: true, name: true, phone: true } },
            items: {
              select: {
                quantity: true,
                variant: { select: { name: true, size: true, sku: true } },
              },
            },
          },
        },
      },
    });
  }

  async uploadProof(assignmentId: string, dto: UploadDeliveryProofDto, actor: AuthenticatedUser) {
    const assignment = await this.requireOwnedAssignment(assignmentId, actor.id);
    if (assignment.status !== DeliveryAssignmentStatus.OUT_FOR_DELIVERY) {
      throw new BadRequestException(
        'Proof photo can only be added while the delivery is OUT_FOR_DELIVERY',
      );
    }
    const result = await this.prisma.deliveryAssignment.updateMany({
      where: {
        id: assignmentId,
        deliveryUserId: actor.id,
        status: DeliveryAssignmentStatus.OUT_FOR_DELIVERY,
      },
      data: { proofPhotoUrl: dto.proofPhotoUrl },
    });
    if (result.count !== 1) {
      throw new ConflictException('Delivery assignment changed while proof was being uploaded');
    }
    const updated = await this.prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignmentId },
    });
    await this.recordAssignmentAudit(assignmentId, actor, 'delivery.proof.upload', {
      proofPhotoUrl: dto.proofPhotoUrl,
    });
    return updated;
  }

  async updateStatus(assignmentId: string, dto: UpdateDeliveryStatusDto, actor: AuthenticatedUser) {
    const assignment = await this.requireOwnedAssignment(assignmentId, actor.id);
    if (!allowedTransitions[assignment.status].includes(dto.status)) {
      throw new BadRequestException(
        `Illegal delivery transition: ${assignment.status} → ${dto.status}`,
      );
    }
    if (dto.status === DeliveryAssignmentStatus.DELIVERED) {
      if (!assignment.proofPhotoUrl) {
        throw new BadRequestException('A proof photo is required before delivery can be completed');
      }
      if (dto.latitude === undefined || dto.longitude === undefined) {
        throw new BadRequestException('GPS coordinates are required when completing delivery');
      }
      this.orderStatus.assertTransition(assignment.order.status, OrderStatus.DELIVERED);
    }
    if (dto.status === DeliveryAssignmentStatus.FAILED && !dto.failureReason?.trim()) {
      throw new BadRequestException('A failure reason is required for a failed delivery');
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.deliveryAssignment.updateMany({
        where: {
          id: assignmentId,
          deliveryUserId: actor.id,
          status: assignment.status,
        },
        data: {
          status: dto.status,
          ...(dto.status === DeliveryAssignmentStatus.PICKED_UP ? { pickedUpAt: now } : {}),
          ...(dto.status === DeliveryAssignmentStatus.DELIVERED
            ? { deliveredAt: now, latitude: dto.latitude, longitude: dto.longitude }
            : {}),
          ...(dto.status === DeliveryAssignmentStatus.FAILED
            ? { failedAt: now, failureReason: dto.failureReason?.trim() }
            : {}),
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('Delivery assignment changed; refresh and retry');
      }

      if (dto.status === DeliveryAssignmentStatus.DELIVERED) {
        this.orderStatus.assertTransition(assignment.order.status, OrderStatus.DELIVERED);
        const orderUpdate = await tx.order.updateMany({
          where: { id: assignment.order.id, status: OrderStatus.SHIPPED },
          data: { status: OrderStatus.DELIVERED, deliveredAt: now },
        });
        if (orderUpdate.count !== 1) {
          throw new BadRequestException('Illegal delivery transition: order is no longer SHIPPED');
        }
      }

      return tx.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
    });

    await this.recordAssignmentAudit(
      assignmentId,
      actor,
      `delivery.status.${dto.status.toLowerCase()}`,
      {
        from: assignment.status,
        to: dto.status,
        ...(dto.status === DeliveryAssignmentStatus.DELIVERED
          ? { latitude: dto.latitude, longitude: dto.longitude }
          : {}),
        ...(dto.status === DeliveryAssignmentStatus.FAILED
          ? { failureReason: dto.failureReason?.trim() }
          : {}),
      },
    );
    if (dto.status === DeliveryAssignmentStatus.DELIVERED) {
      await this.audit.record({
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        action: 'order.delivered',
        targetType: 'Order',
        targetId: assignment.order.id,
        metadata: {
          from: OrderStatus.SHIPPED,
          to: OrderStatus.DELIVERED,
          actorId: actor.id,
          actorRole: Role.DELIVERY,
          deliveryAssignmentId: assignmentId,
        },
      });
      this.notifications.emitOrderDelivered({
        orderId: assignment.order.id,
        actorId: actor.id,
      });
    }
    return updated;
  }

  async registerFcmToken(dto: RegisterFcmTokenDto, actor: AuthenticatedUser) {
    const result = await this.prisma.deliveryUser.updateMany({
      where: { id: actor.id, active: true },
      data: { fcmToken: dto.token },
    });
    if (result.count !== 1) {
      throw new NotFoundException(`Active delivery rider ${actor.id} not found`);
    }
    return { registered: true };
  }

  private async requireOwnedAssignment(assignmentId: string, deliveryUserId: string) {
    const assignment = await this.prisma.deliveryAssignment.findUnique({
      where: { id: assignmentId },
      include: { order: { select: { id: true, status: true } } },
    });
    if (!assignment) throw new NotFoundException(`Delivery assignment ${assignmentId} not found`);
    if (assignment.deliveryUserId !== deliveryUserId) {
      throw new ForbiddenException('This delivery assignment belongs to another rider');
    }
    return assignment;
  }

  private recordAssignmentAudit(
    assignmentId: string,
    actor: AuthenticatedUser,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.record({
      actorType: AuditActorType.SYSTEM,
      actorId: null,
      action,
      targetType: 'DeliveryAssignment',
      targetId: assignmentId,
      metadata: { deliveryUserId: actor.id, ...metadata },
    });
  }
}
