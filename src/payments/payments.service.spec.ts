import { PaymentGateway, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from './payments.service';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(() => {
    prisma = {
      payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
    } as unknown as jest.Mocked<PrismaService>;
    service = new PaymentsService(prisma);
  });

  it('creates a pending gateway intent and persists its order payment record', async () => {
    const intent = await service.createIntent({
      orderId: 'order-1',
      amount: '1500.00',
      currency: 'LKR',
      gateway: PaymentGateway.STRIPE,
    });

    expect(intent).toMatchObject({
      gateway: PaymentGateway.STRIPE,
      amount: '1500.00',
      currency: 'LKR',
    });
    expect(intent.gatewayPaymentId).toMatch(/^pi_test_[a-f0-9]{24}$/);
    expect(intent.clientSecret).toContain(`${intent.gatewayPaymentId}_secret_`);
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: {
        orderId: 'order-1',
        gateway: PaymentGateway.STRIPE,
        gatewayPaymentId: intent.gatewayPaymentId,
        amount: '1500.00',
        currency: 'LKR',
        status: PaymentStatus.PENDING,
      },
    });
  });

  it('uses the PayHere intent identifier format', async () => {
    const intent = await service.createIntent({
      orderId: 'order-2',
      amount: '100.00',
      currency: 'LKR',
      gateway: PaymentGateway.PAYHERE,
    });
    expect(intent.gatewayPaymentId).toMatch(/^payhere_test_[a-f0-9]{24}$/);
  });
});
