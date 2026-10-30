import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { DiscountType } from '@prisma/client';

export class CreatePromoCodeDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,32}$/, { message: 'code must be 3-32 letters, digits, - or _' })
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsEnum(DiscountType)
  discountType!: DiscountType;

  /** Percent (PERCENTAGE) or LKR (FIXED), as a decimal string. */
  @IsNumberString()
  discountValue!: string;

  @IsOptional()
  @IsNumberString()
  minOrderLkr?: string;

  @IsDateString()
  validFrom!: string;

  @IsDateString()
  validUntil!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdatePromoCodeDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  @IsOptional()
  @IsNumberString()
  discountValue?: string;

  @IsOptional()
  @IsNumberString()
  minOrderLkr?: string;

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
