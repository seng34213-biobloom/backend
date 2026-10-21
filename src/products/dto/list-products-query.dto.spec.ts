import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListProductsQueryDto } from './list-products-query.dto';

const parse = (query: Record<string, string>) => {
  const dto = plainToInstance(ListProductsQueryDto, query);
  return { dto, errors: validateSync(dto) };
};

describe('ListProductsQueryDto', () => {
  it('defaults to page 1 and a page size of 24', () => {
    const { dto, errors } = parse({});
    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({ page: 1, pageSize: 24 });
  });

  it('converts paging values to numbers and trims text filters', () => {
    const { dto, errors } = parse({
      page: '2',
      pageSize: '60',
      search: '  jam ',
      category: ' jams',
    });
    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({ page: 2, pageSize: 60, search: 'jam', category: 'jams' });
  });

  it.each([
    [{ pageSize: '500' }, 'pageSize'],
    [{ pageSize: '0' }, 'pageSize'],
    [{ page: '0' }, 'page'],
    [{ page: 'abc' }, 'page'],
    [{ search: 'x'.repeat(121) }, 'search'],
  ])('rejects %j', (query, property) => {
    const { errors } = parse(query);
    expect(errors.map((e) => e.property)).toContain(property);
  });
});
