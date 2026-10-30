import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateVariantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Transform(({ value }: { value: string }) => value?.trim())
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Transform(({ value }: { value: string }) => value?.trim())
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Transform(({ value }: { value: string }) => value?.trim())
  size!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  price!: number;

  // The admin console sends unitWeightG instead
  @ValidateIf((dto: CreateVariantDto) => dto.unitWeightG === undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(1)
  unitWeightGrams!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  unitWeightG?: number;
}
