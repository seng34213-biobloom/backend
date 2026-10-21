import type { AuthenticatedUser } from '../auth/types/auth.types';
import { BatchesController } from './batches.controller';
import { BatchesService } from './batches.service';

describe('BatchesController', () => {
  const service = {
    listForProduct: jest.fn().mockResolvedValue([]),
    createForVariant: jest.fn().mockResolvedValue({ id: 'b-1' }),
  } as unknown as jest.Mocked<BatchesService>;
  const controller = new BatchesController(service);
  const user = { id: 'admin-1', role: 'ADMIN' } as AuthenticatedUser;

  it('passes the product, variant and acting user to BatchesService', async () => {
    const dto = {
      batchNumber: 'B-1',
      manufacturedDate: '2026-10-01',
      expiryDate: '2027-01-31',
      initialQuantity: 10,
    };

    await controller.list('p-1', user);
    await controller.create('p-1', 'v-1', dto, user);

    expect(service.listForProduct).toHaveBeenCalledWith('p-1', user);
    expect(service.createForVariant).toHaveBeenCalledWith('p-1', 'v-1', dto, user);
  });
});
