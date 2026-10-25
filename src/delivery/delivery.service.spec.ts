import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, DeliveryAssignmentStatus, OrderStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatusService } from '../orders/order-status.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeliveryService } from './delivery.service';

describe('DeliveryService', () => {
  let service: DeliveryService;
  let prisma: jest.Mocked<PrismaService>;
  let audit: jest.Mocked<Pick<AuditService, 'record'>>;
  let notifications: jest.Mocked<
    Pick<NotificationsService, 'emitDeliveryAssigned' | 'emitOrderDelivered'>
  >;
  let orderStatus: jest.Mocked<Pick<OrderStatusService, 'assertTransition'>>;

  const admin: AuthenticatedUser = {
    id: 'admin-1',
    email: 'admin@example.com',
    role: 'ADMIN',
    actorType: 'admin',
    jti: 'jti',
    expiresAt: 0,
  };
  const rider: AuthenticatedUser = {
    id: 'rider-1',
    email: 'rider@example.com',
    role: 'DELIVERY',
    actorType: 'delivery',
    jti: 'jti',
    expiresAt: 0,
  };
  const assignment = {
    id: 'assignment-1',
    orderId: 'order-1',
    deliveryUserId: 'rider-1',
    status: DeliveryAssignmentStatus.ASSIGNED,
    proofPhotoUrl: null,
    order: { id: 'order-1', status: OrderStatus.SHIPPED },
  };
  let tx: {
    deliveryAssignment: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    order: { updateMany: jest.Mock };
  };

  beforeEach(() => {
    tx = {
      deliveryAssignment: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          ...assignment,
          status: DeliveryAssignmentStatus.DELIVERED,
        }),
      },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({ id: 'order-1', status: OrderStatus.SHIPPED }),
      },
      deliveryUser: {
        findUnique: jest.fn().mockResolvedValue({ id: 'rider-1', active: true }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      deliveryAssignment: {
        findUnique: jest.fn().mockResolvedValue(assignment),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          ...assignment,
          proofPhotoUrl: 'https://proof.example/photo.jpg',
        }),
        findMany: jest.fn().mockResolvedValue([assignment]),
        create: jest.fn().mockResolvedValue({ ...assignment, deliveryUser: { id: 'rider-1' } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((callback: (transaction: unknown) => unknown) => callback(tx)),
    } as unknown as jest.Mocked<PrismaService>;
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    notifications = {
      emitDeliveryAssigned: jest.fn(),
      emitOrderDelivered: jest.fn(),
    };
    orderStatus = { assertTransition: jest.fn() };
    service = new DeliveryService(
      prisma,
      audit as unknown as AuditService,
      notifications as unknown as NotificationsService,
      orderStatus as unknown as OrderStatusService,
    );
  });

  it('assigns a shipped order to an active rider, audits it, and emits an event', async () => {
    (prisma.deliveryAssignment.findUnique as jest.Mock).mockResolvedValue(null);

    await service.assign({ orderId: 'order-1', deliveryUserId: 'rider-1' }, admin);

    expect(prisma.deliveryAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { orderId: 'order-1', deliveryUserId: 'rider-1' },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'delivery.assign', actorType: AuditActorType.ADMIN }),
    );
    expect(notifications.emitDeliveryAssigned).toHaveBeenCalledWith({
      assignmentId: 'assignment-1',
      orderId: 'order-1',
      deliveryUserId: 'rider-1',
    });
  });

  it('rejects assignment for a non-shipped order', async () => {
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'order-1',
      status: OrderStatus.PAID,
    });

    await expect(
      service.assign({ orderId: 'order-1', deliveryUserId: 'rider-1' }, admin),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns 404 for an unknown order or inactive rider', async () => {
    (prisma.order.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(
      service.assign({ orderId: 'missing', deliveryUserId: 'rider-1' }, admin),
    ).rejects.toThrow(NotFoundException);

    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'order-1',
      status: OrderStatus.SHIPPED,
    });
    (prisma.deliveryUser.findUnique as jest.Mock).mockResolvedValue({
      id: 'rider-1',
      active: false,
    });
    await expect(
      service.assign({ orderId: 'order-1', deliveryUserId: 'rider-1' }, admin),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects assigning an order more than once', async () => {
    await expect(
      service.assign({ orderId: 'order-1', deliveryUserId: 'rider-1' }, admin),
    ).rejects.toThrow(ConflictException);
  });

  it("prevents riders from accessing another rider's assignment", async () => {
    (prisma.deliveryAssignment.findUnique as jest.Mock).mockResolvedValue({
      ...assignment,
      deliveryUserId: 'rider-2',
    });

    await expect(
      service.updateStatus('assignment-1', { status: DeliveryAssignmentStatus.PICKED_UP }, rider),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects out-of-sequence status updates', async () => {
    await expect(
      service.updateStatus(
        'assignment-1',
        { status: DeliveryAssignmentStatus.OUT_FOR_DELIVERY },
        rider,
      ),
    ).rejects.toThrow('Illegal delivery transition');
  });

  it('requires proof and GPS coordinates before completing delivery', async () => {
    (prisma.deliveryAssignment.findUnique as jest.Mock).mockResolvedValue({
      ...assignment,
      status: DeliveryAssignmentStatus.OUT_FOR_DELIVERY,
    });
    await expect(
      service.updateStatus(
        'assignment-1',
        { status: DeliveryAssignmentStatus.DELIVERED, latitude: 6.9, longitude: 79.8 },
        rider,
      ),
    ).rejects.toThrow('proof photo is required');

    (prisma.deliveryAssignment.findUnique as jest.Mock).mockResolvedValue({
      ...assignment,
      status: DeliveryAssignmentStatus.OUT_FOR_DELIVERY,
      proofPhotoUrl: 'https://proof.example/photo.jpg',
    });
    await expect(
      service.updateStatus('assignment-1', { status: DeliveryAssignmentStatus.DELIVERED }, rider),
    ).rejects.toThrow('GPS coordinates are required');
  });

  it('requires a reason before marking a delivery failed', async () => {
    (prisma.deliveryAssignment.findUnique as jest.Mock).mockResolvedValue({
      ...assignment,
      status: DeliveryAssignmentStatus.OUT_FOR_DELIVERY,
    });

    await expect(
      service.updateStatus('assignment-1', { status: DeliveryAssignmentStatus.FAILED }, rider),
    ).rejects.toThrow('failure reason is required');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('completes delivery atomically, audits both records, and emits notification', async () => {
    (prisma.deliveryAssignment.findUnique as jest.Mock).mockResolvedValue({
      ...assignment,
      status: DeliveryAssignmentStatus.OUT_FOR_DELIVERY,
      proofPhotoUrl: 'https://proof.example/photo.jpg',
    });

    await service.updateStatus(
      'assignment-1',
      {
        status: DeliveryAssignmentStatus.DELIVERED,
        latitude: 6.9,
        longitude: 79.8,
      },
      rider,
    );

    expect(orderStatus.assertTransition).toHaveBeenCalledWith(
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
    );
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1', status: OrderStatus.SHIPPED },
        data: expect.objectContaining({ status: OrderStatus.DELIVERED }),
      }),
    );
    expect(tx.deliveryAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DeliveryAssignmentStatus.DELIVERED,
          latitude: 6.9,
          longitude: 79.8,
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'order.delivered', targetId: 'order-1' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'delivery.status.delivered',
        targetId: 'assignment-1',
        metadata: expect.objectContaining({ latitude: 6.9, longitude: 79.8 }),
      }),
    );
    expect(notifications.emitOrderDelivered).toHaveBeenCalledWith({
      orderId: 'order-1',
      actorId: rider.id,
    });
  });

  it('rejects proof uploads after delivery or failure', async () => {
    for (const status of [DeliveryAssignmentStatus.DELIVERED, DeliveryAssignmentStatus.FAILED]) {
      (prisma.deliveryAssignment.findUnique as jest.Mock).mockResolvedValue({
        ...assignment,
        status,
      });
      await expect(
        service.uploadProof(
          'assignment-1',
          { proofPhotoUrl: 'https://proof.example/photo.jpg' },
          rider,
        ),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('makes failed assignments terminal and prevents reassignment', async () => {
    (prisma.deliveryAssignment.findUnique as jest.Mock).mockResolvedValue({
      ...assignment,
      status: DeliveryAssignmentStatus.FAILED,
    });

    await expect(
      service.updateStatus('assignment-1', { status: DeliveryAssignmentStatus.PICKED_UP }, rider),
    ).rejects.toThrow('Illegal delivery transition');
    await expect(
      service.assign({ orderId: 'order-1', deliveryUserId: 'rider-2' }, admin),
    ).rejects.toThrow(ConflictException);
  });

  it('registers the authenticated rider FCM token without returning it', async () => {
    await expect(service.registerFcmToken({ token: 'fcm-device-token' }, rider)).resolves.toEqual({
      registered: true,
    });
    expect(prisma.deliveryUser.updateMany).toHaveBeenCalledWith({
      where: { id: rider.id, active: true },
      data: { fcmToken: 'fcm-device-token' },
    });
  });

  it('rejects FCM token registration for an inactive rider', async () => {
    (prisma.deliveryUser.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await expect(service.registerFcmToken({ token: 'fcm-device-token' }, rider)).rejects.toThrow(
      NotFoundException,
    );
  });
});
