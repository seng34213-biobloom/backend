import { PaymentGateway } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

describe('SubscriptionsController', () => {
  const service = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 's-1' }),
    pause: jest.fn().mockResolvedValue({ id: 's-1' }),
    resume: jest.fn().mockResolvedValue({ id: 's-1' }),
    cancel: jest.fn().mockResolvedValue({ id: 's-1' }),
    skipNext: jest.fn().mockResolvedValue({ id: 's-1' }),
  } as unknown as jest.Mocked<SubscriptionsService>;
  const controller = new SubscriptionsController(service);
  const user = { id: 'cust-1', role: 'CUSTOMER' } as AuthenticatedUser;

  it('scopes every call to the signed-in customer', async () => {
    const dto = {
      productVariantId: 'v-1',
      shippingAddressId: 'addr-1',
      frequencyDays: 30,
      quantity: 2,
      paymentToken: 'pm_test_123',
      paymentGateway: PaymentGateway.STRIPE,
    };

    await controller.list(user);
    await controller.create(dto, user);
    await controller.pause('s-1', user);
    await controller.resume('s-1', user);
    await controller.cancel('s-1', user);
    await controller.skipNext('s-1', user);

    expect(service.list).toHaveBeenCalledWith('cust-1');
    expect(service.create).toHaveBeenCalledWith('cust-1', dto);
    for (const action of ['pause', 'resume', 'cancel', 'skipNext'] as const) {
      expect(service[action]).toHaveBeenCalledWith('cust-1', 's-1');
    }
  });
});
