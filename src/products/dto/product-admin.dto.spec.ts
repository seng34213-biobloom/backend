import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateProductDto } from './create-product.dto';
import { CreateVariantDto } from './create-variant.dto';
import { UpdateProductDto } from './update-product.dto';
import { UpdateVariantDto } from './update-variant.dto';

describe('Product administration DTOs', () => {
  const variant = {
    sku: 'HONEY-250',
    name: 'Wild Honey 250g',
    size: '250 g',
    price: 1500,
    unitWeightGrams: 320,
  };

  const product = {
    name: 'Wild Honey',
    slug: 'wild-honey',
    description: 'Raw forest honey',
    category: 'honey',
    basePrice: 1500,
    unitWeightGrams: 320,
    variants: [variant],
  };

  it('accepts a product with a valid variant and transforms numeric input', () => {
    const dto = plainToInstance(CreateProductDto, {
      ...product,
      basePrice: '1500.00',
      variants: [{ ...variant, price: '1500' }],
    });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.basePrice).toBe(1500);
    expect(dto.variants[0].price).toBe(1500);
  });

  it.each([
    ['zero product weight', { unitWeightGrams: 0 }],
    ['negative product price', { basePrice: -1 }],
    ['invalid slug', { slug: 'Wild Honey' }],
    ['missing variants', { variants: [] }],
    ['zero variant price', { variants: [{ ...variant, price: 0 }] }],
    ['negative variant weight', { variants: [{ ...variant, unitWeightGrams: -1 }] }],
  ])('rejects %s', (_label, overrides) => {
    const dto = plainToInstance(CreateProductDto, { ...product, ...overrides });

    expect(validateSync(dto).length).toBeGreaterThan(0);
  });

  it('rejects non-positive values when updating product or variant fields', () => {
    const productDto = plainToInstance(UpdateProductDto, { basePrice: 0 });
    const variantDto = plainToInstance(UpdateVariantDto, { unitWeightGrams: 0 });

    expect(validateSync(productDto).length).toBeGreaterThan(0);
    expect(validateSync(variantDto).length).toBeGreaterThan(0);
  });

  it('validates standalone variant creation constraints', () => {
    const dto = plainToInstance(CreateVariantDto, { ...variant, price: 0 });

    expect(validateSync(dto).length).toBeGreaterThan(0);
  });
});
