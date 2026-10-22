import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PaymentGateway, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface PaymentIntent {
  gateway: PaymentGateway;
  gatewayPaymentId: string;
  clientSecret: string;
  amount: string;
  currency: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createIntent(input: {
    orderId: string;
    amount: string;
    currency: string;
    gateway: PaymentGateway;
  }): Promise<PaymentIntent> {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 24);
    const gatewayPaymentId =
      input.gateway === PaymentGateway.STRIPE ? `pi_test_${suffix}` : `payhere_test_${suffix}`;
    const clientSecret = `${gatewayPaymentId}_secret_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    await this.prisma.payment.create({
      data: {
        orderId: input.orderId,
        gateway: input.gateway,
        gatewayPaymentId,
        amount: input.amount,
        currency: input.currency,
        status: PaymentStatus.PENDING,
      },
    });
    this.logger.log(`Payment intent ${gatewayPaymentId} created for order=${input.orderId}`);
    return {
      gateway: input.gateway,
      gatewayPaymentId,
      clientSecret,
      amount: input.amount,
      currency: input.currency,
    };
  }
}
