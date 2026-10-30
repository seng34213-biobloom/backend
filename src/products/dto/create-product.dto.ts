import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CreateVariantDto } from './create-variant.dto';

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }: { value: string }) => value?.trim())
  name!: string;

  // Generated from the name when omitted
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  slug?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  @Transform(({ value }: { value: string }) => value?.trim())
  description!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Transform(({ value }: { value: string }) => value?.trim())
  category!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  basePrice!: number;

  // The admin console sends unitWeightG instead
  @ValidateIf((dto: CreateProductDto) => dto.unitWeightG === undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(1)
  unitWeightGrams!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  unitWeightG?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  ingredients?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  allergens?: string | null;

  // Admin only; sellers always own what they create
  @IsOptional()
  @IsUUID('4')
  sellerId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants!: CreateVariantDto[];
}
