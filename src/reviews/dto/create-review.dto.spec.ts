import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateReviewDto } from './create-review.dto';

describe('CreateReviewDto', () => {
  it.each([0, 6, 2.5])('rejects rating %p outside integer range 1-5', async (rating) => {
    const dto = plainToInstance(CreateReviewDto, {
      rating,
      comment: 'A valid review comment',
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain('rating');
  });

  it('accepts a rating from 1 through 5', async () => {
    const dto = plainToInstance(CreateReviewDto, {
      rating: 4,
      comment: 'A valid review comment',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
