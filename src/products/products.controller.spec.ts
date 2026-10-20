import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

describe('ProductsController', () => {
  const service = {
    list: jest.fn().mockResolvedValue({ items: [], page: 1, pageSize: 24, total: 0 }),
    getBySlug: jest.fn().mockResolvedValue({ slug: 'wild-honey' }),
  } as unknown as jest.Mocked<ProductsService>;
  const controller = new ProductsController(service);

  it('passes the query to ProductsService.list', async () => {
    const query = { search: 'jam', page: 2, pageSize: 12 };
    await expect(controller.list(query)).resolves.toMatchObject({ total: 0 });
    expect(service.list).toHaveBeenCalledWith(query);
  });

  it('looks a product up by slug', async () => {
    await expect(controller.detail('wild-honey')).resolves.toEqual({ slug: 'wild-honey' });
    expect(service.getBySlug).toHaveBeenCalledWith('wild-honey');
  });
});
