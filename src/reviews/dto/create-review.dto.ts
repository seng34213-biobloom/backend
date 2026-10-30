import { Transform, Type } from 'class-transformer';
import { IsInt, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateReviewDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  comment!: string;
}

/** `POST /api/reviews` carries the product in the body. */
export class SubmitReviewDto extends CreateReviewDto {
  @IsUUID('4')
  productId!: string;
}
