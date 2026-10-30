import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingCronService } from './billing-cron.service';
import { SubscriptionsAdminController } from './subscriptions-admin.controller';
import { SubscriptionsAdminService } from './subscriptions-admin.service';

describe('SubscriptionsAdminController', () => {
  const run = { due: 200, renewed: 200, outOfStock: 0, chargeFailed: 0, errored: 0 };
  let billing: { runBilling: jest.Mock };

  const controller = (nodeEnv: string) =>
    new SubscriptionsAdminController(
      {} as SubscriptionsAdminService,
      billing as unknown as BillingCronService,
      { get: jest.fn(() => nodeEnv) } as unknown as ConfigService,
    );

  beforeEach(() => {
    billing = { runBilling: jest.fn().mockResolvedValue(run) };
  });

  it('runs one billing pass and reports its counts and duration', async () => {
    const result = await controller('development').runBilling();

    expect(billing.runBilling).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ...run, durationMs: expect.any(Number) });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('is not available in production builds', async () => {
    await expect(controller('production').runBilling()).rejects.toBeInstanceOf(NotFoundException);
    expect(billing.runBilling).not.toHaveBeenCalled();
  });
});
