import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsPositiveMoney, ToMoneyString } from '../../products/dto/money.validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

export class BundleComponentDto {
  @IsUUID('4')
  productVariantId!: string;

  @IsInt()
  @Min(1)
  @Max(20)
  quantity!: number;
}

/** Gift box (SDS §1.2 "Product Flexibility"). */
export class CreateBundleDto {
  @trim()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @trim()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  description!: string;

  @ToMoneyString()
  @IsPositiveMoney()
  price!: string;

  /**
   * Shipped weight of the boxed set in grams (jars plus packaging). Defaults
   * to the sum of the component weights when omitted.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  totalWeightG?: number;

  /** Admin only. */
  @IsOptional()
  @IsUUID('4')
  sellerId?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'A bundle needs at least one component' })
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => BundleComponentDto)
  items!: BundleComponentDto[];
}

/** Every field optional; `items` replaces the whole component list. */
export class UpdateBundleDto {
  @IsOptional()
  @trim()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @trim()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @ToMoneyString()
  @IsPositiveMoney()
  price?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  totalWeightG?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'A bundle needs at least one component' })
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => BundleComponentDto)
  items?: BundleComponentDto[];
}

export class ListBundlesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  pageSize: number = 24;
}

export class ListAdminBundlesQueryDto extends ListBundlesQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  includeInactive?: boolean;
}
