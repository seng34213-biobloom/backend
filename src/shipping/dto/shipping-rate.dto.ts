import {
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateShippingRateDto {
  @IsInt()
  @Min(0)
  minWeightG!: number;

  @IsInt()
  @Min(1)
  maxWeightG!: number;

  @IsNumberString()
  feeLkr!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label!: string;
}

export class UpdateShippingRateDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  minWeightG?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxWeightG?: number;

  @IsOptional()
  @IsNumberString()
  feeLkr?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label?: string;
}
